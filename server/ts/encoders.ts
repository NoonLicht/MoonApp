/**
 * Реестр энкодеров + детекция железа для видеосжатия.
 *
 * Принцип «встроенного движка» (zero external steps):
 *  - База — FFmpeg: программные энкодеры (libsvtav1, libx265, libx264,
 *    libaom-av1) и аппаратные привязки (av1_nvenc, hevc_qsv, h264_amf и т.д.)
 *    уже внутри бинаря, ничего дополнительно ставить не нужно.
 *  - Опциональные обёртки (rigaya NVEncC/QSVEncC/VCEEncC, Av1an, rav1e)
 *    обнаруживаются, если бинарь лежит в storage/bin или в PATH: обёртки
 *    «встроены» в архитектуру (вызываются из одного реестра), но не требуют
 *    от пользователя никаких ручных шагов.
 *  - Graceful fallback: недоступный метод отбрасывается, пайплайн откатывается
 *    к следующему кандидату и в итоге — к CPU FFmpeg (см. compressor.js).
 *
 * TS-исходник, как server/ts/convertEngine.ts: компилируется в server/encoders.js
 * командой `npm run compile:server`, поэтому `require("./encoders")` из
 * server/compressor.js и server/routes/compressor.js работает без изменений.
 */
import { execFile, spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import config from "./config";
import { detectFfmpeg } from "./convertEngine";
import logger from "./logger";

const { DIRS } = config;

// --- Запуск команды с таймаутом, возвращает stdout или "" ---
function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? "" : String(stdout || ""));
      });
    } catch {
      resolve("");
    }
  });
}

// --- Кэши детекции (железо не меняется на лету) ---
let hwCache: HwInfo | null = null;
let hwAt = 0;
const HW_TTL = 60_000;
let binCache: Record<string, string | null> | null = null;
let binAt = 0;
let encListCache: { ffmpeg: string; set: Set<string> } | null = null; // список энкодеров ffmpeg (перезагружается при смене ffmpeg)

/** GPU: вендор + имя + тир аппаратного кодека ("" — только софт). */
export interface GpuInfo {
  vendor: string;
  name: string;
  tier: string;
}

// --- GPU: NVIDIA (nvidia-smi), затем общий список через WMI ---
async function detectGpus(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  // nvidia-smi отдаёт точное имя + работает только если есть NVIDIA.
  const smi = await run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 3000);
  if (smi) {
    for (const line of smi.split(/\r?\n/)) {
      const name = line.trim();
      if (name) gpus.push({ vendor: "nvidia", name, tier: nvidiaTier(name) });
    }
  }
  if (!gpus.length && /^win/i.test(process.platform)) {
    // WMI: все видеоадаптеры (Windows). Вне Windows — пусто, CPU-режим.
    const wmic = await run("wmic", ["path", "win32_VideoController", "get", "name"], 5000);
    for (const line of wmic.split(/\r?\n/)) {
      const name = line.trim();
      if (!name || /VideoController|^-*$/i.test(name)) continue;
      gpus.push({ vendor: gpuVendor(name), name, tier: classifyGpu(name) });
    }
  }
  return gpus;
}

export function gpuVendor(name: string): string {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return "nvidia";
  if (/intel|arc|iris|uhd graphics|hd graphics/i.test(name)) return "intel";
  if (/amd|radeon|rx \d|vega/i.test(name)) return "amd";
  return "unknown";
}

// Тир аппаратного AV1: NVIDIA Ada (RTX 40xx)/Blackwell (50xx), Intel Arc,
// AMD RDNA2/3 (RX 6xxx/7xxx/9xxx). На них аппаратный AV1 — рекомендуемый путь.
export function classifyGpu(name: string): string {
  if (/arc a\d/i.test(name)) return "av1";
  if (/radeon rx (6[0-9]{3}|7[0-9]{3}|9[0-9]{3})/i.test(name)) return "av1";
  return nvidiaTier(name);
}

