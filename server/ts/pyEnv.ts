/**
 * Установка Python-окружения для движков озвучки (F5-TTS / Coqui XTTS v2) —
 * прямо из интерфейса, без консоли.
 *
 * Зачем модуль: torch/torchaudio/f5_tts живут в отдельном интерпретаторе (venv,
 * conda, `py -3.11`), и раньше единственным способом их поставить была строка
 * `pip install ...`, которую пользователь должен был скопировать из подсказки и
 * выполнить руками. Здесь это делается так же, как установка сборок whisper в
 * лекционном диктофоне (server/ts/whisperEngine.ts + server/routes/lecture.js):
 *
 *   • пользователь выбирает устройство — CUDA-сборка torch (индекс cu128) либо
 *     CPU-сборка;
 *   • сервер последовательно запускает pip нужными шагами и пишет прогресс в
 *     общее состояние задачи (server/ts/setupTask.ts), которое опрашивает UI;
 *   • отмена реально убивает процесс pip (на Windows — дерево целиком), иначе
 *     он продолжал бы качать гигабайты в фоне;
 *   • после установки окружение перепроверяется (pythonEnv(true)) — интерфейс
 *     сразу видит, что модули на месте.
 *
 * Здесь же две «гигиенические» операции панели: очистка лога (без неё причина
 * ошибки остаётся на экране навсегда) и удаление сборки torch
 * (`pip uninstall torch torchvision torchaudio` — это и есть те 2.5 ГБ, которые
 * занимает CUDA-сборка).
 *
 * Отдельная история — версия самого Python. Классический Coqui TTS (пакет `TTS`)
 * под Python 3.12+ не ставится ВООБЩЕ: у последнего релиза 0.22.0 в
 * Requires-Python стоит `>=3.9,<3.12`, поэтому на 3.13 pip отвечает
 * «Could not find a version that satisfies the requirement TTS (from versions:
 * none)». Проверено и обратное: на 3.11 классический `TTS` тоже не собирается —
 * он публикуется только исходниками, а его setup.py импортирует numpy, которого
 * нет в build-requires («ModuleNotFoundError: No module named 'numpy'»). Поэтому:
 *   • движок XTTS ставится форком `coqui-tts` — модуль тот же
 *     (`TTS.tts.configs.xtts_config`), но живой, с колёсами под 3.10–3.14 и без
 *     сборки из исходников; классический `TTS` остаётся только для Python < 3.10;
 *   • кнопка «Скачать Python 3.11» ставит портативный Python 3.11.9 внутрь
 *     storage приложения (см. PY_PORTABLE): чистое окружение в папке приложения,
 *     из которого ставятся оба движка (F5-TTS и XTTS), а удаляется он вместе с
 *     папкой.
 *
 * Дополнительно здесь ищутся все интерпретаторы на машине (`py -0p`, PATH,
 * стандартные каталоги). Это заменяет ручной ввод пути в Настройках: пользователь
 * выбирает найденный интерпретатор, и он сохраняется в voice.pythonCmd.
 *
 * TS-исходник, как server/ts/setupTask.ts: компилируется в server/pyEnv.js
 * командой `npm run compile:server`, поэтому `require("../pyEnv")` из
 * routes/tts.js работает без изменений.
 */
import { spawn, type ChildProcess } from "child_process";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";
import config from "./config";
import settings from "./settings";
import logger from "./logger";
import { downloadToFile } from "./download";
import { createSetupTask, type SetupTaskState } from "./setupTask";
import { pythonEnv, detectHardware, type PythonEnv } from "./tts";

/**
 * Окружение для python-процессов (pip, проба, распаковка): UTF-8 вместо
 * кодировки локали Windows. Иначе русский вывод pip превращается в крякозябры в
 * логе панели установки, а пути/сообщения об ошибке нечитаемы. Ту же переменную
 * использует сайдкар озвучки (см. PY_ENV в server/ts/tts.ts).
 */
const PY_ENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

/** Движок синтеза: F5-TTS или Coqui XTTS v2 (см. server/ts/tts.ts). */
export type PyEngineId = "f5" | "xtts";
/**
 * Куда ставим torch:
 *   cuda — CUDA 12.8 (индекс cu128): карты NVIDIA от Turing/7.5 и новее;
 *   cpu  — без видеокарты вовсе.
 *
 * Почему именно 12.8, а не «самый новый» индекс: в индексе cu132 пакета
 * torchaudio НЕТ вообще — pip падает на шаге «torch» с «No matching
 * distribution found for torchaudio». А torchaudio обязателен и XTTS, и F5.
 * cu128 — последний индекс, где есть весь набор torch + torchvision +
 * torchaudio под актуальные Python (2.11.0+cu128, cp313, win_amd64).
 */
export type PyDevice = "cuda" | "cpu";

/** Индекс PyTorch для выбранного устройства. */
const TORCH_INDEX: Record<PyDevice, string> = {
  cuda: "https://download.pytorch.org/whl/cu128",
  cpu: "https://download.pytorch.org/whl/cpu",
};

/** Пакет движка: f5-tts тянет torch сам, но у нас он уже стоит (шаг 1). */
const ENGINE_PKG: Record<PyEngineId, string> = { f5: "f5-tts", xtts: "TTS" };

