/**
 * Аудиокнижный TTS-движок (F5-TTS + Coqui XTTS v2), v2.
 *
 * Архитектура:
 *  - Движки — персистентные python-сайдкары (JSON-lines через stdin/stdout):
 *    server/engines/f5_wrapper.py и server/engines/xtts_wrapper.py.
 *    Модель загружается один раз на задание, чанки приходят по конвейеру —
 *    между чанками strict GC (torch.cuda.empty_cache) в том же процессе.
 *  - Железо: nvidia-smi → имя GPU, total VRAM, used, утилизация (для
 *    VRAM-монитора и «[Optimal for Your PC]» бейджей UI).
 *  - Задание: массив чанков (уже отредактированных в UI) + полный набор
 *    параметров. По чанкам: инференс → FFmpeg-конкатенация с кроссфейдом и
 *    паузами → EBU R128 (−16 LUFS) → mp3/wav/m4b с главами.
 *  - Пресеты: системные + пользовательские (presets.json).
 *
 * TS-исходник, как server/ts/jobStore.ts: компилируется в server/tts.js
 * командой `npm run compile:server`, поэтому `require("./tts")` из
 * routes/tts.js работает без изменений.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import settings from "./settings";
import logger from "./logger";
import config from "./config";
import { detectFfmpeg } from "./convertEngine";
import * as ruNlp from "./ruNlp";
import { createQueue, trimJobs } from "./jobStore";
import { removeOlderThan } from "./fsUtil";

/**
 * Окружение для python-процессов приложения.
 *
 * stdout/stderr питона идут в UTF-8, а не в кодировке локали Windows (cp1251 на
 * русской системе): иначе вывод на русском превращается в крякозябры в логе
 * приложения, а JSON-протокол сайдкара ломается целиком (подробности —
 * py_audio.force_utf8 и EngineSidecar._start).
 */
const PY_ENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

/** Каталог storage приложения и его подкаталоги. */
const { DIRS } = config;

/* ------------------------------- Типы ------------------------------- */

/** Движок синтеза: F5-TTS или Coqui XTTS v2. */
type TtsEngine = "f5" | "xtts";

/** Рекомендации под конкретный GPU для бейджей «Optimal for Your PC». */
interface OptimalParams {
  precision: string;
  precisionReason: string;
  nfe: string;
  cfg: string;
  attention: string;
  temperature: string;
  repetitionPenalty: string;
  topP: string;
  crossFadeMs: string;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  loudnessTarget: number;
  speed: number;
  solver: string;
  isNvidia: boolean;
  vram: number;
}

/** Железо: nvidia-smi (или фолбэк на CPU) + рекомендации. */
interface HardwareInfo {
  gpu: {
    found: boolean;
    name: string;
    vramTotalGb: number;
    vramUsedGb: number;
    utilPct: number;
    driver: string;
  };
  cpu: { name: string; cores: number };
  platform: string;
  optimal: OptimalParams;
}

/** Тело запроса на сохранение профиля голоса (вход из роута — недоверенный). */
interface VoiceProfileInput {
  name?: unknown;
  refFile?: unknown;
  engine?: unknown;
}

/** Профиль голоса: референсный wav + движок. */
interface VoiceProfile {
  id: string;
  name: string;
  refFile: string;
  engine: TtsEngine;
  createdAt: number;
}

/** Параметры задания: приходят строкой из multipart/JSON — значения недоверенные. */
interface TtsParamsInput {
  precision?: unknown;
  attention?: unknown;
  gcEveryChunks?: unknown;
  nfe?: unknown;
  cfg?: unknown;
  solver?: unknown;
  temperature?: unknown;
  repetitionPenalty?: unknown;
  topK?: unknown;
  topP?: unknown;
  speed?: unknown;
  crossFadeMs?: unknown;
  sentencePauseMs?: unknown;
  paragraphPauseMs?: unknown;
  loudnessTarget?: unknown;
  expandNumbers?: unknown;
  yoficate?: unknown;
  markStress?: unknown;
  chunkLimit?: unknown;
  format?: unknown;
  exaggeration?: unknown;
}

/** Чанк в задании: текст и/или чистая пауза (pauseMs) между чанками. */
interface TtsItem {
  text?: string;
  pauseMs?: number | null;
}

/** Нормализованные параметры задания: всё приведено к допустимым значениям. */
interface NormalizedParams {
  refFile: string;
  /** Всегда русский (TTS_LANGUAGE) — язык не выбирается и не настраивается. */
  language: string;
  precision: string;
  attention: string;
  gcEveryChunks: number;
  nfe: number;
  cfg: number;
  solver: string;
  exaggeration: number;
  temperature: number;
  repetitionPenalty: number;
  topK: number;
  topP: number;
  speed: number;
  crossFadeMs: number;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  loudnessTarget: number;
  format: string;
  title: string;
  author: string;
  coverImage: string | null;
  expandNumbers: boolean;
  yoficate: boolean;
  markStress: boolean;
}

/** Тело запроса на старт озвучки (multipart из роута — значения недоверенные). */
interface TtsJobInput extends TtsParamsInput {
  text?: unknown;
  chunks?: unknown;
  refFile?: unknown;
  engine?: unknown;
  /**
   * Язык озвучки — принимается, но ИГНОРИРУЕТСЯ (движок всегда русский, см.
   * TTS_LANGUAGE). Поле оставлено, чтобы старые сборки интерфейса и сохранённые
   * профили (там лежали названия вроде «English») не ломали запуск задания.
   */
  language?: unknown;
  title?: unknown;
  author?: unknown;
  coverImage?: unknown;
}

/** Сообщение Python-сайдкара: одна JSON-строка из stdout. */
interface SidecarMessage {
  type?: string;
  message?: string;
  [key: string]: unknown;
}

/** Тело запроса на сохранение пресета (из роута — значения недоверенные). */
interface TtsPresetInput {
  name?: unknown;
  engine?: unknown;
  params?: unknown;
  refFile?: unknown;
}

/** Пресет: системный (builtin) или пользовательский. */
interface TtsPreset {
  id: string;
  name: string;
  engine: TtsEngine;
  params: TtsParamsInput;
  refFile?: string;
  builtin: boolean;
  createdAt?: number;
}

/**
 * Диагностика Python-окружения для UI: сырое «No module named 'torch'» ничего
 * не объясняет, поэтому задание несёт машинный код, интерпретатор и список
 * ненайденных модулей — по ним страница «Голос» показывает понятный текст и
 * готовую команду установки.
 */
interface TtsEnvError {
  code: string;
  cmd: string;
  detail: string;
  python: string;
  executable: string;
  missing: string[];
  installHint: string;
}

/** Задание озвучки: чанки, параметры, прогресс и результат. */
interface TtsJob {
  id: string;
  engine: TtsEngine;
  stage: string;
  progress: number;
  error: string;
  done: boolean;
  outFile: string;
  outSize: number;
  createdAt: number;
  chunkIndex: number;
  chunksTotal: number;
  vram: SidecarMessage | null;
  items: TtsItem[];
  estimateTotalMs: number;
  opts: NormalizedParams;
  envError?: TtsEnvError;
  /** Пользователь запросил отмену — цикл рендера чанков проверяет между итерациями. */
  cancelRequested?: boolean;
  /** Активный сайдкар движка — для killHard() из cancelJob (Диспетчер задач). */
  _sidecar?: { killHard(): void } | null;
  [key: string]: unknown;
}

const jobs = new Map<string, TtsJob>();
const JOB_LIMIT = 30;
const TTL_MS = 24 * 60 * 60 * 1000;

/* ------------- Очередь (одно задание на GPU): server/ts/jobStore.ts ------------ */