function nvidiaTier(name: string): string {
  if (/rtx (4|5)\d{3}/i.test(name)) return "av1"; // Ada/Blackwell: AV1 NVENC
  if (/rtx \d{3,4}|gtx 1\d{3}/i.test(name)) return "hevc"; // Turing+: HEVC/H.264 NVENC
  if (/nvidia|geforce|quadro/i.test(name)) return "h264";
  return "";
}

// --- CPU ---
// --- Опциональные бинари: rigaya-обёртки, Av1an, rav1e ---
// Ищем в storage (и storage/bin) или в PATH. От пользователя шагов не требуется:
// если бинаря нет — метод помечается недоступным и пайплайн идёт через FFmpeg.
interface BinSpec {
  file: RegExp;
  cmd: string;
  verArgs: string[];
}

const EXTERNAL_BINS: Record<string, BinSpec> = {
  nvencc: { file: /^NVEncC(64)?\.exe$/i, cmd: "NVEncC64", verArgs: ["--version"] },
  qsvencc: { file: /^QSVEncC(64)?\.exe$/i, cmd: "QSVEncC64", verArgs: ["--version"] },
  vceencc: { file: /^VCEEncC(64)?\.exe$/i, cmd: "VCEEncC64", verArgs: ["--version"] },
  av1an: { file: /^av1an(\.exe)?$/i, cmd: "av1an", verArgs: ["--version"] },
  rav1e: { file: /^rav1e(\.exe)?$/i, cmd: "rav1e", verArgs: ["--version"] },
};