/**
 * Верхняя граница по transformers — ставится вместе с пакетом движка.
 *
 * Почему это обязательно: в transformers 5.x из `transformers.pytorch_utils`
 * убрали `isin_mps_friendly`, а его импортирует сам пакет TTS
 * (`TTS/tts/layers/tortoise/autoregressive.py`) на уровне модуля — установка
 * «движок + свежайший transformers» заканчивалась тем, что XTTS падал ещё на
 * `import TTS.api`: «cannot import name 'isin_mps_friendly' from
 * 'transformers.pytorch_utils'». Проверено по колёсам на PyPI: последняя ветка 4.x —
 * 4.57.6, и `isin_mps_friendly` в ней есть (coqui-tts требует `transformers>=4.57`,
 * так что граница `>=4.57,<5` разрешается без конфликтов). f5-tts тоже работает
 * через transformers 4.x (его `transformers_stream_generator` написан под 4.x).
 *
 * Пины идут ОДНОЙ командой с пакетом движка: так pip сам опускает уже
 * установленный 5.x до 4.57.6 (то же произойдёт при повторной установке у тех,
 * кому pip успел поставить пятую ветку).
 */
const ENGINE_PIN: Record<PyEngineId, string[]> = {
  f5: ["transformers<5"],
  xtts: ["transformers<5"],
};

/**
 * Требуемые модули по движкам — те же правила, что в server/ts/tts.ts
 * (ENGINE_REQUIRED). Дублируются осознанно: здесь они нужны для интерпретаторов,
 * которых нет в настройках, а тянуть ради этого весь tts.ts нельзя.
 */
const ENGINE_MODULES: Record<PyEngineId, string[]> = {
  f5: ["torch", "torchaudio", "f5_tts"],
  xtts: ["torch", "torchaudio", "TTS"],
};

/** Один шаг установки: id (для UI) и аргументы pip. */
interface PyStep {
  id: string;
  args: string[];
  /** Ориентировочный объём загрузки в МБ — для подписи на карточке устройства. */
  approxMb: number;
}

/** Пакеты torch, которые ставим на шаге «torch» (набор с офсайта PyTorch). */
const TORCH_PKGS = ["torch", "torchvision", "torchaudio"];

/**
 * Пакет движка XTTS по версии Python.
 *
 * Классический `TTS` (coqui-ai) заморожен на 0.22.0: Requires-Python
 * `>=3.9,<3.12`, то есть на Python 3.12+ pip не находит НИ ОДНОЙ версии («from
 * versions: none») — именно это и видно в логе установки. Живой форк
 * `coqui-tts` (idiap) ставится на 3.10–3.14, даёт тот же модуль `TTS` и
 * публикуется колёсами, поэтому он и есть основной вариант; классический `TTS`
 * остаётся только для Python 3.9 и старше, где форк не поддерживается.
 *
 * Версия неизвестна (пустая строка) — считаем её современной (форк): так ведёт
 * себя подсказка для консоли, когда интерпретатор ещё не опрошен.
 */
function enginePkg(engine: PyEngineId, pyVersion = ""): string {
  if (engine !== "xtts") return ENGINE_PKG.f5;
  const minor = /^3\.(\d+)/.exec(pyVersion.trim());
  return minor && Number(minor[1]) < 10 ? ENGINE_PKG.xtts : "coqui-tts";
}

/**
 * Портативный Python 3.11 (embeddable): 11 МБ архива, никакого установщика,
 * никаких записей в реестр и никакого UAC. Нужен потому, что классический
 * Coqui TTS работает только до Python 3.11 включительно.
 *
 * Почему embeddable, а не обычный установщик: он распаковывается ПРЯМО в
 * storage приложения (значит «удалить» = удалить папку), pip добавляется одним
 * скриптом get-pip, а пакеты ставятся в его же Lib\site-packages — то есть без
 * «Defaulting to user installation because normal site-packages is not
 * writeable», из-за которого файлы уезжали в %APPDATA%\Python\Python313.
 */
const PY_PORTABLE = {
  version: "3.11.9",
  zipUrl: "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
  getPipUrl: "https://bootstrap.pypa.io/get-pip.py",
  /** Ориентировочный объём архива — для подписи на кнопке. */
  zipMb: 11,
} as const;

/** Папка портативного Python внутри storage приложения. */
function portableDir(): string {
  return path.join(config.DIRS.storage, "python311");
}

/** Путь к python.exe портативного окружения (сам файл может отсутствовать). */
function portableExe(): string {
  return path.join(portableDir(), "python.exe");
}

/**
 * Шаг пакета движка. У классического `TTS` (Python 3.9 и старше) сборка идёт без
 * изоляции окружения: он публикуется ТОЛЬКО исходниками, а его setup.py
 * импортирует numpy, которого нет в build-requires — pip падал на
 * «ModuleNotFoundError: No module named 'numpy'» ещё до установки. numpy и
 * setuptools уже стоят шагом «torch», поэтому собственной сборке ничего не нужно.
 */
function engineStep(engine: PyEngineId, pyVersion = ""): PyStep {
  const pkg = enginePkg(engine, pyVersion);
  // Пин transformers и, для классического TTS, сборка без изоляции (см. ENGINE_PIN).
  const base = pkg === ENGINE_PKG.xtts ? [pkg, "--no-build-isolation"] : [pkg];
  return {
    id: "engine",
    args: [...base, ...ENGINE_PIN[engine]],
    approxMb: pkg === "f5-tts" ? 120 : 30,
  };
}

/**
 * Шаги установки. Первым всегда идёт torch: если поставить пакет движка первым,
 * pip подтянет torch из PyPI (CUDA-сборку ~2.5 ГБ) даже когда выбрана CPU-сборка.
 */
