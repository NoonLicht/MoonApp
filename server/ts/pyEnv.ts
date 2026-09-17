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
 * Дополнительно здесь ищутся все интерпретаторы на машине (`py -0p`, PATH,
 * стандартные каталоги). Это заменяет ручной ввод пути в Настройках: пользователь
 * выбирает найденный интерпретатор, и он сохраняется в voice.pythonCmd.
 *
 * TS-исходник, как server/ts/setupTask.ts: компилируется в server/pyEnv.js
 * командой `npm run compile:server`, поэтому `require("../pyEnv")` из
 * routes/tts.js работает без изменений.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import settings from "./settings";
import logger from "./logger";
import { createSetupTask, type SetupTaskState } from "./setupTask";
import { pythonEnv, detectHardware, type PythonEnv } from "./tts";

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
 * Шаги установки. Первым всегда идёт torch: если поставить пакет движка первым,
 * pip подтянет torch из PyPI (CUDA-сборку ~2.5 ГБ) даже когда выбрана CPU-сборка.
 */
function installSteps(engine: PyEngineId, device: PyDevice): PyStep[] {
  return [
    {
      id: "torch",
      args: [...TORCH_PKGS, "--index-url", TORCH_INDEX[device]],
      // CUDA-сборка весит ~2.5 ГБ, CPU-сборка заметно легче (~200 МБ).
      approxMb: device === "cpu" ? 200 : 2500,
    },
    { id: "engine", args: [ENGINE_PKG[engine]], approxMb: engine === "f5" ? 120 : 30 },
    // Монитор VRAM (pynvml) осмысленен только с видеокартой NVIDIA.
    ...(device === "cpu" ? [] : [{ id: "monitor", args: ["nvidia-ml-py"], approxMb: 1 }]),
  ];
}

/** Готовая команда pip для ручной установки (показывается в UI как подсказка). */
export function pipCommand(engine: PyEngineId, device: PyDevice, python = "python"): string {
  return installSteps(engine, device)
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

/** Снимок установки для UI (progress/phase/error + шаг и хвост лога). */
export interface PyInstallSnapshot {
  state: SetupTaskState;
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
    const args = [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "--disable-pip-version-check",
      "--no-input",
      "--progress-bar",
      "off",
      ...step.args,
    ];
    child = spawn(python, args, { windowsHide: true });
    let tail = "";
    let fraction = 0;
    const onData = (d: Buffer): void => {
      tail += String(d);
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const line of lines) {
        pushLog(line);
        fraction = stepProgress(line, fraction);
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
  currentEngine = eng;
  currentDevice = dev;
  currentSteps = installSteps(eng, dev);
  currentStep = currentSteps[0].id;
  currentPython = py;
  logLines = [];
  setup.reset("pyenv", `${eng}:${dev}`);
  task.phase = currentStep;
  logger.action("pyEnv.install.start", { engine: eng, device: dev, python: py });
  (async () => {
    let index = 0;
    try {
      for (const step of currentSteps) {
        if (setup.shouldCancel()) throw new Error("cancelled");
        currentStep = step.id;
        task.phase = step.id;
        pushLog(`> ${py} -m pip install ${step.args.join(" ")}`);
        const code = await runPip(py, step, index);
        // Отмену проверяем после каждого шага: pip мог завершиться «успешно»
        // уже после того, как пользователь нажал «Отменить».
        if (setup.shouldCancel()) throw new Error("cancelled");
        if (code !== 0) throw new Error(`pip_failed: ${step.id}`);
        setStepProgress(index, 1);
        index++;
      }
      // Модули ставили ИМЕННО этим интерпретатором — записываем его в настройки,
      // иначе проверка окружения продолжала бы смотреть на другой python и
      // «модулей всё ещё нет».
      const saved = String(settings.get("voice")?.pythonCmd || "").trim();
      if (py !== saved) settings.set({ voice: { pythonCmd: py } });
      // Перепроверка минуя кэш: UI сразу видит, что окружение готово.
      await pythonEnv(true);
      setup.done();
      logger.action("pyEnv.install.done", { engine: eng, device: dev, python: py });
    } catch (e) {
      setup.fail(e);
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

/** Отмена установки: флаг в состоянии + реальное убийство процесса pip. */
export function cancel(): PyInstallSnapshot {
  setup.cancel();
  killPip();
  return snapshot();
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
    const proc = spawn(cmd, args, { windowsHide: true });
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
    const proc = spawn(cmd, [...args, script], { windowsHide: true });
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
  const plan = (dev: PyDevice): PyPlan => {
    const steps = installSteps(engine, dev);
    return {
      device: dev,
      approxMb: steps.reduce((n, s) => n + s.approxMb, 0),
      command: pipCommand(engine, dev, currentPython || pythonFor()),
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