const queue = createQueue("tts");

/* ------------------------- TTL-чистка storage/tts ------------------------- */
/* (server/ts/fsUtil.ts): profiles.json и presets.json — пользовательские
   данные, их не трогаем; остальное — папки заданий старше суток.
   ВАЖНО: `ruaccent` в списке исключений обязательно — это каталог моделей
   RUAccent (server/engines/ru_accent.py), почти 700 МБ скачанных словарей и
   нейросетей. Без исключения уборка снесла бы их через сутки после загрузки, и
   следующее задание качало бы всё заново (или падало на недокачанном каталоге). */

removeOlderThan({
  dir: DIRS.tts,
  ttlMs: TTL_MS,
  keep: ["profiles.json", "presets.json", "ruaccent"],
});

/* ------------------------- Железо: GPU / VRAM ------------------------- */

let hwCache: HardwareInfo | null = null,
  hwAt = 0;

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// «Оптимально для вашего ПК»: рекомендации под конкретный GPU (для бейджей UI).
function buildOptimal(gpuName: string, totalMb: number): OptimalParams {
  const vram = totalMb / 1024;
  const isNvidia = /nvidia|geforce|rtx|gtx/i.test(gpuName);
  const smallVram = vram > 0 && vram <= 8;
  return {
    precision: smallVram ? "float16" : "bfloat16",
    precisionReason: smallVram ? `FP16 для ${vram.toFixed(0)}GB VRAM` : "BF16 для вашей карты",
    nfe: "32-48",
    cfg: "2.0-2.5",
    attention: "sdpa",
    temperature: "0.65-0.75",
    repetitionPenalty: "3.5-5.0",
    topP: "0.85",
    crossFadeMs: "50-100",
    sentencePauseMs: 400,
    paragraphPauseMs: 1200,
    loudnessTarget: -16,
    speed: 1.0,
    solver: "euler",
    isNvidia,
    vram: round1(vram),
  };
}

function detectHardware(): Promise<HardwareInfo> {
  return new Promise<HardwareInfo>((resolve) => {
    if (hwCache && Date.now() - hwAt < 15000) return resolve(hwCache);
    const child = spawn(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    // stderr читаем и игнорируем: nvidia-smi шумит предупреждениями, но код
    // возврата и stdout достаточно для решения «GPU есть / fallback».
    child.stderr.on("data", () => {
      /* диагностика движка не нужна */
    });
    child.on("error", () => {
      hwCache = hwFallback();
      hwAt = Date.now();
      resolve(hwCache);
    });
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) {
        hwCache = hwFallback();
        hwAt = Date.now();
        return resolve(hwCache);
      }
      const [name, total, used, util, driver] = out
        .trim()
        .split(",")
        .map((s) => s.trim());
      const totalGb = Number(total) / 1024;
      hwCache = {
        gpu: {
          found: true,
          name: name || "NVIDIA GPU",
          vramTotalGb: round1(totalGb),
          vramUsedGb: round1(Number(used) / 1024),
          utilPct: Number(util) || 0,
          driver: driver || "",
        },
        cpu: { name: os.cpus()[0]?.model || "", cores: os.cpus().length },
        platform: process.platform,
        optimal: buildOptimal(name, totalMbToNumber(total)),
      };
      hwAt = Date.now();
      resolve(hwCache);
    });
    function hwFallback() {
      return {
        gpu: {
          found: false,
          name: "CPU / нет NVIDIA GPU",
          vramTotalGb: 0,
          vramUsedGb: 0,
          utilPct: 0,
          driver: "",
        },
        cpu: { name: os.cpus()[0]?.model || "", cores: os.cpus().length },
        platform: process.platform,
        optimal: buildOptimal("", 0),
      };
    }
    function totalMbToNumber(v: unknown): number {
      return Number(v) || 0;
    }
  });
}

/* ------------------------- Профили голоса ------------------------- */

const PROFILES_FILE = path.join(DIRS.tts, "profiles.json");

function loadProfiles(): VoiceProfile[] {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveProfiles(list: VoiceProfile[]): void {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), "utf8");
}

function saveProfile(p: VoiceProfileInput): VoiceProfile {
  const refFile = String(p.refFile || "").replace(/^.*[\\/]/, "");
  if (refFile && !/^ref_[A-Za-z0-9._-]+$/.test(refFile)) throw new Error("invalid refFile");
  if (refFile && !fs.existsSync(path.join(DIRS.tts, refFile))) throw new Error("refFile not found");
  const list = loadProfiles();
  const profile: VoiceProfile = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(p.name || "voice").slice(0, 60),
    refFile,
    engine: p.engine === "xtts" ? "xtts" : "f5",
    createdAt: Date.now(),
  };
  list.push(profile);
  saveProfiles(list);
  return profile;
}

function deleteProfile(id: string): boolean {
  const list = loadProfiles();
  const next = list.filter((p) => p.id !== id);
  saveProfiles(next);
  return next.length !== list.length;
}

/* ------------------------- Пресеты ------------------------- */

const BUILTIN_PRESETS: TtsPreset[] = [
  {
    id: "sys-fiction-xtts",
    builtin: true,
    name: "Драматическая проза (XTTS v2)",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.72,
      repetitionPenalty: 4.0,
      topK: 50,
      topP: 0.85,
      speed: 1.0,
      crossFadeMs: 80,
      sentencePauseMs: 450,
      paragraphPauseMs: 1400,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 220,
      format: "m4b",
    },
  },
  {
    id: "sys-nonfiction-f5",
    builtin: true,
    name: "Нон-фикшн (F5-TTS быстро и чисто)",
    engine: "f5",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      nfe: 36,
      cfg: 2.2,
      solver: "euler",
      speed: 1.0,
      crossFadeMs: 60,
      sentencePauseMs: 400,
      paragraphPauseMs: 1200,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 380,
      format: "m4b",
    },
  },
  {
    id: "sys-dialogue",
    builtin: true,
    name: "Выразительные диалоги / актёрская игра",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.85,
      repetitionPenalty: 3.5,
      topK: 60,
      topP: 0.9,
      speed: 0.95,
      crossFadeMs: 100,
      sentencePauseMs: 600,
      paragraphPauseMs: 1500,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 200,
      format: "mp3",
    },
  },
  {
    id: "sys-bedtime",
    builtin: true,
    name: "Сказка на ночь",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.65,
      repetitionPenalty: 5.0,
      topK: 40,
      topP: 0.8,
      speed: 0.85,
      crossFadeMs: 120,
      sentencePauseMs: 800,
      paragraphPauseMs: 2000,
      loudnessTarget: -18,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 200,
      format: "mp3",
    },
  },
];

const PRESETS_FILE = path.join(DIRS.tts, "presets.json");

function listPresets(): TtsPreset[] {
  let user: TtsPreset[] = [];
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    /* пусто */
  }
  return [...BUILTIN_PRESETS, ...user];
}

function saveUserPreset(preset: TtsPresetInput): TtsPreset {
  let user: TtsPreset[] = [];
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    /* пусто */
  }
  const item: TtsPreset = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(preset.name || "preset").slice(0, 80),
    engine: preset.engine === "xtts" ? "xtts" : "f5",
    params: (preset.params || {}) as TtsParamsInput,
    refFile: String(preset.refFile || "").replace(/^.*[\\/]/, ""),
    builtin: false,
    createdAt: Date.now(),
  };
  user.push(item);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(user, null, 2), "utf8");
  return item;
}

function deleteUserPreset(id: string): boolean {
  let user: TtsPreset[];
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    return false;
  }
  const next = user.filter((p) => p.id !== id);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next.length !== user.length;
}