function installSteps(engine: PyEngineId, device: PyDevice, pyVersion = ""): PyStep[] {
  return [
    {
      id: "torch",
      args: [...TORCH_PKGS, "--index-url", TORCH_INDEX[device]],
      // CUDA-сборка весит ~2.5 ГБ, CPU-сборка заметно легче (~200 МБ).
      approxMb: device === "cpu" ? 200 : 2500,
    },
    engineStep(engine, pyVersion),
    // Расстановка ударений по смыслу (RUAccent) — необязательная часть студии:
    // ставится вместе с движком, чтобы тумблер «Ударения» работал сразу, без
    // отдельной установки. Сам пакет маленький (onnxruntime + razdel, ~60 МБ);
    // словари и нейросети RUAccent качает при первом задании в storage/tts/ruaccent.
    { id: "stress", args: ["ruaccent"], approxMb: 60 },
    // Монитор VRAM (pynvml) осмысленен только с видеокартой NVIDIA.
    ...(device === "cpu" ? [] : [{ id: "monitor", args: ["nvidia-ml-py"], approxMb: 1 }]),
  ];
}

/**
 * Шаги удаления сборки torch. Модели и голосовые профили не трогаем: удаляются
 * только пакеты, которые поставил шаг «torch» (это и есть те гигабайты).
 */
function uninstallSteps(): PyStep[] {
  return [{ id: "uninstall", args: [...TORCH_PKGS], approxMb: 0 }];
}

/** Шаги установки портативного Python 3.11 (скачать → распаковать → pip). */
function portableSteps(): PyStep[] {
  return [
    { id: "python", args: [], approxMb: PY_PORTABLE.zipMb },
    { id: "unzip", args: [], approxMb: 0 },
    { id: "getpip", args: [], approxMb: 2 },
  ];
}

/** Готовая команда pip для ручной установки (показывается в UI как подсказка). */
export function pipCommand(
  engine: PyEngineId,
  device: PyDevice,
  python = "python",
  pyVersion = "",
): string {
  return installSteps(engine, device, pyVersion)
    .map((s) => `${python} -m pip install ${s.args.join(" ")}`)
    .join("\n");
}

/* ------------------------- Задача установки (прогресс в UI) ------------------------- */

/**
 * Одна задача за раз: машина состояния общая с установкой моделей/сборок
 * распознавания (server/ts/setupTask.ts) — иначе прогресс двух установок писался
 * бы в одно место и «дёргал» одну полоску.
 */
const setup = createSetupTask("pyEnv");
const task = setup.state;
const taskSnapshot = (): SetupTaskState => setup.snapshot();

/** Что именно делает текущая задача — от этого зависят подписи и прогресс в UI. */
export type PyWork = "install" | "uninstall" | "python";

/** Хвост вывода pip (последние строки) — UI показывает его вместо «тишины». */
const LOG_LIMIT = 200;
let logLines: string[] = [];
/** Текущий процесс pip: нужен, чтобы отмена реально останавливала загрузку. */
let child: ChildProcess | null = null;
/** Что именно ставится сейчас (попадает в снапшот для UI). */
let currentEngine: PyEngineId = "f5";
let currentDevice: PyDevice = "cpu";
let currentSteps: PyStep[] = [];
let currentStep = "";
let currentPython = "";
/** Режим текущей задачи (установка / удаление пакетов / установка Python). */
let currentMode: PyWork = "install";
/**
 * Версия Python последнего опрошенного интерпретатора. От неё зависит пакет
 * движка XTTS (`coqui-tts` вместо классического `TTS` на 3.12+), а шаги
 * установки обязаны быть известны СИНХРОННО — сразу в ответе на POST /env/install,
 * поэтому версию берём из кэша пробы (его заполняет проверка окружения), а не
 * спрашиваем python ещё раз.
 */
let knownPyVersion = "";

/** Снимок установки для UI (progress/phase/error + шаг и хвост лога). */
export interface PyInstallSnapshot {
  state: SetupTaskState;
  /** Что делает задача: установка пакетов, удаление сборки torch или Python. */
  mode: PyWork;
  engine: PyEngineId;
  device: PyDevice;
  python: string;
  steps: string[];
  step: string;
  log: string[];
}

function snapshot(): PyInstallSnapshot {
  return {
    state: taskSnapshot(),
    mode: currentMode,
    engine: currentEngine,
    device: currentDevice,
    python: currentPython,
    steps: currentSteps.map((s) => s.id),
    step: currentStep,
    log: logLines.slice(-40),
  };
}

/** Строка вывода pip → хвост лога (мусорные строки прогресса отбрасываем). */
function pushLog(line: string): void {
  const s = line.replace(/\s+$/, "");
  if (!s) return;
  // pip рисует прогресс-бар символами ━/█ и служебными строками Progress: — в
  // логе UI они бесполезны и занимают место.
  if (/^[\s━█]+$/.test(s) || /^Progress:/.test(s)) return;
  logLines.push(s.length > 300 ? `${s.slice(0, 300)}…` : s);
  if (logLines.length > LOG_LIMIT) logLines = logLines.slice(-LOG_LIMIT);
}

/** Прогресс текущего шага по его выводу: collect → download → install. */
function stepProgress(line: string, prev: number): number {
  if (/^Successfully installed/i.test(line)) return 1;
  if (/^Installing collected packages/i.test(line)) return Math.max(prev, 0.75);
  if (/^\s*Downloading /i.test(line)) return Math.max(prev, 0.5);
  if (/^Collecting /i.test(line)) return Math.max(prev, 0.3);
  return prev;
}

/**
 * Прогресс шага удаления: у `pip uninstall` свои строки — «Found existing
 * installation» (нашёл), «Uninstalling …» (стирает файлы) и итоговое
 * «Successfully uninstalled». Без этих шаблонов полоска стояла бы на нуле всю
 * недолгую, но не мгновенную (2.5 ГБ) процедуру.
 */