function findExeInBinDir(dir: string, re: RegExp): string | null {
  try {
    if (!fs.existsSync(dir)) return null;
    for (const name of fs.readdirSync(dir)) {
      if (re.test(name)) return path.join(dir, name);
      const nested = path.join(dir, name);
      // некоторые архивы кладут exe во вложенную папку
      try {
        if (fs.statSync(nested).isDirectory()) {
          for (const n2 of fs.readdirSync(nested)) if (re.test(n2)) return path.join(nested, n2);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
export async function detectExternalBins(): Promise<Record<string, string | null>> {
  if (binCache && Date.now() - binAt < HW_TTL) return binCache;
  const out: Record<string, string | null> = {};
  for (const [id, spec] of Object.entries(EXTERNAL_BINS)) {
    let exe: string | null =
      findExeInBinDir(DIRS.storage, spec.file) ||
      findExeInBinDir(path.join(DIRS.storage, "bin"), spec.file);
    if (!exe) {
      // PATH-проверка: бинарь отвечает на --version?
      const ver = await run(spec.cmd, spec.verArgs, 5000);
      if (ver) exe = spec.cmd;
    } else {
      const ver = await run(exe, spec.verArgs, 5000);
      if (!ver) exe = null; // найден файлом, но не запускается — считаем отсутствующим
    }
    out[id] = exe; // абсолютный путь / имя команды или null
  }
  binCache = out;
  binAt = Date.now();
  logger.info("encoders.externals", {
    found: Object.entries(out)
      .filter(([, v]) => v)
      .map(([k]) => k),
  });
  return out;
}

// --- Список энкодеров конкретной сборки FFmpeg ---
function ffmpegEncoderSet(ffmpegPath: string): Promise<Set<string>> {
  if (encListCache && encListCache.ffmpeg === ffmpegPath) return Promise.resolve(encListCache.set);
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-encoders"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => resolve(new Set()));
    child.on("close", () => {
      const set = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*[VAS][.\w]*\s+(\S+)/.exec(line);
        if (m) set.add(m[1]);
      }
      encListCache = { ffmpeg: ffmpegPath, set };
      resolve(set);
    });
  });
}

/**
 * Список энкодеров текущей сборки FFmpeg — «лёгкий» путь без детекции железа
 * (только сам бинарь + кэш его `-encoders`). Нужен плееру: он выбирает рабочий
 * H.264-энкодер для перекодирования на лету, а в части сборок libx264 отключён
 * (`--disable-libx264`), поэтому жёсткое `-c:v libx264` роняло транскод.
 */
export async function ffmpegEncoders(): Promise<Set<string>> {
  const ff = await detectFfmpeg();
  if (!ff.found || !ff.ffmpeg) return new Set<string>();
  return ffmpegEncoderSet(ff.ffmpeg);
}

/** Доступность методов сжатия на текущей машине (для UI и рекомендателя). */
export interface HwMethods {
  svtav1: boolean;
  x265: boolean;
  x264: boolean;
  aom: boolean;
  rav1e: boolean;
  av1an: boolean;
  nvenc: boolean;
  qsv: boolean;
  amf: boolean;
  nvencc: boolean;
  qsvencc: boolean;
  vceencc: boolean;
}

/** Сводка железа: ffmpeg, CPU, GPU, внешние бинари, список энкодеров и методы. */
export interface HwInfo {
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  cpu: { name: string; coresPhysical: number; coresLogical: number };
  gpus: GpuInfo[];
  externals: Record<string, string | null>;
  ffmpegEncoders: string[];
  methods: HwMethods;
}

// --- Сводка доступности всех методов (для UI и рекомендателя) ---
export async function detectAll({ force = false }: { force?: boolean } = {}): Promise<HwInfo> {
  if (!force && hwCache && Date.now() - hwAt < HW_TTL) return hwCache;
  const ff = await detectFfmpeg();
  const encoders = ff.found && ff.ffmpeg ? await ffmpegEncoderSet(ff.ffmpeg) : new Set<string>();
  const [gpus, externals] = await Promise.all([detectGpus(), detectExternalBins()]);
  const has = (e: string) => encoders.has(e);
  const methods: HwMethods = {
    // CPU (внутри ffmpeg — программные энкодеры сборки)
    svtav1: has("libsvtav1"),
    x265: has("libx265"),
    x264: has("libx264"),
    aom: has("libaom-av1"),
    // CPU (отдельные бинари)
    rav1e: !!externals.rav1e,
    av1an: !!externals.av1an,
    // GPU через ffmpeg (энкодер есть в сборке; реально работает только при
    // наличии GPU — вендор подтверждается выше, финальный арбитр — fallback)
    nvenc: has("av1_nvenc") || has("hevc_nvenc") || has("h264_nvenc"),
    qsv: has("av1_qsv") || has("hevc_qsv") || has("h264_qsv"),
    amf: has("av1_amf") || has("hevc_amf") || has("h264_amf"),
    // GPU через rigaya-обёртки
    nvencc: !!externals.nvencc,
    qsvencc: !!externals.qsvencc,
    vceencc: !!externals.vceencc,
  };
  hwCache = {
    ffmpeg: { found: ff.found, path: ff.ffmpeg, version: ff.version },
    cpu: detectCpu(),
    gpus,
    externals,
    ffmpegEncoders: [...encoders],
    methods,
  };
  hwAt = Date.now();
  return hwCache;
}
/** Рекомендация метода сжатия под железо (её показывает UI на странице «Сжатие»). */
export interface Recommendation {
  engine: string;
  codec: string;
  qualityMode: string;
  crf: number;
  speed: string;
  hwName: string;
  reason: string;
}

// --- Рекомендатель метода под железо ---
// Приоритет: современный GPU (аппаратный AV1 — near-software quality, в разы
// быстрее) → многоядерный CPU (SVT-AV1/Av1an — максимум качества на бит)
// → совместимость (x264).
export async function recommend(): Promise<Recommendation> {
  const hw = await detectAll();
  const av1Gpu = hw.gpus.find((x) => x.tier === "av1");
  const anyGpu = hw.gpus[0];
  if (av1Gpu && av1Gpu.vendor === "nvidia" && hw.methods.nvenc) {
    return {
      engine: "nvenc",
      codec: "av1",
      qualityMode: "crf",
      crf: 26,
      speed: "P5",
      hwName: av1Gpu.name,
      reason: "gpuAv1",
    };
  }
  if (av1Gpu && av1Gpu.vendor === "intel" && hw.methods.qsv) {
    return {
      engine: "qsv",
      codec: "av1",
      qualityMode: "crf",
      crf: 26,
      speed: "medium",
      hwName: av1Gpu.name,
      reason: "gpuAv1",
    };
  }
  if (av1Gpu && av1Gpu.vendor === "amd" && hw.methods.amf) {
    return {
      engine: "amf",
      codec: "av1",
      qualityMode: "crf",
      crf: 26,
      speed: "balanced",
      hwName: av1Gpu.name,
      reason: "gpuAv1",
    };
  }
  if (hw.methods.svtav1 && hw.cpu.coresLogical >= 8) {
    const engine = hw.externals.av1an ? "av1an" : "svtav1";
    return {
      engine,
      codec: "av1",
      qualityMode: "crf",
      crf: 24,
      speed: "6",
      hwName: hw.cpu.name,
      reason: "cpuMulti",
    };
  }
  if (anyGpu && hw.methods.nvenc) {
    return {
      engine: "nvenc",
      codec: "hevc",
      qualityMode: "crf",
      crf: 26,
      speed: "P5",
      hwName: anyGpu.name,
      reason: "gpuHevc",
    };
  }
  return {
    engine: "x264",
    codec: "h264",
    qualityMode: "crf",
    crf: 22,
    speed: "medium",
    hwName: hw.cpu.name,
    reason: "compat",
  };
}
// --- Оптимальные диапазоны (для UI-бейджей «optimal») ---
export const OPTIMAL = {
  crf: { av1: [22, 28], hevc: [20, 24], h264: [18, 22] },
  cqp: { av1: [24, 28], hevc: [24, 28], h264: [22, 26] },
  // Mbps AV1; HEVC примерно −30%, H.264 примерно +50% (UI учитывает множитель)
  bitrate: { 2160: [8, 12], 1440: [5, 8], 1080: [2.5, 4], 720: [1.2, 2.5], 480: [0.6, 1.2] },
  speed: {
    svtav1: [4, 6],
    aom: [4, 6],
    x265: ["medium", "slow"],
    x264: ["fast", "medium"],
    nvenc: ["P4", "P6"],
    qsv: ["fast", "slow"],
    amf: ["balanced"],
  },
};

// Скоростные шкалы по энкодеру: от «архивного» к «черновику».
export const SPEED_SCALES: Record<string, string[]> = {
  svtav1: ["0", "2", "4", "6", "8", "10", "13"],
  aom: ["0", "2", "4", "6", "8"],
  x265: [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
  ],
  x264: [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
  ],
  nvenc: ["P1", "P2", "P3", "P4", "P5", "P6", "P7"],
  qsv: ["veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
  amf: ["speed", "balanced", "quality"],
  rigaya: ["--fastest", "default", "--slowest"],
};

// Кодек → ключ определения доступности метода из hw.methods.
export const METHOD_FFMPEG_ENC: Record<string, Record<string, string[]>> = {
  // [кодек]: [энкодеры ffmpeg в порядке предпочтения]
  svtav1: { av1: ["libsvtav1"] },
  aom: { av1: ["libaom-av1"] },
  x265: { hevc: ["libx265"] },
  x264: { h264: ["libx264", "libopenh264"] },
  rav1e: { av1: ["librav1e"] },
  nvenc: {
    av1: ["av1_nvenc", "hevc_nvenc", "h264_nvenc"],
    hevc: ["hevc_nvenc", "h264_nvenc"],
    h264: ["h264_nvenc"],
  },
  qsv: {
    av1: ["av1_qsv", "hevc_qsv", "h264_qsv"],
    hevc: ["hevc_qsv", "h264_qsv"],
    h264: ["h264_qsv"],
  },
  amf: {
    av1: ["av1_amf", "hevc_amf", "h264_amf"],
    hevc: ["hevc_amf", "h264_amf"],
    h264: ["h264_amf"],
  },
};

function detectCpu(): { name: string; coresPhysical: number; coresLogical: number } {
  const cpus = os.cpus();
  return {
    name: cpus.length ? cpus[0].model.trim() : "CPU",
    coresPhysical: cpus.length >= 2 ? Math.max(1, Math.floor(cpus.length / 2)) : 1,
    coresLogical: cpus.length,
  };
}