/* ------------------------- Python-сайдкар ------------------------- */

// Персистентный процесс движка: модель в VRAM один раз, чанки по конвейеру.
/**
 * Каркас python-сайдкара: JSON-строки через stdin/stdout.
 *
 * Вынесен отдельным классом, потому что по этому протоколу работают и движки
 * озвучки (server/engines/f5_wrapper.py, xtts_wrapper.py), и рабочий процесс
 * ударений (server/engines/ruaccent_worker.py): запуск python, чтение строк
 * stdout, раздача ответов ожидающим запросам, снятие процесса вместе с деревом.
 */
class JsonSidecar {
  script: string;
  /** Метка для логов (`tts.<tag>.stderr`): движок или рабочий процесс. */
  tag: string;
  child: ChildProcess | null;
  buffer: string;
  /** Ожидающие ответов запросы: у каждого свой набор типов-ответов. */
  waiters: Array<{
    types: string[];
    resolve: (msg: SidecarMessage) => void;
    timer: NodeJS.Timeout;
  }>;
  /**
   * События вне запроса (телеметрия VRAM): движок шлёт их сам после каждого
   * чанка — по ним задание обновляет счётчик видеопамяти.
   */
  onEvent: ((msg: SidecarMessage) => void) | null;
  /** Ошибка запуска интерпретатора (ENOENT и т.п.) — «залипает» до конца жизни. */
  spawnError: string;

  constructor(script: string, tag: string) {
    this.script = script;
    this.tag = tag;
    this.child = null;
    this.buffer = "";
    this.waiters = [];
    this.onEvent = null;
    this.spawnError = "";
  }