function uninstallProgress(line: string, prev: number): number {
  if (/^Successfully uninstalled/i.test(line)) return 1;
  if (/^Uninstalling /i.test(line)) return Math.max(prev, 0.7);
  if (/^Found existing installation/i.test(line)) return Math.max(prev, 0.4);
  return prev;
}

/** Прогресс текущего шага: установка и удаление читают вывод по-разному. */
function progressOf(line: string, prev: number): number {
  return currentMode === "uninstall" ? uninstallProgress(line, prev) : stepProgress(line, prev);
}

/** Процент всей задачи: пройденные шаги + доля текущего. */
function setStepProgress(index: number, fraction: number): void {
  const total = Math.max(1, currentSteps.length);
  const value = Math.round((100 * (index + Math.min(1, Math.max(0, fraction)))) / total);
  // Прогресс ведём монотонно: pip печатает «Collecting» и после «Installing», и
  // полоска не должна откатываться назад.
  task.progress = Math.max(task.progress, Math.min(99, value));
}

/** Запуск pip: строки вывода → лог + прогресс, промис — на код возврата. */
function runPip(python: string, step: PyStep, stepIndex: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const verb = currentMode === "uninstall" ? ["uninstall", "-y"] : ["install", "--upgrade"];
    const args = [
      "-m",
      "pip",
      ...verb,
      "--disable-pip-version-check",
      "--no-input",
      // У uninstall нет прогресс-бара, и флаг ему незнаком — не передаём.
      ...(currentMode === "uninstall" ? [] : ["--progress-bar", "off"]),
      ...step.args,
    ];
    child = spawn(python, args, { windowsHide: true, env: PY_ENV });
    let tail = "";
    let fraction = 0;
    const onData = (d: Buffer): void => {
      tail += String(d);
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const line of lines) {
        pushLog(line);
        fraction = progressOf(line, fraction);
        setStepProgress(stepIndex, fraction);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      child = null;
      reject(new Error(`pip_spawn_failed: ${String((e as Error).message || e)}`));
    });
    child.on("close", (code) => {
      if (tail) pushLog(tail);
      child = null;
      resolve(code ?? 0);
    });
  });
}

/* ------------------------- Установка ------------------------- */

/** Интерпретатор для установки: явный → из настроек → `python` из PATH. */
function pythonFor(python?: string): string {
  return String(python || settings.get("voice")?.pythonCmd || "python").trim() || "python";
}

/** Начать задачу: сброс состояния, чистый лог, известные сразу же шаги. */
function startTask(mode: PyWork, py: string, steps: PyStep[], id: string): void {
  currentMode = mode;
  currentSteps = steps;
  currentStep = steps[0]?.id || "";
  currentPython = py;
  logLines = [];
  setup.reset("pyenv", id);
  task.phase = currentStep;
}

/** Ошибка задачи: причина остаётся в логе (рядом с выводом pip) и в state.error. */
function failTask(e: unknown, context: string): void {
  pushLog(`! ${context}: ${String((e as Error)?.message || e)}`);
  setup.fail(e);
}

/**
 * Перепроверка окружения минуя кэш: заодно запоминаем версию интерпретатора —
 * от неё зависит пакет движка XTTS (см. enginePkg).
 */
async function refreshEnv(): Promise<void> {
  const env = await pythonEnv(true).catch(() => null);
  if (env?.python) knownPyVersion = env.python;
}

/**
 * Общий прогон шагов pip: лог, прогресс, проверка кода возврата и отмены.
 * Установка и удаление отличаются только глаголом (см. runPip), поэтому цикл
 * живёт в одном месте: иначе «Удалить сборку» разошлось бы с «Установить» в
 * обработке отмены и ошибок.
 */
async function runSteps(py: string, steps: PyStep[]): Promise<void> {
  let index = 0;
  for (const step of steps) {
    if (setup.shouldCancel()) throw new Error("cancelled");
    currentStep = step.id;
    task.phase = step.id;
    const verb = currentMode === "uninstall" ? "uninstall -y" : "install";
    pushLog(`> ${py} -m pip ${verb} ${step.args.join(" ")}`);
    const code = await runPip(py, step, index);
    // Отмену проверяем после каждого шага: pip мог завершиться «успешно»
    // уже после того, как пользователь нажал «Отменить».
    if (setup.shouldCancel()) throw new Error("cancelled");
    if (code !== 0) throw new Error(`pip_failed: ${step.id}`);
    setStepProgress(index, 1);
    index++;
  }
}

/**
 * Запустить установку: pip по шагам, прогресс — в общее состояние задачи.
 * Синхронный возврат (как whisperEngine.installBuild): UI сразу получает
 * снапшот, а дальше опрашивает GET /api/tts/env.
 */
export function install(engine: PyEngineId, device: PyDevice, python?: string): PyInstallSnapshot {
  if (task.state === "working") throw new Error("busy");
  const eng: PyEngineId = engine === "xtts" ? "xtts" : "f5";
  const dev: PyDevice = deviceOf(device);
  const py = pythonFor(python);
  // Пакет XTTS зависит от версии интерпретатора: на Python 3.12+ классический
  // `TTS` не ставится вовсе, вместо него идёт форк `coqui-tts` (см. enginePkg).
  startTask("install", py, installSteps(eng, dev, knownPyVersion), `${eng}:${dev}`);
  currentEngine = eng;
  currentDevice = dev;
  logger.action("pyEnv.install.start", { engine: eng, device: dev, python: py });
  void (async () => {
    try {
      await runSteps(py, currentSteps);
      // Модули ставили ИМЕННО этим интерпретатором — записываем его в настройки,
      // иначе проверка окружения продолжала бы смотреть на другой python и
      // «модулей всё ещё нет».
      const saved = String(settings.get("voice")?.pythonCmd || "").trim();
      if (py !== saved) settings.set({ voice: { pythonCmd: py } });
      // Перепроверка минуя кэш: UI сразу видит, что окружение готово.
      await refreshEnv();
      setup.done();
      logger.action("pyEnv.install.done", { engine: eng, device: dev, python: py });
    } catch (e) {
      failTask(e, "pip install");
      logger.error("pyEnv.install.error", {
        engine: eng,
        device: dev,
        error: String((e as Error)?.message || e),
      });
    } finally {
      child = null;
    }
  })();
  return snapshot();
}