  _start(): this {
    const python = pythonCmd();
    const child = spawn(python, [this.script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Протокол сайдкара — UTF-8, а python с присоединённым конвейером берёт
      // кодировку из локали Windows (cp1251 на русской системе). Без этого
      // русский текст книжки декодировался как крякозябры (196 «символов» вместо
      // 108 — столько занимают его UTF-8 байты), и движок озвучивал мусор:
      // «тарабарщина» вместо русского. Сам сайдкар делает то же самое
      // (py_audio.force_utf8) — здесь страховка для сборок без reconfigure.
      env: PY_ENV,
    });
    this.child = child;
    // spawn падает мгновенно (ENOENT: интерпретатор не найден по указанному в
    // настройках пути). Без обработчика запрос висел до таймаута 10 минут, а
    // поток stdin ронял процесс необработанным EPIPE.
    child.on("error", (e) => {
      this.spawnError = `python_spawn_failed: ${String((e as Error).message || e)}`;
      const msg: SidecarMessage = { type: "error", message: this.spawnError };
      const waiters = this.waiters.splice(0, this.waiters.length);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      this.buffer += String(d);
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this._dispatch(JSON.parse(line));
        } catch {
          /* мусорная строка из stderr-мусора в stdout */
        }
      }
    });
    child.stderr?.on("data", (d) =>
      logger.info(`tts.${this.tag}.stderr`, { tail: String(d).slice(-400) }),
    );
    // Процесс мог умереть, пока запрос ждал ответа (убит через killHard() при
    // отмене задания, упал сам, OOM и т.п.) — БЕЗ этого обработчика ask()
    // просто висел до своего таймаута (до 10 минут на infer), и отмена задания
    // выглядела так, будто ничего не произошло: killHard() убивал процесс, но
    // сама Promise-цепочка рендера чанка не знала об этом и продолжала ждать.
    child.on("close", () => {
      if (this.child !== child) return; // это старый child, уже заменён новым _start()
      const waiters = this.waiters.splice(0, this.waiters.length);
      const msg: SidecarMessage = { type: "error", message: "sidecar_closed" };
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });
    return this;
  }

  /**
   * Раздать пришедшее сообщение ОЖИДАЮЩЕМУ его запросу.
   *
   * Раньше ответом считалось просто «следующее сообщение», а оба движка после
   * каждого инференса шлют ДВА сообщения (`vram` и `done`) — запросы разъезжались
   * на одно сообщение, и конвейер считал чанк готовым, пока движок ещё считал
   * следующий. На склейке это вылезало как «Error opening input file
   * chunk_0002.wav: No such file or directory»: файла ещё не было.
   *
   * Поэтому ответ ищется по типу, «чужие» сообщения запросам не достаются, а
   * телеметрия уходит в onEvent (монитор VRAM). Ошибка завершает любой запрос.
   */
  _dispatch(msg: SidecarMessage): void {
    const type = String(msg.type || "");
    const i = this.waiters.findIndex((w) => type === "error" || w.types.includes(type));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.onEvent?.(msg);
  }

  /**
   * Отправить запрос и дождаться ответа нужного типа (`ready` для init, `done`
   * для инференса; ошибка подходит всегда). Телеметрия `vram` ответом не
   * считается — она приходит между ответами и уходит в onEvent.
   */
  ask(
    obj: Record<string, unknown>,
    expect: string | string[],
    timeoutMs = 3600000,
  ): Promise<SidecarMessage> {
    const types = Array.isArray(expect) ? expect : [expect];
    return new Promise<SidecarMessage>((resolve, reject) => {
      const stdin = this.child?.stdin;
      // Ошибка запуска уже случилась (нет интерпретатора), либо процесс умер:
      // отвечаем сразу, не ожидая таймаута.
      if (this.spawnError) return reject(new Error(this.spawnError));
      if (!stdin || this.child?.exitCode != null) return reject(new Error("sidecar_dead"));
      const waiter = {
        types,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("sidecar_timeout"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      stdin.write(JSON.stringify(obj) + "\n");
    });
  }

  /**
   * Закрыть сайдкар: сначала вежливо (shutdown — процесс освобождает VRAM и
   * выходит сам), через 500 мс — принудительно и всем деревом процессов.
   *
   * Зачем добивать: python может не отреагировать (завис на загрузке модели или
   * в недрах CUDA), и тогда он остаётся в памяти вместе с моделью в VRAM. После
   * задания он не нужен никогда — ни при успехе, ни при ошибке.
   */
  kill(): void {
    if (!this.child || this.child.exitCode != null) return;
    try {
      this.child.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => this.killHard(), 500);
  }

  /** Принудительное завершение процесса python вместе с деревом. */
  killHard(): void {
    const child = this.child;
    if (!child || child.exitCode != null) return;
    try {
      // На Windows ребёнок python мог наплодить своих процессов (torch), поэтому
      // снимаем дерево: тот же приём, что при отмене установки окружения.
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      /* процесс мог уже завершиться */
    }
  }
}

/** Сайдкар движка озвучки: F5-TTS либо Coqui XTTS v2. */
class EngineSidecar extends JsonSidecar {
  engine: TtsEngine;

  constructor(engineName: unknown) {
    const engine: TtsEngine = engineName === "xtts" ? "xtts" : "f5";
    super(
      path.join(__dirname, "engines", engine === "f5" ? "f5_wrapper.py" : "xtts_wrapper.py"),
      engine,
    );
    this.engine = engine;
  }
}

/* --------------------- Ударения по смыслу (RUAccent) --------------------- */

/**
 * Расстановка ударений и восстановление «ё» нейросетью RUAccent.
 *
 * Почему не в сайдкаре движка: onnxruntime на CPU и torch в одном процессе делят
 * память, а рендер F5-TTS и так занимает несколько гигабайт. Плюс ударения нужны
 * ДО инференса, одни и те же для любого движка — поэтому отдельный процесс
 * (server/engines/ruaccent_worker.py) со своим жизненным циклом.
 *
 * Зачем вообще: свой словарь омографов знает четыре слова (server/ts/ruNlp.ts),
 * и «звони́т», «догово́р», «жалюзи́» F5-TTS читал с неверным ударением. RUAccent
 * решает омографы по контексту («М+ука из пшен+ицы и мук+а от б+оли») и отдаёт
 * ударение в том самом формате «+» перед гласной, который ждёт русская модель
 * F5.
 *
 * Шаг НЕОБЯЗАТЕЛЬНЫЙ: нет библиотеки, не скачались модели, оборвалась сеть —
 * задание всё равно рендерится, только без ударений, а причина уходит в лог
 * (tts.stress.error). Повторные попытки — не чаще раза в STRESS_RETRY_MS, иначе
 * каждое задание сначала ждало бы таймаут недоступной сети.
 */
let stressWorker: JsonSidecar | null = null;
let stressIdleTimer: NodeJS.Timeout | null = null;
/** Модели загружены в процессе (по этому признаку решается, нужен ли load). */
let stressLoaded = false;
/** До этого времени пробовать снова бессмысленно (см. STRESS_RETRY_MS). */
let stressRetryAt = 0;
/** Почему ударения недоступны — уходит в лог и в snapshot задания. */
let stressFailReason = "";

/** Сколько текстов отправляем за одну просьбу: прогресс в UI и короткие строки. */
const STRESS_BATCH = 200;
/** Через сколько бездействия снимать процесс (модели держат память). */
const STRESS_IDLE_MS = 10 * 60 * 1000;
/** Пауза между попытками, когда RUAccent недоступен (нет библиотеки/моделей). */
const STRESS_RETRY_MS = 10 * 60 * 1000;
/** Модель омографов по умолчанию — как в server/engines/ru_accent.py. */
const STRESS_MODEL_DEFAULT = "tiny2.1";
/** Доступные модели омографов RUAccent (значение настройки — только из списка). */
const STRESS_MODELS = [
  "tiny",
  "tiny2",
  "tiny2.1",
  "turbo",
  "turbo2",
  "turbo3",
  "turbo3.1",
  "big_poetry",
];

/** Настройки расстановки ударений (voice.stressModel / voice.stressLite). */
function stressOptions(): { model: string; dict: boolean; tiny: boolean } {
  const voice = (settings.get("voice") || {}) as Record<string, unknown>;
  const want = String(voice.stressModel || "").trim();
  // Лёгкий режим (tiny_mode) — по умолчанию: 847 МБ памяти вместо 3 ГБ, а по
  // замерам ударения те же. Выключается настройкой voice.stressLite = false.
  const tiny = voice.stressLite !== false;
  return {
    model: STRESS_MODELS.includes(want) ? want : STRESS_MODEL_DEFAULT,
    tiny,
    // В лёгком режиме RUAccent всё равно берёт нейросетевой словарь, поэтому
    // большой (20 МБ) не просим: меньше памяти и без лишней распаковки.
    dict: !tiny,
  };
}

/** Рабочий процесс ударений: запускается при первом использовании. */
function stressSidecar(): JsonSidecar {
  if (stressIdleTimer) {
    clearTimeout(stressIdleTimer);
    stressIdleTimer = null;
  }
  if (!stressWorker) {
    stressWorker = new JsonSidecar(
      path.join(__dirname, "engines", "ruaccent_worker.py"),
      "stress",
    )._start();
  }
  return stressWorker;
}

/** Выгрузить модели и назначить снятие процесса по бездействию. */
function stressRelease(sidecar: JsonSidecar, unload: boolean): void {
  if (unload && stressLoaded) {
    stressLoaded = false;
    // Ответ не ждём: выгрузка — это gc в процессе, а рендер уже можно начинать.
    sidecar.ask({ type: "unload" }, "unloaded", 30000).catch(() => {
      /* процесс мог уже завершиться */
    });
  }
  if (stressIdleTimer) clearTimeout(stressIdleTimer);
  stressIdleTimer = setTimeout(stressStop, STRESS_IDLE_MS);
  // Таймер не должен удерживать процесс приложения (и тесты) живыми.
  stressIdleTimer.unref?.();
}

/** Снять процесс ударений (модели при этом освобождаются). */
function stressStop(): void {
  if (stressIdleTimer) {
    clearTimeout(stressIdleTimer);
    stressIdleTimer = null;
  }
  if (stressWorker) {
    stressWorker.kill();
    stressWorker = null;
  }
  stressLoaded = false;
}

/**
 * Расставить ударения во всех чанках задания ДО рендера.
 *
 * Возвращает тексты по индексу чанка (та же длина, что job.items) либо null,
 * если ударения недоступны: тогда рендер идёт на исходных текстах.
 *
 * Побочные эффекты для UI: job.stage = "stress" и прогресс 1..6 % — шаг заметный
 * (первый раз качает модели, дальше секунды), и без него задание выглядело бы
 * «зависшим» до самого инференса.
 */
async function accentItems(job: TtsJob): Promise<string[] | null> {
  const texts = job.items.map((i) => String(i.text || ""));
  if (!texts.some((t) => t.trim())) return null;
  // Недавняя неудача: не тратим время задания на заведомо недоступный шаг.
  if (Date.now() < stressRetryAt) return null;
  const opts = stressOptions();
  let sidecar: JsonSidecar | null = null;
  try {
    job.stage = "stress";
    job.progress = 1;
    sidecar = stressSidecar();
    if (!stressLoaded) {
      // Первая загрузка качает модели (сотни мегабайт) — таймаут щедрый, как у
      // init движка; дальше модели живут в процессе между заданиями.
      const ready = await sidecar.ask({ type: "load", ...opts }, "ready", 1800000);
      if (ready.type === "error") throw new Error(ready.message);
      stressLoaded = true;
      logger.info("tts.stress.model", {
        model: ready.model,
        version: ready.version,
        dict: ready.dict,
        tiny: ready.tiny,
        sec: ready.sec,
        repaired: ready.repaired,
      });
    }
    const out = texts.slice();
    let marks = 0;
    for (let i = 0; i < texts.length; i += STRESS_BATCH) {
      const batch = texts.slice(i, i + STRESS_BATCH);
      const res = await sidecar.ask({ type: "accent", texts: batch }, "accented", 600000);
      if (res.type === "error") throw new Error(res.message);
      const got = Array.isArray(res.texts) ? (res.texts as unknown[]) : [];
      for (let k = 0; k < batch.length; k++) {
        const text = got[k] === undefined ? batch[k] : String(got[k]);
        marks += text.split("+").length - 1;
        out[i + k] = text;
      }
      job.progress = 1 + Math.round((5 * Math.min(i + batch.length, texts.length)) / texts.length);
    }
    logger.info("tts.stress", { id: job.id, chunks: texts.length, marks: marks });
    return out;
  } catch (e) {
    const reason = String((e as Error)?.message || e);
    stressFailReason = reason;
    stressRetryAt = Date.now() + STRESS_RETRY_MS;
    logger.error("tts.stress.error", { id: job.id, error: reason, retryInMs: STRESS_RETRY_MS });
    // Процесс мог зависнуть на импорте или закачке моделей — снимаем его целиком.
    stressStop();
    return null;
  } finally {
    if (sidecar && stressWorker === sidecar) stressRelease(sidecar, true);
  }
}

/* ------------------------- Python-окружение ------------------------- */

/**
 * Требуемые Python-модули для каждого движка:
 *   f5   — torch + torchaudio + f5_tts (пакет `f5-tts`), pynvml опционален;
 *   xtts — torch + torchaudio + TTS (Coqui).
 *
 * Зачем проверять заранее: приложение запускает сайдкар через `python` из PATH,
 * но torch/f5_tts обычно стоят в ДРУГОМ окружении (venv, conda, `py -3.11`).
 * Тогда рендер падал сырым «No module named 'torch'» уже внутри python, и в UI
 * это выглядело как «Ошибка рендера: No module named 'torch'» без подсказки,
 * что и куда ставить. Теперь окружение проверяется до запуска задания, а
 * интерпретатор задаётся в настройках (voice.pythonCmd).
 */
const ENGINE_REQUIRED: Record<TtsEngine, string[]> = {
  f5: ["torch", "torchaudio", "f5_tts"],
  xtts: ["torch", "torchaudio", "TTS"],
};

/**
 * Готовые команды установки отсутствующих модулей (подсказка в UI).
 * Индекс — cu128: в cu132 пакета torchaudio нет вообще (pip падает на шаге
 * «torch» с «No matching distribution found for torchaudio»), а он нужен и XTTS,
 * и F5. Индекс берётся из того же места, что и в установщике (server/ts/pyEnv.ts).
 *
 * Про XTTS: классический пакет `TTS` (coqui-ai) заморожен на 0.22.0 с
 * Requires-Python `>=3.9,<3.12` — на Python 3.12+ pip не найдёт ни одной версии
 * («from versions: none»), поэтому в подсказке стоит поддерживаемый форк
 * `coqui-tts` (тот же модуль `TTS`, ставится на 3.10–3.14). Установщик окружения
 * выбирает пакет по версии интерпретатора сам (см. enginePkg в server/ts/pyEnv.ts).
 */
const PIP_HINT: Record<string, string> = {
  torch:
    "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128",
  torchaudio:
    "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128",
  f5_tts: "pip install f5-tts",
  TTS: "pip install coqui-tts",
  ruaccent: "pip install ruaccent",
  pynvml: "pip install nvidia-ml-py",
};

/** Результат проверки Python-окружения (уходит в UI через GET /api/tts/env). */
export interface PythonEnv {
  /** Интерпретатор ответил и модули перечислены. */
  ok: boolean;
  /** Код ошибки: "" | python_not_found | probe_failed. */
  error: string;
  /** Детали ошибки (текст от ОС/интерпретатора) — для логов и UI. */
  detail: string;
  cmd: string;
  python: string;
  executable: string;
  modules: Record<string, boolean>;
  /** Чего не хватает для F5-TTS. */
  missingF5: string[];
  /** Чего не хватает для Coqui XTTS v2. */
  missingXtts: string[];
  /** Команды установки для F5-TTS / XTTS (пустая строка — всё на месте). */
  installF5: string;
  installXtts: string;
  checkedAt: number;
  cached: boolean;
}

let envCache: PythonEnv | null = null;
let envCacheCmd = "";
const ENV_TTL_MS = 30000;

/** Интерпретатор из настроек (пусто/мусор → "python" из PATH). */
function pythonCmd(): string {
  return String(settings.get("voice")?.pythonCmd || "python").trim() || "python";
}

/** Команда установки для списка отсутствующих модулей (без дублей). */
function hintFor(missing: string[]): string {
  return [...new Set(missing.map((m) => PIP_HINT[m]).filter(Boolean))].join("\n");
}

function engineMissing(env: PythonEnv, engine: TtsEngine): string[] {
  return engine === "xtts" ? env.missingXtts : env.missingF5;
}

function envFail(cmd: string, error: string, detail: string): PythonEnv {
  return {
    ok: false,
    error,
    detail,
    cmd,
    python: "",
    executable: "",
    modules: {},
    missingF5: [...ENGINE_REQUIRED.f5],
    missingXtts: [...ENGINE_REQUIRED.xtts],
    installF5: hintFor(ENGINE_REQUIRED.f5),
    installXtts: hintFor(ENGINE_REQUIRED.xtts),
    checkedAt: Date.now(),
    cached: false,
  };
}

/** JSON-ответ пробы окружения (server/engines/python_env.py). */
interface ProbeResult {
  python?: unknown;
  executable?: unknown;
  modules?: Record<string, unknown>;
}

/** Разбор JSON-строки пробы (server/engines/python_env.py). */
function parseEnv(cmd: string, out: string, code: number | null, errTail: string): PythonEnv {
  let data: ProbeResult | null = null;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      data = JSON.parse(t) as ProbeResult;
    } catch {
      /* не наш JSON — ищем дальше */
    }
  }
  if (!data) return envFail(cmd, "probe_failed", errTail.trim() || `exit ${code}`);
  const modules: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(data.modules || {})) modules[k] = v === true;
  const miss = (need: string[]) => need.filter((m) => !modules[m]);
  const missingF5 = miss(ENGINE_REQUIRED.f5);
  const missingXtts = miss(ENGINE_REQUIRED.xtts);
  return {
    ok: true,
    error: "",
    detail: "",
    cmd,
    python: String(data.python || ""),
    executable: String(data.executable || ""),
    modules,
    missingF5,
    missingXtts,
    installF5: hintFor(missingF5),
    installXtts: hintFor(missingXtts),
    checkedAt: Date.now(),
    cached: false,
  };
}