/**
 * Удалить сборку torch: те самые ~2.5 ГБ CUDA-сборки (или ~200 МБ CPU-сборки).
 * Идёт тем же путём, что и установка (шаги, лог, прогресс, отмена), поэтому в UI
 * это вторая кнопка в ряду действий, а не отдельный «механизм».
 */
export function uninstallTorch(device: PyDevice, python?: string): PyInstallSnapshot {
  if (task.state === "working") throw new Error("busy");
  const dev = deviceOf(device);
  const py = pythonFor(python);
  startTask("uninstall", py, uninstallSteps(), `uninstall:${dev}`);
  currentDevice = dev;
  logger.action("pyEnv.uninstall.start", { device: dev, python: py });
  void (async () => {
    try {
      await runSteps(py, currentSteps);
      // Модулей теперь нет: перепроверяем, чтобы UI сразу показал красные бейджи,
      // а не «все на месте» из кэша.
      await refreshEnv();
      setup.done();
      logger.action("pyEnv.uninstall.done", { device: dev, python: py });
    } catch (e) {
      failTask(e, "pip uninstall");
      logger.error("pyEnv.uninstall.error", {
        device: dev,
        error: String((e as Error)?.message || e),
      });
    } finally {
      child = null;
    }
  })();
  return snapshot();
}

/** Отмена установки: флаг в состоянии + реальное убийство процесса pip. */
export function cancel(): PyInstallSnapshot {
  setup.cancel();
  killPip();
  return snapshot();
}

/**
 * Очистить лог задачи. Хвост вывода pip после ошибки должен оставаться на
 * экране (там причина), но когда он уже прочитан — мешает: кнопка чистит его и
 * на работающей задаче тоже (лог начнёт наполняться заново).
 */
export function clearLog(): PyInstallSnapshot {
  logLines = [];
  return snapshot();
}

/* ------------------------- Портативный Python 3.11 ------------------------- */

/** Состояние портативного Python 3.11 (кнопки «Скачать»/«Удалить» в панели). */
export interface PyPortable {
  /** python.exe распакован и готов принимать pip. */
  installed: boolean;
  /** Путь к python.exe (пусто, если не установлен). */
  exe: string;
  /** Версия портативной сборки (её мы и ставим). */
  version: string;
  /** Сколько занимает на диске (вместе с torch и движками) — для кнопки удаления. */
  sizeMb: number;
  /** Объём архива, который надо скачать, — для кнопки скачивания. */
  zipMb: number;
}

/** Занятое папкой место в МБ (для подписи «освободит N ГБ»). */
function dirSizeMb(dir: string): number {
  let bytes = 0;
  const walk = (p: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return; // папки нет или нет прав
    }
    for (const it of items) {
      const full = path.join(p, it.name);
      if (it.isDirectory()) walk(full);
      else if (it.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* файл могли удалить между вызовами */
        }
      }
    }
  };
  walk(dir);
  return Math.round(bytes / 1024 ** 2);
}

/** Что сейчас с портативным Python: стоит ли, где и сколько занимает. */
export function portableInfo(): PyPortable {
  const exe = portableExe();
  const installed = fs.existsSync(exe);
  return {
    installed,
    exe: installed ? exe : "",
    // Версия — та, которую ставим сами (PY_PORTABLE), а не результат пробы:
    // лишний запуск python ради строки в UI не нужен.
    version: installed ? PY_PORTABLE.version : "",
    sizeMb: installed ? dirSizeMb(portableDir()) : 0,
    zipMb: PY_PORTABLE.zipMb,
  };
}

/**
 * Прогнать произвольный python-процесс с выводом в тот же лог и прогресс
 * (нужен для get-pip.py): отмену гасит killPip, как и у pip.
 */
function runScript(
  python: string,
  args: string[],
  stepIndex: number,
  base: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    child = spawn(python, args, { windowsHide: true, env: PY_ENV });
    let tail = "";
    let fraction = 0;
    const onData = (d: Buffer): void => {
      tail += String(d);
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const line of lines) {
        pushLog(line);
        fraction = Math.max(fraction, stepProgress(line, fraction));
        setStepProgress(stepIndex, base + (1 - base) * fraction);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      child = null;
      reject(new Error(`pip_spawn_failed: ${String((e as Error).message || e)}`));
    });
    child.on("close", (code) => {
      if (tail) pushLog(tail);
      child = null;
      resolve(code === 0);
    });
  });
}

/**
 * Поставить портативный Python 3.11 внутрь storage приложения.
 *
 * Зачем: классический Coqui TTS (пакет `TTS`) на Python 3.12+ не ставится вовсе
 * («from versions: none»), а F5-TTS требует Python ≥ 3.10. Портативный 3.11.9
 * закрывает оба движка сразу и не трогает систему: ни установщика, ни реестра,
 * ни UAC — распаковка архива в папку приложения.
 */