/**
 * Проверка окружения: `<pythonCmd> server/engines/python_env.py` → JSON.
 * find_spec внутри пробы не грузит torch (секунды экономии) и не занимает VRAM.
 * Результат кэшируется на 30 секунд, чтобы поллинг UI не спавнил python зря.
 */
function pythonEnv(force = false): Promise<PythonEnv> {
  const cmd = pythonCmd();
  if (!force && envCache && envCacheCmd === cmd && Date.now() - envCache.checkedAt < ENV_TTL_MS) {
    return Promise.resolve({ ...envCache, cached: true });
  }
  const script = path.join(__dirname, "engines", "python_env.py");
  return new Promise<PythonEnv>((resolve) => {
    let out = "";
    let errTail = "";
    let done = false;
    const finish = (env: PythonEnv) => {
      envCache = env;
      envCacheCmd = cmd;
      resolve(env);
    };
    const child = spawn(cmd, [script], { windowsHide: true, env: PY_ENV });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(envFail(cmd, "probe_failed", "timeout"));
    }, 20000);
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      errTail = (errTail + String(d)).slice(-500);
    });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish(envFail(cmd, "python_not_found", String((e as Error).message || e)));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish(parseEnv(cmd, out, code, errTail));
    });
  });
}

/**
 * Провалить задание ДО запуска сайдкара, если окружение не готово, и положить в
 * job.envError машинную диагностику для UI. Без этого пользователь получал
 * «No module named 'torch'» после многоминутного ожидания загрузки модели.
 */
async function assertPythonEnv(job: TtsJob): Promise<void> {
  const env = await pythonEnv();
  if (!env.ok) {
    const code = String(env.error || "probe_failed").split(":")[0];
    job.envError = {
      code,
      cmd: env.cmd,
      detail: env.detail,
      python: env.python,
      executable: env.executable,
      missing: engineMissing(env, job.engine),
      installHint: job.engine === "xtts" ? env.installXtts : env.installF5,
    };
    throw new Error(code === "python_not_found" ? `python_not_found: ${env.cmd}` : code);
  }
  const missing = engineMissing(env, job.engine);
  if (missing.length) {
    job.envError = {
      code: "python_env_missing",
      cmd: env.cmd,
      detail: "",
      python: env.python,
      executable: env.executable,
      missing,
      installHint: job.engine === "xtts" ? env.installXtts : env.installF5,
    };
    throw new Error(`python_env_missing: ${missing.join(",")}`);
  }
}

/**
 * Нормализация ошибок сайдкара: если python всё же упал внутри импорта
 * («No module named 'x'»), превращаем текст в тот же код + подсказку. Это
 * страховка на случаи, когда find_spec прошёл, а импорт упал (битые DLL/ABI).
 */