export function installPython(): PyInstallSnapshot {
  if (task.state === "working") throw new Error("busy");
  const dir = portableDir();
  const exe = portableExe();
  startTask("python", exe, portableSteps(), "python311");
  currentDevice = "cpu";
  logger.action("pyEnv.python.start", { dir, version: PY_PORTABLE.version });
  void (async () => {
    try {
      // 1. Архив embeddable-сборки: 11 МБ против 26 МБ у обычного установщика.
      const zip = path.join(config.DIRS.tmp, "python-3.11.9-embed-amd64.zip");
      pushLog(`> скачиваем ${PY_PORTABLE.zipUrl}`);
      await downloadToFile(PY_PORTABLE.zipUrl, zip, {
        userAgent: "MoonApp",
        timeoutMs: 15 * 60 * 1000,
        maxBytes: 200 * 1024 * 1024,
        shouldCancel: () => setup.shouldCancel(),
        onProgress: (p) => setStepProgress(0, p.total ? p.received / p.total : 0),
      });
      setStepProgress(0, 1);

      // 2. Распаковка. Папку предварительно чистим: остатки прошлой распаковки
      // (например, прерванного скачивания) оставили бы битый python.exe.
      currentStep = "unzip";
      task.phase = "unzip";
      setStepProgress(1, 0.1);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      new AdmZip(zip).extractAllTo(dir, true);
      // В embeddable-сборке доступ к site-packages закрыт файлом `python311._pth`:
      // без «import site» python не увидит ни pip, ни поставленные пакеты, и
      // установка движков упадёт на «No module named pip».
      const pth = path.join(dir, "python311._pth");
      fs.writeFileSync(
        pth,
        ["python311.zip", ".", "Lib\\site-packages", "import site", ""].join("\r\n"),
        "utf8",
      );
      pushLog(`> распакован в ${dir}`);
      pushLog(`> ${path.basename(pth)}: включены Lib\\site-packages и import site`);
      setStepProgress(1, 1);

      // 3. pip: get-pip.py ставит его в Lib\site-packages ЭТОГО python, поэтому
      // «Defaulting to user installation» (файлы уезжали в %APPDATA%\Python…)
      // здесь невозможен.
      currentStep = "getpip";
      task.phase = "getpip";
      const getPip = path.join(config.DIRS.tmp, "get-pip.py");
      pushLog(`> скачиваем ${PY_PORTABLE.getPipUrl}`);
      await downloadToFile(PY_PORTABLE.getPipUrl, getPip, {
        userAgent: "MoonApp",
        timeoutMs: 5 * 60 * 1000,
        maxBytes: 20 * 1024 * 1024,
        shouldCancel: () => setup.shouldCancel(),
        onProgress: (p) => setStepProgress(2, p.total ? 0.4 * (p.received / p.total) : 0.2),
      });
      const pip = await runScript(
        exe,
        [getPip, "--no-warn-script-location", "--disable-pip-version-check"],
        2,
        0.4,
      );
      if (!pip) throw new Error("getpip_failed");
      // Проверяем pip отдельной командой: если его не видно, шаг «Установить»
      // упал бы уже с «No module named pip», и причина была бы не видна.
      // Таймаут с запасом: первый запуск только что распакованного python.exe
      // притормаживает антивирус (проверка python311.zip).
      const version = await runText(exe, ["-m", "pip", "--version"], 30000);
      if (!/^pip /i.test(version.trim())) throw new Error("getpip_failed");
      pushLog(`> ${version.trim()}`);
      setStepProgress(2, 1);

      // Портативный Python становится текущим интерпретатором: кнопку нажали
      // ровно за этим (модули ставятся именно в выбранный python).
      settings.set({ voice: { pythonCmd: exe } });
      await refreshEnv();
      setup.done();
      logger.action("pyEnv.python.done", { exe });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // downloadToFile обрывает скачивание словом «cancelled» — приводим его к
      // тому же коду, что и у pip, чтобы UI показал «Установка отменена».
      failTask(/cancel/i.test(msg) ? new Error("cancelled") : e, "Python 3.11");
      logger.error("pyEnv.python.error", { error: msg });
    } finally {
      child = null;
    }
  })();
  return snapshot();
}

/**
 * Удалить портативный Python 3.11 вместе со всем, что в него поставлено (torch,
 * движки, их модели) — это самая крупная папка страницы.
 *
 * Если он же был выбран интерпретатором, настройка возвращается на `python` из
 * PATH: иначе проверка окружения продолжала бы искать удалённый файл.
 */
export function removePython(): { ok: boolean; freedMb: number } {
  if (task.state === "working") throw new Error("busy");
  const dir = portableDir();
  const freedMb = fs.existsSync(dir) ? dirSizeMb(dir) : 0;
  const saved = String(settings.get("voice")?.pythonCmd || "")
    .trim()
    .toLowerCase();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.error("pyEnv.python.remove.error", { error: String((e as Error)?.message || e) });
    // Причина в тексте ошибки: чаще всего файл занят запущенным python или
    // открытым окном проводника — по имени файла это видно пользователю.
    throw new Error(`python_remove_failed: ${String((e as Error)?.message || e)}`, { cause: e });
  }
  if (saved && saved.startsWith(dir.toLowerCase()))
    settings.set({ voice: { pythonCmd: "python" } });
  knownPyVersion = "";
  logLines = [];
  logger.action("pyEnv.python.remove", { freedMb });
  // Окружение пересматриваем заново: интерпретатор снова тот, что в PATH.
  void pythonEnv(true);
  return { ok: true, freedMb };
}