function envAwareError(job: TtsJob, msg: unknown): Error {
  const text = String(msg || "");
  // Интерпретатор вообще не запустился: путь из настроек неверный.
  if (/python_spawn_failed/.test(text)) {
    job.envError = {
      code: "python_not_found",
      cmd: pythonCmd(),
      detail: text,
      python: "",
      executable: "",
      missing: [],
      installHint: "",
    };
    return new Error(`python_not_found: ${pythonCmd()}`);
  }
  const m = /No module named ['"]([^'"]+)['"]/.exec(text);
  if (m) {
    const mod = m[1].split(".")[0];
    job.envError = {
      code: "python_env_missing",
      cmd: pythonCmd(),
      detail: text,
      python: "",
      executable: "",
      missing: [mod],
      installHint: hintFor([mod]),
    };
    return new Error(`python_env_missing: ${mod}`);
  }
  return new Error(text);
}

/* ------------------------- Задание ------------------------- */

const ENGINE_CHUNK_LIMIT = { f5: 380, xtts: 220 };

/**
 * Разрезать чанк, который длиннее лимита движка, — готовые чанки тоже.
 *
 * В Batch Editor чанки объединяют и правят руками, поэтому «готовый» чанк может
 * быть сколь угодно длинным: после «объединить» двух чанков по 380 символов
 * задание падало посреди рендера с «❗ XTTS can only generate text with a maximum
 * of 400 tokens» (у XTTS ~1.8 символа на токен, то есть ~690 символов русского —
 * это и есть 400 токенов).
 *
 * Пауза остаётся у последней части: она относится к тишине ПОСЛЕ чанка, иначе
 * пауза встала бы в середине фразы. Если резать нечем (нет ни точек, ни
 * пробелов) — отдаём как есть: обёртка XTTS дорежет сама, а не упадёт.
 */
function splitLongItem(item: TtsItem, limit: number): TtsItem[] {
  const text = String(item.text || "");
  if (!text || text.length <= limit) return [item];
  const parts = ruNlp.chunkText(text, limit);
  if (parts.length < 2) return [item];
  const out: TtsItem[] = parts.map((p) => ({ text: p.text, pauseMs: p.pauseMs }));
  const last = out[out.length - 1];
  if (item.pauseMs) last.pauseMs = item.pauseMs;
  return out.filter((c) => c.text || c.pauseMs);
}

// Белые списки значений UI: всё, что не из списка, приводится к дефолту.
const PRECISIONS = ["float16", "bfloat16", "float32", "int8"];
const ATTENTIONS = ["sdpa", "flash", "eager"];
const SOLVERS = ["euler", "midpoint", "rk4"];

/**
 * Язык движка — зафиксирован, и это исправление, а не упрощение.
 *
 * XTTS язык текста НЕ определяет: он читает кириллицу фонемами того языка,
 * который ему передали. Пока язык выбирался в интерфейсе и лежал в настройках
 * (`voice.defaultLanguage`, где по умолчанию стоял «English»), русская книга
 * уезжала в модель как английская — в логе это
 * «The text length exceeds the character limit of 250 for language 'en'», а на
 * слух — тарабарщина вместо русского. Выбор языка убран из интерфейса, из
 * настроек и из задания: движок в этом приложении всегда русский.
 *
 * Поле `language` в задании принимается (старые сохранённые профили и пресеты
 * его ещё присылают), но не используется — см. TtsJobInput.
 */
const TTS_LANGUAGE = "ru";
const FORMATS = ["mp3", "wav", "m4b"];

function startJob(opts: TtsJobInput): TtsJob {
  const id = crypto.randomBytes(6).toString("hex");
  // С1: refFile — только имя ref_* внутри storage/tts (клиент не доверенный).
  const refFile = String(opts.refFile || "").replace(/^.*[\\/]/, "");
  if (!/^ref_[A-Za-z0-9._-]+$/.test(refFile)) throw new Error("invalid_reference");
  if (!fs.existsSync(path.join(DIRS.tts, refFile))) throw new Error("reference_not_found");
  const engine = opts.engine === "xtts" ? "xtts" : "f5";

  // Чанки приходят готовыми из Batch Editor UI; если их нет — режем на сервере.
  let items: TtsItem[] =
    Array.isArray(opts.chunks) && opts.chunks.length
      ? (opts.chunks as Array<string | TtsItem>)
          .map((c) => (typeof c === "string" ? { text: c } : c))
          .filter((c) => c.text || c.pauseMs)
      : ruNlp.chunkText(
          ruNlp.normalize(opts.text || "", {
            expandNumbers: opts.expandNumbers !== false,
            yoficate: opts.yoficate !== false,
            markStress: !!opts.markStress,
          }),
          ENGINE_CHUNK_LIMIT[engine],
        );
  // Лимит движка нужен и для готовых чанков: в UI их объединяют и правят руками,
  // и после «объединить» длина легко перебирает лимит (у XTTS — 400 токенов на
  // проход, см. splitLongItem). Режем тем же chunkText, что и автонарезку.
  items = items.flatMap((c) => splitLongItem(c, ENGINE_CHUNK_LIMIT[engine]));
  items = items.slice(0, 4000);
  if (!items.length) throw new Error("empty_text");

  const job: TtsJob = {
    id,
    engine,
    stage: "queued",
    progress: 0,
    chunkIndex: 0,
    chunksTotal: items.length,
    error: "",
    done: false,
    outFile: "",
    outSize: 0,
    createdAt: Date.now(),
    vram: null,
    items,
    // Грубая оценка длительности для глав: ~75 знаков/мин чтения вслух ≈ 80 мс/симв.
    estimateTotalMs: Math.max(
      1000,
      items.reduce((s, i) => s + (i.text?.length || 0), 0) * 80 +
        items.reduce((s, i) => s + (i.pauseMs || 0), 0),
    ),
    opts: {
      refFile,
      // Движок считает русским всегда (см. TTS_LANGUAGE). Поле осталось в снимке
      // задания, чтобы это было видно в логе и в /tts/<id>, но из интерфейса,
      // настроек и профилей оно больше не берётся.
      language: TTS_LANGUAGE,
      // Глобальные
      precision: PRECISIONS.includes(String(opts.precision)) ? String(opts.precision) : "float16",
      attention: ATTENTIONS.includes(String(opts.attention)) ? String(opts.attention) : "sdpa",
      gcEveryChunks: Math.max(1, Number(opts.gcEveryChunks) || 1),
      // F5
      nfe: Math.max(16, Math.min(100, Number(opts.nfe) || 32)),
      cfg: Math.max(1.0, Math.min(10.0, Number(opts.cfg) || 2.2)),
      solver: SOLVERS.includes(String(opts.solver)) ? String(opts.solver) : "euler",
      exaggeration: Math.max(0.5, Math.min(2.0, Number(opts.exaggeration) || 1.0)),
      // XTTS
      temperature: Math.max(0.01, Math.min(1.5, Number(opts.temperature) || 0.7)),
      repetitionPenalty: Math.max(1.0, Math.min(15.0, Number(opts.repetitionPenalty) || 3.5)),
      topK: Math.max(1, Math.min(100, Number(opts.topK) || 50)),
      topP: Math.max(0.05, Math.min(1.0, Number(opts.topP) || 0.85)),
      // Общие
      speed: Math.max(0.5, Math.min(2.0, Number(opts.speed) || 1.0)),
      crossFadeMs: Math.max(0, Math.min(500, Number(opts.crossFadeMs) || 60)),
      sentencePauseMs: Math.max(100, Math.min(1500, Number(opts.sentencePauseMs) || 400)),
      paragraphPauseMs: Math.max(500, Math.min(3000, Number(opts.paragraphPauseMs) || 1200)),
      loudnessTarget: Math.max(-24, Math.min(-10, Number(opts.loudnessTarget) || -16)),
      format: FORMATS.includes(String(opts.format)) ? String(opts.format) : "mp3",
      title: String(opts.title || "Audiobook").slice(0, 120),
      author: String(opts.author || "").slice(0, 120),
      coverImage: typeof opts.coverImage === "string" ? opts.coverImage.slice(0, 3_000_000) : null,
      // NLP-опции (для серверного чанкинга если чанков не прислали)
      expandNumbers: opts.expandNumbers !== false,
      yoficate: opts.yoficate !== false,
      markStress: !!opts.markStress,
    },
  };
  jobs.set(id, job);
  trimJobs(jobs, JOB_LIMIT);
  queue.enqueue(() => runPipeline(job));
  return job;
}