/** Отмена: гасим процесс pip целиком (на Windows — вместе с дочерними). */
function killPip(): void {
  const proc = child;
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* процесс мог уже завершиться */
  }
}

/* ------------------------- Поиск интерпретаторов ------------------------- */

/** Найденный интерпретатор: команда запуска + что в нём уже установлено. */
export interface PyInterpreter {
  /** Команда для spawn (путь к python.exe) — сохраняется в voice.pythonCmd. */
  cmd: string;
  /** Доп. аргументы launcher'а (`py -3.11` → ["-3.11"]). */
  args: string[];
  /** Подпись для выпадающего списка. */
  label: string;
  ok: boolean;
  error: string;
  detail: string;
  python: string;
  executable: string;
  modules: Record<string, boolean>;
  missingF5: string[];
  missingXtts: string[];
}

/** Запустить вспомогательную команду и вернуть её stdout (ошибки — пустая строка). */
function runText(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const proc = spawn(cmd, args, { windowsHide: true, env: PY_ENV });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(out);
    }, timeoutMs);
    proc.stdout?.on("data", (d) => {
      out += String(d);
    });
    proc.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve("");
    });
    proc.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Проба одного интерпретатора: версия + установленные модули. */
function probe(cmd: string, args: string[], label: string): Promise<PyInterpreter> {
  const script = path.join(__dirname, "engines", "python_env.py");
  return new Promise<PyInterpreter>((resolve) => {
    const base = (error: string, detail: string): PyInterpreter => ({
      cmd,
      args,
      label,
      ok: false,
      error,
      detail,
      python: "",
      executable: "",
      modules: {},
      missingF5: [...ENGINE_MODULES.f5],
      missingXtts: [...ENGINE_MODULES.xtts],
    });
    let out = "";
    let errTail = "";
    let done = false;
    const proc = spawn(cmd, [...args, script], { windowsHide: true, env: PY_ENV });
    // Проба не грузит модули (find_spec внутри python_env.py), поэтому 20 секунд
    // — с запасом даже на медленный диск.
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(base("probe_failed", "timeout"));
    }, 20000);
    proc.stdout?.on("data", (d) => {
      out += String(d);
    });
    proc.stderr?.on("data", (d) => {
      errTail = (errTail + String(d)).slice(-300);
    });
    proc.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(base("python_not_found", String((e as Error)?.message || e)));
    });
    proc.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let data: {
        python?: unknown;
        executable?: unknown;
        modules?: Record<string, unknown>;
      } | null = null;
      for (const line of out.split(/\r?\n/).reverse()) {
        try {
          data = JSON.parse(line);
          break;
        } catch {
          /* строка не JSON — ищем раньше */
        }
      }
      if (!data) {
        resolve(base("probe_failed", errTail));
        return;
      }
      const modules: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(data.modules || {})) modules[k] = v === true;
      const miss = (names: string[]): string[] => names.filter((m) => !modules[m]);
      resolve({
        cmd,
        args,
        label,
        ok: true,
        error: "",
        detail: "",
        python: String(data.python || ""),
        executable: String(data.executable || cmd),
        modules,
        missingF5: miss(ENGINE_MODULES.f5),
        missingXtts: miss(ENGINE_MODULES.xtts),
      });
    });
  });
}

/**
 * Найти все интерпретаторы на машине и проверить их. Порядок: launcher `py`,
 * PATH, стандартные каталоги, затем текущий из настроек. Дубли (один и тот же
 * python.exe из разных источников) отбрасываются по реальному пути.
 */
export async function interpreters(): Promise<PyInterpreter[]> {
  const raw = [...(await launcherCandidates()), ...(await pathCandidates()), ...dirCandidates()];
  const saved = String(settings.get("voice")?.pythonCmd || "").trim();
  if (saved) raw.unshift({ cmd: saved, args: [] });
  const seen = new Set<string>();
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [];
  for (const c of raw) {
    const key = `${c.cmd}|${c.args.join(" ")}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...c,
      label: path.basename(c.cmd) + (c.args.length ? ` ${c.args.join(" ")}` : ""),
    });
    if (candidates.length >= 8) break; // больше восьми проб пользователь не ждёт
  }
  const result: PyInterpreter[] = [];
  for (const c of candidates) {
    // Пробы последовательные: параллельный запуск десятка python забивает диск и
    // ЦП, а выигрыш во времени невелик.
    const info = await probe(c.cmd, c.args, c.label);
    const exec = (info.executable || info.cmd).toLowerCase();
    if (result.some((r) => (r.executable || r.cmd).toLowerCase() === exec)) continue;
    result.push(info);
  }
  logger.action("pyEnv.interpreters", { found: result.length });
  return result;
}

/* ------------------------- Сводка для UI ------------------------- */

/** План установки для одного устройства: сколько качать и какой командой. */
export interface PyPlan {
  device: PyDevice;
  approxMb: number;
  command: string;
  steps: string[];
}

/** Полное состояние установщика (ответ GET /api/tts/env/install). */
export interface PyInstallState {
  /** Рекомендуемая сборка: есть карта NVIDIA → cuda, иначе cpu. */
  recommended: PyDevice;
  /** Имя видеокарты (пусто, если NVIDIA нет). */
  gpuName: string;
  /** Выбранный вариант (для предзаполнения формы в UI). */
  chosen: PyDevice;
  plans: Record<PyDevice, PyPlan>;
  /** Что с портативным Python 3.11 (кнопки «Скачать»/«Удалить»). */
  portable: PyPortable;
  /** Версия текущего интерпретатора — по ней выбран пакет XTTS в командах. */
  pythonVersion: string;
  install: PyInstallSnapshot;
}

/** Нормализация движка из недоверенного ввода (роут). */
export function engineOf(value: unknown): PyEngineId {
  return value === "xtts" ? "xtts" : "f5";
}

/** Нормализация устройства из недоверенного ввода (роут). */
export function deviceOf(value: unknown): PyDevice {
  return value === "cpu" ? "cpu" : "cuda";
}

/** Имя NVIDIA-карты (для подписи «ставим CUDA-сборку под <модель>»). */
async function gpuName(): Promise<string> {
  try {
    const hw = await detectHardware();
    return hw.gpu?.found ? String(hw.gpu.name || "") : "";
  } catch {
    return "";
  }
}

/** Сводка для UI: план на обе сборки (cuda/cpu) + прогресс текущей установки. */
export async function installState(
  engine: PyEngineId = currentEngine,
  device: PyDevice = currentDevice,
): Promise<PyInstallState> {
  const name = await gpuName();
  // Версия интерпретатора решает, какой пакет получит XTTS: классический `TTS`
  // не ставится на Python 3.12+ (Requires-Python >=3.9,<3.12), вместо него идёт
  // форк `coqui-tts`. Проба кэшируется на 30 секунд (см. tts.ts), поэтому лишних
  // запусков python тут нет — к моменту открытия панели она уже сделана.
  const env = await pythonEnv().catch(() => null);
  if (env?.python) knownPyVersion = env.python;
  const plan = (dev: PyDevice): PyPlan => {
    const steps = installSteps(engine, dev, knownPyVersion);
    return {
      device: dev,
      approxMb: steps.reduce((n, s) => n + s.approxMb, 0),
      command: pipCommand(engine, dev, currentPython || pythonFor(), knownPyVersion),
      steps: steps.map((s) => s.id),
    };
  };
  return {
    // Карта есть — предлагаем CUDA-сборку, иначе CPU. Выбор всё равно за
    // пользователем: на слабой карте CPU иногда быстрее.
    //
    // ВАЖНО про старые карты: сборки cu128 собраны только под sm_75+ (Turing и
    // новее), поэтому на Maxwell/Pascal/Volta (GTX 700/900/1000, TITAN X/V,
    // Quadro P/K, Tesla K/M/P) CUDA-сборка «встанет», но первый же тензор упадёт
    // с «no kernel image is available for execution on the device». Отдельного
    // индекса для них больше нет: в cu132 вообще отсутствует torchaudio — pip
    // падал на шаге «torch» с «No matching distribution found for torchaudio».
    // Такую карту видно в UI по имени (gpuName), и там же можно выбрать CPU-сборку.
    recommended: name ? "cuda" : "cpu",
    gpuName: name,
    chosen: device,
    plans: { cuda: plan("cuda"), cpu: plan("cpu") },
    portable: portableInfo(),
    pythonVersion: knownPyVersion,
    install: snapshot(),
  };
}

export { snapshot as installSnapshot, taskSnapshot, pythonFor };
export type { PythonEnv };

/** Кандидаты от launcher'а `py`: `py -0p` печатает список установленных Python. */
async function launcherCandidates(): Promise<Array<{ cmd: string; args: string[] }>> {
  if (process.platform !== "win32") return [];
  const out = await runText("py", ["-0p"]);
  const list: Array<{ cmd: string; args: string[] }> = [];
  for (const line of out.split(/\r?\n/)) {
    // Формат: " -V:3.13 *        C:\Python313\python.exe" (звёздочка — дефолт).
    const m = /^\s*-V:(\S+)\s*\*?\s*(.+?\.exe)\s*$/i.exec(line);
    if (m) list.push({ cmd: m[2].trim(), args: [] });
  }
  // Сам launcher без аргументов берёт Python по умолчанию.
  if (!list.length) list.push({ cmd: "py", args: [] });
  return list;
}

/** Кандидаты из PATH: `where python` (Windows) / `which python3` (прочие ОС). */
async function pathCandidates(): Promise<Array<{ cmd: string; args: string[] }>> {
  const win = process.platform === "win32";
  const names = win ? ["python", "python3"] : ["python3", "python"];
  const list: Array<{ cmd: string; args: string[] }> = [];
  for (const name of names) {
    const out = win ? await runText("where", [name]) : await runText("which", [name]);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (/\.exe$/i.test(p) || (!win && p.startsWith("/"))) list.push({ cmd: p, args: [] });
    }
  }
  if (!list.length) list.push({ cmd: names[0], args: [] });
  return list;
}

/** Кандидаты из стандартных каталогов установки (без опроса системы). */
function dirCandidates(): Array<{ cmd: string; args: string[] }> {
  const home = os.homedir();
  const dirs =
    process.platform === "win32"
      ? [
          path.join(home, "AppData", "Local", "Programs", "Python"),
          "C:\\",
          "C:\\Program Files",
          path.join(home, "miniconda3"),
          path.join(home, "anaconda3"),
        ]
      : ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")];
  const list: Array<{ cmd: string; args: string[] }> = [];
  const push = (file: string): void => {
    if (fs.existsSync(file)) list.push({ cmd: file, args: [] });
  };
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // каталога нет или нет прав
    }
    for (const name of names) {
      if (/^python(\s?3(\.\d+)?)?(\.exe)?$/i.test(name)) {
        // Прямой python.exe в каталоге установки.
        push(path.join(dir, name));
      } else if (/^python\s?3?\.?\d*$/i.test(name)) {
        // Подкаталог вида "Python313" / "Python 3.13" — внутри python.exe.
        push(path.join(dir, name, "python.exe"));
      }
    }
  }
  return list;
}

/* ------------------------- Поиск интерпретаторов ------------------------- */