function getJob(id: string): TtsJob | null {
  return jobs.get(id) || null;
}

/**
 * Отменить активное задание озвучки: раньше отменить рендер было нельзя
 * вообще (см. AUDIT_REPORT.md, раздел 10) — единственный способ остановить
 * долгую генерацию был закрыть приложение целиком (и процесс python с
 * моделью в VRAM оставался висеть в фоне).
 */
function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.cancelRequested = true;
  job._sidecar?.killHard();
  logger.action("tts.cancelled", { id });
  return true;
}

/* ------------------------- Пайплайн ------------------------- */

function spawnFFmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    detectFfmpeg()
      .then(({ ffmpeg }) => {
        if (!ffmpeg) return reject(new Error("ffmpeg_missing"));
        const child = spawn(ffmpeg, args, { windowsHide: true });
        let errTail = "";
        child.stderr.on("data", (d) => {
          errTail = (errTail + String(d)).slice(-3000);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errTail.slice(-200)}`)),
        );
      })
      .catch(reject);
  });
}

async function runPipeline(job: TtsJob): Promise<void> {
  // Сайдкар держим вне try: процесс python обязан завершиться и при ошибке —
  // иначе он остаётся в памяти и держит модель в VRAM (см. finally).
  let sidecar: EngineSidecar | null = null;
  try {
    const cfg = job.opts;
    job.stage = "model_load";
    job.progress = 1;
    // Предполётная проверка окружения ДО спавна движка: без неё пользователь
    // ждал загрузку модели и получал «Ошибка рендера: No module named 'torch'».
    await assertPythonEnv(job);
    // Ударения по смыслу (RUAccent) — ДО загрузки модели: шаг необязательный,
    // при недоступности рендер идёт на исходных текстах (см. accentItems).
    // `accented` выровнен по job.items, поэтому в цикле берётся по индексу.
    const accented = cfg.markStress ? await accentItems(job) : null;
    job.stress = {
      requested: !!cfg.markStress,
      applied: !!accented,
      reason: accented ? "" : stressFailReason,
    };
    sidecar = new EngineSidecar(job.engine)._start();
    job._sidecar = sidecar;
    // Монитор VRAM приходит отдельными сообщениями (не ответом на запрос).
    sidecar.onEvent = (msg) => {
      if (msg.type === "vram") job.vram = msg;
    };
    const chunkDir = path.join(DIRS.tts, job.id);
    fs.mkdirSync(chunkDir, { recursive: true });
    job.progress = 2;

    // init: модель в VRAM один раз на всё задание
    // Путь к ffmpeg передаём сайдкару: f5-tts декодирует референс через pydub, а
    // pydub запускает `ffmpeg` по имени (то есть ищет в PATH) — без этого рендер
    // падал с «[WinError 2] Не удается найти указанный файл» на первом чанке.
    const ff = await detectFfmpeg().catch(() => null);
    // Таймаут init — 20 минут вместо 10: первый запуск F5 скачивает русский
    // чекпоинт (~1.29 ГБ, см. RU_MODEL в server/engines/f5_wrapper.py), и на
    // медленном канале десяти минут не хватало — задание падало по таймауту
    // уже ПОСЛЕ скачивания, а сайдкар продолжал жить.
    const ready = await sidecar.ask(
      {
        type: "init",
        precision: cfg.precision,
        attention: cfg.attention,
        solver: cfg.solver,
        speed: cfg.speed,
        vramBudgetGb: 4.5,
        gcEveryChunks: cfg.gcEveryChunks,
        ffmpeg: ff?.ffmpeg || "",
      },
      "ready",
      1200000,
    );
    if (ready.type === "error") throw new Error(ready.message);
    // Какую модель реально загрузил движок. У F5 это русский дообученный
    // чекпоинт (см. RU_MODEL в server/engines/f5_wrapper.py), но он мог не
    // скачаться — тогда считается базовая (en+zh), и по логу это видно сразу,
    // а не после прослушивания готовой книги.
    if (ready.model) {
      logger.info("tts.model", {
        engine: job.engine,
        model: ready.model,
        error: ready.modelError || null,
        license: ready.modelLicense || null,
      });
    }

    job.stage = "infer";
    const refPath = path.join(DIRS.tts, cfg.refFile);
    const wavs: Array<{ wav: string; pauseMs: number }> = [];

    for (let i = 0; i < job.items.length; i++) {
      if (job.cancelRequested) throw new Error("cancelled");
      const item = job.items[i];
      if (item.pauseMs && !item.text) continue; // чистая пауза — на этапе склейки
      const wav = path.join(chunkDir, `chunk_${String(wavs.length).padStart(4, "0")}.wav`);
      const msg = await sidecar.ask(
        {
          type: "infer",
          ref: refPath,
          // Текст с расставленными ударениями («+» перед гласной). XTTS такие
          // знаки не понимает и снимает их сам (drop_stress в xtts_wrapper.py),
          // F5 отдаёт их русской модели как есть.
          text: accented ? accented[i] : item.text,
          out: wav,
          cfg: cfg.cfg,
          nfe: cfg.nfe,
          exaggeration: cfg.exaggeration,
          temperature: cfg.temperature,
          repetitionPenalty: cfg.repetitionPenalty,
          topK: cfg.topK,
          topP: cfg.topP,
          speed: cfg.speed,
          // Язык специально НЕ передаём: движок берёт его из своей константы
          // (server/engines/xtts_wrapper.py → LANGUAGE). Раньше здесь уезжало
          // значение из настроек, и русский текст считался английским.
        },
        "done",
        600000,
      );
      if (msg.type === "error") throw new Error(msg.message);
      job.chunkIndex = i;
      job.progress = Math.round((85 * (i + 1)) / job.items.length);
      wavs.push({ wav, pauseMs: item.pauseMs || 0 });
    }
    if (!wavs.length) throw new Error("empty_result");
    // Модель больше не нужна: закрываем python до склейки и мастеринга, чтобы он не
    // держал VRAM во время работы ffmpeg.
    sidecar.kill();
    sidecar = null;

    // --- Склейка: паузы (anullsrc) + кроссфейд между чанками ---
    job.stage = "stitch";
    job.progress = 88;
    const stitched = path.join(chunkDir, "stitched.wav");
    await stitchWavs(
      wavs.map((w) => w.wav),
      wavs.map((w) => w.pauseMs),
      cfg.crossFadeMs,
      stitched,
    );

    // --- EBU R128 мастеринг + финальный формат ---
    job.stage = "master";
    job.progress = 94;
    // Частоту дискретизации задаём ЯВНО: фильтр loudnorm считает на 192 кГц и без
    // `-ar` отдаёт этот же 192 кГц в кодировщик — WAV раздувался в 8 раз (25 с
    // речи весили 9.7 МБ, а рендер в 6 минут — 33 МБ), AAC — в 4 раза. Оба движка
    // (XTTS и F5) синтезируют на 24 кГц, поэтому WAV пишем в родной частоте, а
    // m4b/mp3 — в стандартные 44.1 кГц.
    const loudnorm = `loudnorm=I=${cfg.loudnessTarget}:TP=-1.5:LRA=11`;
    const outFile = path.join(DIRS.tts, `audiobook_${job.id}.${cfg.format}`);
    const tags = ["-metadata", `title=${cfg.title}`, "-metadata", `artist=${cfg.author}`];
    if (cfg.format === "wav") {
      await spawnFFmpeg([
        "-y",
        "-i",
        stitched,
        "-af",
        loudnorm,
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        ...tags,
        outFile,
      ]);
    } else {
      // MP3 (id3v2) / M4B (AAC): главы через ffmetadata; фолбэк — без глав.
      const metaFile = path.join(chunkDir, "meta.txt");
      fs.writeFileSync(metaFile, buildFfmetadata(job), "utf8");
      const codec =
        cfg.format === "m4b"
          ? ["-c:a", "aac", "-b:a", "128k", "-ar", "44100"]
          : ["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-id3v2_version", "3"];
      await spawnFFmpeg([
        "-y",
        "-i",
        stitched,
        "-i",
        metaFile,
        "-map_metadata",
        "1",
        "-af",
        loudnorm,
        ...codec,
        ...tags,
        outFile,
      ]).catch(async () => {
        await spawnFFmpeg(["-y", "-i", stitched, "-af", loudnorm, ...codec, ...tags, outFile]);
      });
    }

    // Чанки больше не нужны
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(outFile)) throw new Error("render_no_output");

    job.outFile = outFile;
    job.outSize = fs.statSync(outFile).size;
    job.progress = 100;
    job.done = true;
    job.stage = "done";
    logger.info("tts.done", { id: job.id, chunks: job.items.length, size: job.outSize });
  } catch (e) {
    if (job.cancelRequested) {
      job.error = "cancelled";
      job.stage = "stopped";
    } else {
      // Ошибку сайдкара приводим к машинному коду: страница «Голос» показывает по
      // job.envError понятный текст и команду установки вместо «No module named…».
      job.error = envAwareError(job, (e as Error)?.message || e).message;
      job.stage = "error";
      logger.error("tts.error", { id: job.id, error: job.error, env: job.envError || null });
    }
  } finally {
    // Процесс python снимаем ВСЕГДА: при ошибке он раньше оставался жить (модель
    // висела в VRAM, а в диспетчере задач копился лишний python с torch/numpy).
    // При успехе sidecar уже закрыт выше и здесь его нет.
    if (sidecar) sidecar.kill();
    job._sidecar = null;
  }
}

// Склейка с паузами и кроссфейдом.
async function stitchWavs(
  wavs: string[],
  pauses: number[],
  crossFadeMs: number,
  outFile: string,
): Promise<void> {
  const n = wavs.length;
  if (n === 1) {
    await spawnFFmpeg(["-y", "-i", wavs[0], outFile]);
    return;
  }
  const hasPauses = pauses.some((p) => p > 0);
  if (!hasPauses) {
    const inputs = wavs.flatMap((w) => ["-i", w]);
    let fc = "",
      prev = "0:a";
    const d = (crossFadeMs / 1000).toFixed(3);
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? "out" : `a${i}`;
      fc += `[${prev}][${i}:a]acrossfade=d=${d}:c1=tri:c2=tri[${out}];`;
      prev = out;
    }
    await spawnFFmpeg(["-y", ...inputs, "-filter_complex", fc, "-map", "[out]", outFile]);
    return;
  }
  // С паузами: anullsrc-вставки между чанками + concat.
  const inputs: string[] = [];
  const concatParts: string[] = [];
  let inputIdx = 0;
  wavs.forEach((w, i) => {
    inputs.push("-i", w);
    concatParts.push(`[${inputIdx}:a]`);
    inputIdx++;
    if (pauses[i] > 0) {
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=24000:cl=mono:d=${(pauses[i] / 1000).toFixed(3)}`,
      );
      concatParts.push(`[${inputIdx}:a]`);
      inputIdx++;
    }
  });
  const fc = `${concatParts.join("")}concat=n=${concatParts.length}:v=0:a=1[out]`;
  await spawnFFmpeg(["-y", ...inputs, "-filter_complex", fc, "-map", "[out]", outFile]);
}

// ffmetadata с главами (для M4B / MP3). Длительность — оценка из счётчика чанков.
function buildFfmetadata(job: TtsJob): string {
  const cfg = job.opts;
  let t = ";FFMETADATA1\n";
  t += `title=${cfg.title}\n`;
  if (cfg.author) t += `artist=${cfg.author}\n`;
  const textChunks = job.items.filter((i) => i.text).length;
  const perChunkMs = Math.max(
    1000,
    (job.estimateTotalMs || textChunks * 12000) / Math.max(1, textChunks),
  );
  const groupsPerChapter = Math.max(1, Math.ceil(textChunks / 50));
  let start = 0;
  for (let g = 0; g * groupsPerChapter < textChunks; g++) {
    const count = Math.min(groupsPerChapter, textChunks - g * groupsPerChapter);
    const end = start + count * perChunkMs;
    t += "\n[CHAPTER]\nTIMEBASE=1/1000\n";
    t += `START=${Math.round(start)}\nEND=${Math.round(end)}\n`;
    t += `title=Часть ${g + 1}\n`;
    start = end;
  }
  return t;
}

/* ------------------------- Preview / NLP / Reveal ------------------------- */

// Предпросмотр чанков без генерации (для Batch Editor UI).
function previewChunks(
  text: unknown,
  engine: unknown,
  nlpOpts?: ruNlp.NormalizeOptions,
): ruNlp.Chunk[] {
  const e = engine === "xtts" ? "xtts" : "f5";
  const normalized = ruNlp.normalize(text, nlpOpts || {});
  return ruNlp.chunkText(normalized, ENGINE_CHUNK_LIMIT[e]);
}

function revealInExplorer(filePath: unknown): boolean {
  const p = String(filePath || "");
  if (!p.startsWith(DIRS.tts) || p.includes("..")) throw new Error("forbidden_path");
  if (process.platform === "win32") {
    spawn("explorer", ["/select,", p], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", p], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [path.dirname(p)], { detached: true, stdio: "ignore" }).unref();
  }
  return true;
}

export {
  jobs,
  startJob,
  getJob,
  cancelJob,
  detectHardware,
  pythonEnv,
  previewChunks,
  revealInExplorer,
  saveProfile,
  deleteProfile,
  loadProfiles,
  listPresets,
  saveUserPreset,
  deleteUserPreset,
};

// --- Диспетчер фоновых задач (server/ts/taskRegistry.ts) ---
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskRegistry = require("./taskRegistry") as typeof import("./taskRegistry");
taskRegistry.registerProvider({
  engine: "tts",
  list: () =>
    [...jobs.values()].map((j) => {
      // j.done остаётся false при stage "error"/"stopped" (это НЕ "успех") —
      // для Task Manager важно только "активна ли задача ещё".
      const finished = j.done || j.stage === "error" || j.stage === "stopped";
      return {
        id: j.id,
        engine: "tts",
        label: j.opts?.title || j.id,
        stage: j.stage,
        progress: Math.round(j.progress || 0),
        createdAt: j.createdAt,
        done: finished,
        error: j.error || null,
        canCancel: !finished,
        canPause: false,
        paused: false,
      };
    }),
  cancel: (id) => cancelJob(id),
});
