/**
 * Менеджер движка whisper.cpp: сборки (CPU/BLAS/CUDA), модели и выбор устройства.
 *
 * Зачем отдельный модуль: до этого пути к бинарнику и модели были захардкожены
 * в server/lecture.js («автопоиск в storage/whisper»), поэтому пользователь не
 * мог ни выбрать модель поточнее, ни включить видеокарту. Здесь живёт ЕДИНЫЙ
 * источник истины:
 *   • каталог моделей (tiny … large-v3 + q5-кванты) со скачиванием и прогрессом;
 *   • каталог сборок движка (CPU, CPU+OpenBLAS, CUDA 11.8, CUDA 12.4) — каждая
 *     ставится в свой подкаталог storage/whisper/builds/<id>, чтобы сборки не
 *     затирали друг друга и можно было переключаться без переустановки;
 *   • детект GPU (nvidia-smi + WMI) и выбор флагов запуска (-ng / -dev N);
 *   • self-test: прогон модели на синтетическом WAV — показывает, какая сборка
 *     реально поднялась (CUDA/CPU) и не падает ли она на этом железе.
 *
 * ВАЖНО: официальные Windows-сборки whisper.cpp для x64 выходят только под
 * CUDA 11.8/12.4 (Vulkan x64 в релизах нет). Поэтому «видеокарта» здесь =
 * CUDA-сборка + NVIDIA GPU; для остальных карт движок остаётся на CPU.
 *
 * TS-исходник, как server/ts/diarize.ts: компилируется в server/whisperEngine.js
 * командой `npm run compile:server`, поэтому `require("./whisperEngine")` из
 * обычных .js-модулей (lecture.js, routes/lecture.js) работает без изменений.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execFile } from "child_process";
import config from "./config";
import settings from "./settings";
import logger from "./logger";
import { downloadToFile } from "./download";
import { createSetupTask } from "./setupTask";
import type { SetupTaskState } from "./setupTask";

const { DIRS } = config;

/* ------------------------- Пути ------------------------- */

const WHISPER_DIR = path.join(DIRS.storage, "whisper");
const BUILDS_DIR = path.join(WHISPER_DIR, "builds");
const MODELS_DIR = path.join(WHISPER_DIR, "models");
const DL_DIR = path.join(WHISPER_DIR, "_dl");
const TMP_DIR = path.join(DIRS.tmp, "whisper");

/** Версия движка. Держать в синхроне с scripts/fetch-whisper.js. */
const WHISPER_TAG = "b5130";
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`;
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/* ------------------------- Каталоги ------------------------- */

/** Модель до добавления URL скачивания. */
interface ModelEntry {
  id: string;
  file: string;
  sizeMb: number;
  note: string;
}

/** Модель каталога: к записи добавлен URL на HuggingFace. */
interface ModelCatalogEntry extends ModelEntry {
  url: string;
}

/** Состояние модели для UI (modelsList/modelInfo). */
interface ModelInfo {
  id: string;
  file: string;
  sizeMb: number;
  note: string;
  url: string;
  downloaded: boolean;
  downloadedMb: number;
}

/**
 * Модели Whisper. `note` — ключ перевода lecture.setup.note.<note>,
 * `sizeMb` — ориентир для UI (реальный вес файла показывает downloadedMb).
 */
const MODEL_CATALOG: ModelCatalogEntry[] = (
  [
    { id: "tiny", file: "ggml-tiny.bin", sizeMb: 74, note: "fast" },
    { id: "base", file: "ggml-base.bin", sizeMb: 141, note: "fast" },
    { id: "small", file: "ggml-small.bin", sizeMb: 466, note: "balanced" },
    { id: "medium-q5_0", file: "ggml-medium-q5_0.bin", sizeMb: 514, note: "quantized" },
    { id: "medium", file: "ggml-medium.bin", sizeMb: 1463, note: "accurate" },
    {
      id: "large-v3-turbo-q5_0",
      file: "ggml-large-v3-turbo-q5_0.bin",
      sizeMb: 547,
      note: "quantized",
    },
    { id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", sizeMb: 1549, note: "turbo" },
    { id: "large-v3-q5_0", file: "ggml-large-v3-q5_0.bin", sizeMb: 1031, note: "quantized" },
    { id: "large-v3", file: "ggml-large-v3.bin", sizeMb: 2952, note: "max" },
  ] as ModelEntry[]
).map((m) => ({ ...m, url: `${MODEL_URL}/${m.file}` }));

/** Сборка до добавления URL и каталога установки. */
interface BuildEntry {
  id: string;
  zipName: string;
  sizeMb: number;
  gpu: boolean;
  cuda?: string;
  note: string;
}

/** Сборка каталога: URL архива и её каталог в storage/whisper/builds. */
interface BuildCatalogEntry extends BuildEntry {
  url: string;
  dir: string;
}

/** Состояние сборки для UI (buildsList/buildInfo/activeBuild). */
interface BuildInfo {
  id: string;
  note: string;
  gpu: boolean;
  cuda: string;
  sizeMb: number | null;
  installed: boolean;
  dir: string;
  bin: string | null;
  backend: string | null;
  /** Копия прямо в storage/whisper (её кладёт scripts/fetch-whisper.js). */
  legacy?: boolean;
  /** Сборка, выбранная пользователем по пути whisperBin. */
  custom?: boolean;
}

/**
 * Сборки движка. `gpu: true` — в архиве есть CUDA-бэкенд (ggml-cuda.dll),
 * поэтому сборка умеет считать на NVIDIA. `legacy` — уже установленная копия
 * прямо в storage/whisper (её кладёт scripts/fetch-whisper.js), не качается.
 */
const BUILD_CATALOG: BuildCatalogEntry[] = (
  [
    { id: "cpu", zipName: "whisper-bin-x64.zip", sizeMb: 8, gpu: false, note: "cpu" },
    { id: "blas", zipName: "whisper-blas-bin-x64.zip", sizeMb: 20, gpu: false, note: "blas" },
    {
      id: "cuda118",
      zipName: "whisper-cublas-11.8.0-bin-x64.zip",
      sizeMb: 260,
      gpu: true,
      cuda: "11.8",
      note: "cuda",
    },
    {
      id: "cuda124",
      zipName: "whisper-cublas-12.4.0-bin-x64.zip",
      sizeMb: 643,
      gpu: true,
      cuda: "12.4",
      note: "cuda",
    },
  ] as BuildEntry[]
).map((b) => ({ ...b, url: `${RELEASE_URL}/${b.zipName}`, dir: path.join(BUILDS_DIR, b.id) }));

const EXE_NAMES = ["whisper-cli.exe", "main.exe"];

/* ------------------------- Настройки ------------------------- */

/** Ключи настроек лекции, которые читает движок (settings.get("lecture")). */
interface LectureCfg {
  gpu?: unknown;
  build?: unknown;
  deviceId?: unknown;
  model?: unknown;
  modelId?: unknown;
  whisperBin?: unknown;
  prompt?: unknown;
  threads?: unknown;
  [key: string]: unknown;
}

/** Железо ПК для подсказок «лучше для вашего ПК» (detectSystem). */
interface SystemInfo {
  cpu: string;
  cores: number;
  threads: number;
  ramMb: number;
  platform: string;
  arch: string;
  gpuName: string;
  gpuMemoryMb: number;
  gpuVendor: string;
  cuda: boolean;
  blackwell: boolean;
  detected: boolean;
}

/** Требования модели к памяти (modelNeeds). */
interface ModelNeeds {
  ramMb: number;
  vramMb: number;
}

/** Подсказка «какая модель лучше для этого ПК» для UI. */
interface ModelAdvice {
  level: string;
  reason: string;
  gb: number;
  best: boolean;
}

/** Подсказка «какая сборка лучше для этого ПК» для UI. */
interface BuildAdvice {
  level: string;
  reason: string;
  best: boolean;
}

/** Сводка «ваш ПК» для панели настроек. */
interface SystemSummary {
  cpu: string;
  cores: number;
  threads: number;
  ramGb: number;
  gpu: string;
  gpuGb: number;
  cuda: boolean;
  blackwell: boolean;
  detected: boolean;
}

/** Краткий статус движка (шапка страницы лекций + engine внутри setupInfo). */
interface EngineSummary {
  ready: boolean;
  bin: string | null;
  model: string | null;
  modelId: string;
  backend: string | null;
  build: string | null;
  buildDir: string | null;
  buildCustom: boolean;
  gpu: string;
  deviceId: number;
  language: unknown;
  threads: number;
  activeSession: boolean;
  warnings: string[];
}

/** Итог self-test: какой бэкенд реально поднялся (verify). */
interface VerifyResult {
  ok: boolean;
  at: number;
  bin: string | null;
  model: string | null;
  modelId: string;
  build: string | null;
  backend: string | null;
  gpuUsed: boolean;
  computeCapability: string;
  elapsedMs: number;
  log: string;
  error: string;
}

/** Полная информация панели настроек движка (setupInfo). */
export interface SetupInfo {
  engine: EngineSummary;
  gpu: GpuInfo;
  builds: (BuildInfo & { active: boolean; recommend: BuildAdvice })[];
  models: (ModelInfo & { recommend: ModelAdvice })[];
  system: SystemSummary;
  task: SetupTaskState;
  verify: VerifyResult | null;
  tag: string;
  dirs: { whisper: string; models: string; builds: string };
}

/** Опции прогона whisper-cli: prompt=null — флага --prompt в команде не будет. */
interface TranscribeOptions {
  prompt?: string | null;
}

function cfg(): LectureCfg {
  return settings.get("lecture") as LectureCfg;
}

/** GPU выключён: и булевым значением (gpu: false), и строковым ("off"). */
function gpuDisabled(): boolean {
  const v = cfg().gpu;
  return v === false || v === "off" || v === "cpu";
}

/* ------------------------- Сборки ------------------------- */

function exeIn(dir: string): string | null {
  for (const name of EXE_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function dirHas(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Бэкенд сборки по её DLL (CUDA → Vulkan → OpenBLAS → чистый CPU). */
function backendOf(dir: string): string {
  if (dirHas(path.join(dir, "ggml-cuda.dll"))) return "cuda";
  if (dirHas(path.join(dir, "ggml-vulkan.dll"))) return "vulkan";
  if (dirHas(path.join(dir, "ggml-blas.dll"))) return "blas";
  return "cpu";
}

function buildInfo(entry: BuildCatalogEntry): BuildInfo {
  const bin = exeIn(entry.dir);
  return {
    id: entry.id,
    note: entry.note,
    gpu: !!entry.gpu,
    cuda: entry.cuda || "",
    sizeMb: entry.sizeMb,
    installed: !!bin,
    dir: entry.dir,
    bin,
    backend: bin ? backendOf(entry.dir) : null,
  };
}

/** Все сборки + «legacy»-копия в корне storage/whisper (если она есть). */
function buildsList(): BuildInfo[] {
  const list = BUILD_CATALOG.map(buildInfo);
  const legacyBin = exeIn(WHISPER_DIR);
  list.unshift({
    id: "legacy",
    note: "legacy",
    gpu: false,
    cuda: "",
    sizeMb: null,
    installed: !!legacyBin,
    dir: WHISPER_DIR,
    bin: legacyBin,
    backend: legacyBin ? backendOf(WHISPER_DIR) : null,
    legacy: true,
  });
  return list;
}

function findBuild(id: string): BuildInfo | null {
  return buildsList().find((b) => b.id === id) || null;
}

/**
 * Какая сборка реально используется.
 * Порядок: явный путь → выбранная сборка → авто (CUDA, если GPU разрешена и
 * сборка установлена, иначе OpenBLAS/CPU/legacy).
 */
function activeBuild(): BuildInfo | null {
  const c = cfg();
  const explicitBin = String(c.whisperBin || "");
  if (explicitBin && fs.existsSync(explicitBin)) {
    const dir = path.dirname(explicitBin);
    return {
      id: "custom",
      note: "custom",
      gpu: dirHas(path.join(dir, "ggml-cuda.dll")),
      installed: true,
      dir,
      bin: explicitBin,
      backend: backendOf(dir),
      custom: true,
      sizeMb: null,
      cuda: "",
    };
  }
  const list = buildsList();
  const selected = String(c.build || "auto");
  if (selected !== "auto") {
    const b = list.find((x) => x.id === selected);
    if (b && b.installed) return b;
  }
  if (!gpuDisabled()) {
    // CUDA-сборку в авто-режиме берём ТОЛЬКО если детект подтвердил карту NVIDIA.
    // Иначе «auto» выбирал CUDA-сборку на машине без NVIDIA: whisper-cli падал
    // («no CUDA devices»), и пользователь видел ошибку вместо расшифровки.
    // gpuCache === null (детект ещё не выполнялся) — ведём себя как раньше.
    const cudaAllowed = !gpuCache || gpuCache.cudaCapable !== false;
    if (cudaAllowed) {
      for (const id of ["cuda124", "cuda118"]) {
        const b = list.find((x) => x.id === id);
        if (b && b.installed) return b;
      }
    }
  }
  for (const id of ["blas", "cpu", "legacy"]) {
    const b = list.find((x) => x.id === id);
    if (b && b.installed) return b;
  }
  return null;
}

function findBin(): string | null {
  const b = activeBuild();
  return b ? b.bin : null;
}

/* ------------------------- Модели ------------------------- */

function modelInfo(entry: ModelCatalogEntry): ModelInfo {
  const file = path.join(MODELS_DIR, entry.file);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* нет файла */
  }
  return {
    id: entry.id,
    file: entry.file,
    sizeMb: entry.sizeMb,
    note: entry.note,
    url: entry.url,
    // Файл появляется в models/ только после полного скачивания (поток пишет
    // рядом в *.part), поэтому признак — размер, а НЕ округлённые МБ: у мелких
    // моделей (tiny ~75 МБ, «битый» файл 4 КБ) округление давало бы 0 и
    // модель молча выглядела нескачанной.
    downloaded: size > 0,
    downloadedMb: Math.round(size / (1024 * 1024)),
  };
}

function modelsList(): (ModelInfo & { active: boolean })[] {
  const active = findModel();
  return MODEL_CATALOG.map((m) => ({
    ...modelInfo(m),
    active: !!active && path.basename(active) === m.file,
  }));
}

/**
 * Активная модель.
 * Порядок: явный путь в настройках → выбранный id → авто (small → base → tiny →
 * любая ggml-*.bin в models/). Авто-приоритет намеренно «ноутбучный»: пока
 * пользователь не выбрал модель сам, движок не должен уходить в large.
 */
function findModel(): string | null {
  const c = cfg();
  const explicit = String(c.model || "");
  if (explicit && fs.existsSync(explicit)) return explicit;
  const byId = String(c.modelId || "");
  if (byId) {
    const entry = MODEL_CATALOG.find((m) => m.id === byId);
    if (entry) {
      const p = path.join(MODELS_DIR, entry.file);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    const files = fs
      .readdirSync(MODELS_DIR)
      .filter((f) => /^ggml-.*\.bin$/i.test(f))
      .sort();
    const pick =
      ["ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"]
        .map((n) => files.find((f) => f === n))
        .find(Boolean) || files[0];
    return pick ? path.join(MODELS_DIR, pick) : null;
  } catch {
    return null;
  }
}

/* ------------------------- GPU ------------------------- */

/** Видеокарта, найденная детектом (nvidia-smi или WMI). */
interface GpuDevice {
  vendor: string;
  name: string;
  driver: string;
  memoryMb: number;
  cuda: boolean;
}

/** Результат детекта GPU (кэш на GPU_TTL_MS): то, что читает UI и deviceArgs. */
interface GpuInfo {
  devices: GpuDevice[];
  cudaCapable: boolean;
  name: string;
  memoryMb: number;
  driver: string;
  cpu: string;
  blackwell: boolean;
  /** Детект ещё не выполнялся: setupInfo отдаёт заготовку до первого detectGpu. */
  pending?: boolean;
}

let gpuCache: GpuInfo | null = null;
let gpuAt = 0;
const GPU_TTL_MS = 60_000;

function runCmd(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? "" : String(stdout || ""));
      });
    } catch {
      resolve("");
    }
  });
}

/**
 * GPU для whisper.cpp. CUDA-сборка ищет именно NVIDIA, поэтому имя, драйвер и
 * видеопамять берём у nvidia-smi (он же подтверждает, что карта живая и её
 * видит драйвер). Если nvidia-smi нет — сообщаем, какой адаптер стоит (WMI),
 * чтобы UI не писал сухое «GPU не найден» на AMD/Intel.
 */
async function detectGpu(): Promise<GpuInfo> {
  if (gpuCache && Date.now() - gpuAt < GPU_TTL_MS) return gpuCache;
  const devices: GpuDevice[] = [];
  const smi = await runCmd(
    "nvidia-smi",
    ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
    4000,
  );
  for (const line of smi.split(/\r?\n/)) {
    const parts = line.split(",").map((x) => x.trim());
    if (!parts[0]) continue;
    devices.push({
      vendor: "nvidia",
      name: parts[0],
      driver: parts[1] || "",
      memoryMb: parseInt(parts[2], 10) || 0,
      cuda: true,
    });
  }
  if (!devices.length && /^win/i.test(process.platform)) {
    const wmi = await runCmd("wmic", ["path", "win32_VideoController", "get", "name"], 5000);
    for (const line of wmi.split(/\r?\n/)) {
      const name = line.trim();
      if (!name || /VideoController|^-*$/i.test(name)) continue;
      const nvidia = /nvidia|geforce|rtx|gtx|quadro/i.test(name);
      devices.push({
        vendor: nvidia
          ? "nvidia"
          : /amd|radeon/i.test(name)
            ? "amd"
            : /intel/i.test(name)
              ? "intel"
              : "unknown",
        name,
        driver: "",
        memoryMb: 0,
        cuda: nvidia,
      });
    }
  }
  const cuda = devices.find((d) => d.cuda) || null;
  const cpu = (() => {
    try {
      return os.cpus()[0]?.model || "";
    } catch {
      return "";
    }
  })();
  gpuCache = {
    devices,
    cudaCapable: !!cuda,
    name: cuda ? cuda.name : devices[0]?.name || "",
    memoryMb: cuda ? cuda.memoryMb : 0,
    driver: cuda ? cuda.driver : "",
    cpu,
    // Blackwell (RTX 50xx) требует CUDA 12.8+, а официальная x64-сборка собрана
    // под CUDA 12.4: ядра sm_120 в ней нет, работает только JIT из PTX compute_90.
    // Обычно этого хватает, но на части драйверов падает «no kernel image» —
    // поэтому UI честно предупреждает, а self-test показывает реальный итог.
    blackwell: /rtx 50\d{2}|b[12]00|blackwell/i.test(cuda ? cuda.name : ""),
  };
  gpuAt = Date.now();
  return gpuCache;
}

/** Сброс кэша GPU (после ручного обновления в UI). */
function resetGpuCache(): void {
  gpuCache = null;
  gpuAt = 0;
}

/**
 * Флаги устройства для whisper-cli.
 *  • CPU-сборка → ничего не добавляем;
 *  • CUDA-сборка + GPU разрешена → (опционально) -dev N;
 *  • CUDA-сборка + GPU выключена → -ng (считать на CPU, не грузя карту).
 */
function deviceArgsFor(
  build: BuildInfo | null,
  gpu: GpuInfo | null,
  gpuOff: boolean,
  deviceId: number,
): string[] {
  const args: string[] = [];
  if (!build) return args;
  const hasGpuBackend = build.backend === "cuda" || build.backend === "vulkan";
  if (!hasGpuBackend) return args;
  if (gpuOff) return ["-ng"];
  // СТРАХОВКА: CUDA-сборка, но карты NVIDIA нет (или детект её не нашёл).
  // Без этого запуск падал с «no CUDA devices found», и пользователь вместо
  // расшифровки получал ошибку — хотя на процессоре эта же сборка считает.
  // gpu === null означает «детект ещё не выполнялся»: не вмешиваемся.
  if (gpu && gpu.cudaCapable === false) return ["-ng"];
  const dev = Number(deviceId) || 0;
  if (dev > 0) args.push("-dev", String(dev));
  return args;
}

function deviceArgs(): string[] {
  return deviceArgsFor(activeBuild(), gpuCache, gpuDisabled(), Number(cfg().deviceId) || 0);
}

/* ------------------------- Очередь задач ------------------------- */

/**
 * Одна задача установки за раз (модель ИЛИ сборка) — состояние опрашивает UI
 * через GET /api/lecture/engine/setup.
 *
 * Машина состояния — общий модуль server/ts/setupTask.ts: ровно та же логика
 * нужна диаризации (diarize.js), и две копии уже расходились бы текстом ошибки
 * и сбросом флага отмены. `task` — прямая ссылка на состояние, поэтому прямые
 * записи вида `task.phase = "install"` ниже продолжают работать.
 */
const setup = createSetupTask("whisperEngine");
const task = setup.state;
const taskSnapshot = () => setup.snapshot();
const resetTask = (kind: string, id: string | null): void => setup.reset(kind, id);
const failTask = (e: unknown): void => setup.fail(e);
const doneTask = (): void => setup.done();
const cancelTask = (): SetupTaskState => setup.cancel();

/** Скачивание с прогрессом в task (общий модуль server/ts/download.ts). */
async function downloadTo(
  url: string,
  destFile: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<number> {
  return downloadToFile(url, destFile, {
    userAgent: "MoonApp/1.0 (+whisper.cpp)",
    timeoutMs,
    shouldCancel: () => setup.shouldCancel(),
    onProgress: ({ total, received }) => setup.setDownloadProgress(received, total),
  });
}

/** Распаковка zip во временную папку (adm-zip уже есть в зависимостях). */
function extractZip(zipFile: string, destDir: string): void {
  // JS-зависимость без импорта: тот же приём, что в server/ts/proxy.ts (#633).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require("adm-zip");
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  new AdmZip(zipFile).extractAllTo(destDir, true);
}

/** Плоская раскладка exe/dll из распакованного архива в каталог сборки. */
function copyFlat(srcDir: string, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(from, depth + 1);
        continue;
      }
      if (!/\.(exe|dll|bin)$/i.test(e.name)) continue;
      try {
        fs.copyFileSync(from, path.join(destDir, e.name));
        copied++;
      } catch {
        /* занятый файл */
      }
    }
  };
  walk(srcDir, 0);
  return copied;
}

/* ------------------------- Установка модели ------------------------- */

/** Скачать модель и сразу сделать её активной. */
function downloadModel(id: string): SetupTaskState {
  if (task.state === "working") throw new Error("busy");
  const entry = MODEL_CATALOG.find((m) => m.id === id);
  if (!entry) throw new Error("unknown_model");
  resetTask("model", entry.id);
  (async () => {
    try {
      const part = path.join(DL_DIR, `${entry.file}.part`);
      await downloadTo(entry.url, part);
      task.phase = "install";
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      const dest = path.join(MODELS_DIR, entry.file);
      fs.rmSync(dest, { force: true });
      fs.renameSync(part, dest);
      // Скачали — значит выбрали: пользователь ждёт, что заработает именно она.
      settings.set({ lecture: { modelId: entry.id, model: "" } });
      doneTask();
      logger.action("whisperEngine.model.installed", {
        id: entry.id,
        mb: Math.round(task.received / 1048576),
      });
    } catch (e) {
      failTask(e);
    }
  })();
  return taskSnapshot();
}

function removeModel(id: string): SetupInfo {
  const entry = MODEL_CATALOG.find((m) => m.id === id);
  if (!entry) throw new Error("unknown_model");
  if (task.state === "working" && task.kind === "model" && task.id === id) throw new Error("busy");
  const file = path.join(MODELS_DIR, entry.file);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  const c = cfg();
  if (c.modelId === id) settings.set({ lecture: { modelId: "" } });
  if (c.model && path.basename(String(c.model)) === entry.file)
    settings.set({ lecture: { model: "" } });
  logger.action("whisperEngine.model.removed", { id });
  return setupInfo();
}

/** Выбор модели: id из каталога либо "" (авто). */
function selectModel(id: string): SetupInfo {
  const wanted = String(id || "");
  if (wanted) {
    const entry = MODEL_CATALOG.find((m) => m.id === wanted);
    if (!entry) throw new Error("unknown_model");
    if (!fs.existsSync(path.join(MODELS_DIR, entry.file))) throw new Error("model_not_downloaded");
    settings.set({ lecture: { modelId: entry.id, model: "" } });
  } else {
    settings.set({ lecture: { modelId: "", model: "" } });
  }
  return setupInfo();
}

/* ------------------------- Установка сборки ------------------------- */

/**
 * Скачать и распаковать сборку движка в storage/whisper/builds/<id>.
 * Каждая сборка живёт в своём каталоге, поэтому переключение CPU↔CUDA — это
 * только смена настроек, без переустановки и без затирания файлов.
 */
function installBuild(id: string): SetupTaskState {
  if (task.state === "working") throw new Error("busy");
  const entry = BUILD_CATALOG.find((b) => b.id === id);
  if (!entry) throw new Error("unknown_build");
  resetTask("build", entry.id);
  (async () => {
    let tmp = "";
    try {
      const zipFile = path.join(DL_DIR, entry.zipName);
      await downloadTo(entry.url, zipFile);
      task.phase = "extract";
      task.progress = 0;
      tmp = path.join(TMP_DIR, `build_${entry.id}_${Date.now()}`);
      extractZip(zipFile, tmp);
      task.phase = "install";
      const copied = copyFlat(tmp, entry.dir);
      if (!copied || !exeIn(entry.dir)) throw new Error("build_no_exe");
      settings.set({ lecture: { build: entry.id, whisperBin: "" } });
      doneTask();
      logger.action("whisperEngine.build.installed", { id: entry.id, files: copied });
    } catch (e) {
      failTask(e);
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(path.join(DL_DIR, entry.zipName), { force: true });
      } catch {
        /* ignore */
      }
    }
  })();
  return taskSnapshot();
}

/** Выбор сборки: id из каталога или "auto" (CUDA при наличии → CPU/BLAS). */
function selectBuild(id: string): SetupInfo {
  const wanted = String(id || "auto");
  const chosen = wanted === "auto" ? null : findBuild(wanted);
  if (wanted !== "auto" && !chosen) throw new Error("unknown_build");
  if (chosen && !chosen.installed) throw new Error("build_not_installed");
  settings.set({ lecture: { build: wanted, whisperBin: "" } });
  logger.action("whisperEngine.build.selected", { id: wanted });
  return setupInfo();
}

/** Сменить каталог движка вручную (поле «путь к whisper-cli.exe»). */
function setCustomBin(binPath: string): SetupInfo {
  const p = String(binPath || "").trim();
  if (p && !fs.existsSync(p)) throw new Error("bin_not_found");
  settings.set({ lecture: { whisperBin: p } });
  return setupInfo();
}

/**
 * Настройки GPU: режим (auto | off) и номер устройства для флага -dev.
 * deviceId приходит из UI только когда карт несколько; undefined — не трогаем,
 * чтобы переключение «только CPU» не сбрасывало выбранную карту.
 */
function setGpuMode(mode: unknown, deviceId?: number | null): SetupInfo {
  const m = mode === false || mode === "off" || mode === "cpu" ? "off" : "auto";
  const patch: { gpu: string; deviceId?: number } = { gpu: m };
  if (deviceId !== undefined && deviceId !== null)
    patch.deviceId = Math.max(0, Number(deviceId) || 0);
  settings.set({ lecture: patch });
  logger.action("whisperEngine.gpu", { mode: m, deviceId: settings.get("lecture").deviceId });
  return setupInfo();
}

/* ------------------------- Детект системы и подсказки «ваш ПК» ------------------------- */

/**
 * Железо для подсказок «лучше для вашего ПК».
 *
 * Зачем: пользователь видел список моделей (tiny … large-v3) без ориентира и
 * качал 3 ГБ large-v3 на слабый ноутбук, где расшифровка идёт медленнее речи.
 * Здесь считаем реальные ресурсы и говорим прямо, что подойдёт ИМЕННО этому ПК.
 *
 * ВАЖНО: оценка не влияет на работу движка — только на подсказки в UI.
 */
function detectSystem(): SystemInfo {
  const cpus = (() => {
    try {
      return os.cpus() || [];
    } catch {
      return [];
    }
  })();
  const threads = cpus.length || 1;
  // В Node нет API физических ядер. У x86 с SMT потоков вдвое больше ядер, и это
  // важно: whisper.cpp упирается в ФИЗИЧЕСКИЕ ядра (потоки не ускоряют счёт).
  // Признак SMT берём по модели процессора: Intel/AMD с HT/SMT → threads / 2.
  const model = cpus[0]?.model || "";
  const smt =
    /\b(hyper[- ]?threading|ht\b|smt|ryzen|core\s*i[3579]|xeon|threadripper|epyc)\b/i.test(model);
  const cores = smt ? Math.max(1, Math.round(threads / 2)) : threads;
  const ramMb = Math.round(os.totalmem() / (1024 * 1024));
  const gpu = gpuCache;
  const cudaDev = (gpu?.devices || []).find((d) => d.cuda) || null;
  return {
    cpu: model,
    cores,
    threads,
    ramMb,
    platform: process.platform,
    arch: process.arch,
    gpuName: gpu?.name || "",
    gpuMemoryMb: gpu?.memoryMb || 0,
    gpuVendor: cudaDev?.vendor || gpu?.devices?.[0]?.vendor || "",
    cuda: !!(gpu && gpu.cudaCapable),
    blackwell: !!(gpu && gpu.blackwell),
    detected: !!gpu,
  };
}

/**
 * Сколько памяти нужно модели, ЧТОБЫ БЫЛО КОМФОРТНО: вес файла + рабочий буфер
 * (KV-кэш, буферы слоёв) + запас на операционную систему и само приложение
 * (Electron сам занимает около гигабайта, а на видеокарте рабочий стол держит
 * ~0.8 ГБ VRAM). Без запаса модель «влезает» по формуле и роняет систему в своп.
 */
function modelNeeds(sizeMb: number): ModelNeeds {
  return {
    ramMb: Math.round(sizeMb * 1.1 + 400 + 1500),
    vramMb: Math.round(sizeMb * 1.05 + 300 + 800),
  };
}

/**
 * Лучшая модель для этого ПК.
 *
 * Логика: сначала «потолок» по скорости (на процессоре точные модели считают
 * медленнее реального времени — это и есть главная жалоба), затем проверка
 * памяти. На CUDA потолок выше: видеокарта держит large-v3-turbo спокойно.
 */
function bestModelId(sys: SystemInfo): string {
  if (sys.cuda && sys.gpuMemoryMb) {
    const vram = sys.gpuMemoryMb;
    if (vram >= 10000) return "large-v3";
    if (vram >= 6000) return "large-v3-turbo";
    return "large-v3-turbo-q5_0"; // 3–6 ГБ: турбо в q5-кванте
  }
  // Процессор: ориентируемся на физические ядра (см. detectSystem).
  if (sys.cores >= 16 && sys.ramMb >= 16000) return "large-v3-turbo-q5_0";
  if (sys.cores >= 8 && sys.ramMb >= 8000) return "medium-q5_0";
  return "small";
}

/** Подсказка по модели: уровень + причина + требование по памяти. */
function modelRecommend(entry: ModelEntry, sys: SystemInfo): ModelAdvice {
  const need = modelNeeds(entry.sizeMb);
  const best = bestModelId(sys);
  const level = (id: string): number => MODEL_ORDER.indexOf(id);
  const haveVram = sys.cuda && sys.gpuMemoryMb > 0;
  const fits = haveVram ? sys.gpuMemoryMb >= need.vramMb : sys.ramMb >= need.ramMb;
  const needGb = Math.max(1, Math.round((haveVram ? need.vramMb : need.ramMb) / 1024));
  if (!fits) {
    // Причина — какой именно памяти не хватает: это разные диагнозы для пользователя.
    return { level: "unfit", reason: haveVram ? "vram" : "ram", gb: needGb, best: false };
  }
  if (entry.id === best) {
    return {
      level: "best",
      reason: haveVram ? "gpu" : sys.cores >= 8 ? "cpu_many" : "balanced",
      gb: needGb,
      best: true,
    };
  }
  // Не «лучшая», но заметно тяжелее рекомендованной → честно предупреждаем.
  if (level(entry.id) > level(best) && level(entry.id) - level(best) > 1) {
    return { level: "heavy", reason: haveVram ? "slow_vram" : "cpu_weak", gb: needGb, best: false };
  }
  return { level: "good", reason: "", gb: needGb, best: false };
}

/**
 * Порядок «тяжести» моделей: по нему считаются уровни подсказок.
 * Совпадает с MODEL_CATALOG (tiny → large-v3), но устойчив к правкам каталога.
 */
const MODEL_ORDER = [
  "tiny",
  "base",
  "small",
  "medium-q5_0",
  "large-v3-turbo-q5_0",
  "medium",
  "large-v3-q5_0",
  "large-v3-turbo",
  "large-v3",
];

/** Подсказка по сборке: CUDA — только при NVIDIA, иначе OpenBLAS на процессоре. */
function buildRecommend(entry: { id: string }, sys: SystemInfo): BuildAdvice {
  if (entry.id === "cuda118" || entry.id === "cuda124") {
    if (!sys.cuda) return { level: "unfit", reason: "no_gpu", best: false };
    return {
      level: entry.id === "cuda124" ? "best" : "good",
      reason: "gpu",
      best: entry.id === "cuda124",
    };
  }
  if (entry.id === "blas") {
    // OpenBLAS ускоряет счёт на процессоре — это лучший выбор без NVIDIA.
    return sys.cuda
      ? { level: "good", reason: "cpu_fallback", best: false }
      : { level: "best", reason: "cpu_blas", best: true };
  }
  // legacy / cpu: работают всегда, но на CPU медленнее OpenBLAS.
  return { level: "good", reason: sys.cuda ? "cpu_fallback" : "cpu_slow", best: false };
}

/** Сводка «ваш ПК» одной строкой для панели. */
function systemSummary(sys: SystemInfo): SystemSummary {
  return {
    cpu: sys.cpu,
    cores: sys.cores,
    threads: sys.threads,
    ramGb: Math.round(sys.ramMb / 1024),
    gpu: sys.cuda ? sys.gpuName : sys.gpuName || "",
    gpuGb: sys.gpuMemoryMb ? Math.round(sys.gpuMemoryMb / 1024) : 0,
    cuda: sys.cuda,
    blackwell: sys.blackwell,
    detected: sys.detected,
  };
}

/* ------------------------- Сводка для UI ------------------------- */

/** Краткий статус движка (используется и в шапке страницы лекций). */
function engineSummary(): EngineSummary {
  const bin = findBin();
  const model = findModel();
  const build = activeBuild();
  const gpu = gpuCache;
  const warnings: string[] = [];
  if (build && normalizeBackend(build.backend) === "cuda" && gpu && !gpu.cudaCapable)
    warnings.push("cuda_without_nvidia");
  if (
    build &&
    normalizeBackend(build.backend) === "cuda" &&
    gpu &&
    gpu.cudaCapable &&
    gpu.blackwell
  )
    warnings.push("cuda_blackwell");
  // Подсказка уже подводила эту модель: расшифровка идёт без неё. Показываем
  // причину, иначе выключенная подсказка выглядит как «настройка игнорируется».
  if (model && promptUnusable.has(String(model))) warnings.push("prompt_unusable");
  return {
    ready: !!(bin && model),
    bin: bin || null,
    model: model || null,
    modelId: modelIdOf(model),
    backend: bin && build ? build.backend : null,
    build: build ? build.id : null,
    buildDir: build ? build.dir : null,
    buildCustom: !!(build && build.custom),
    gpu: gpuDisabled() ? "off" : "auto",
    deviceId: Number(cfg().deviceId) || 0,
    language: cfg().language,
    threads: Number(cfg().threads) || 4,
    activeSession: false, // заполняет lecture.engineStatus (там известно про сессии)
    warnings,
  };
}

/** "blas" → "cpu+blas": в UI показываем понятные подписи. */
function normalizeBackend(b: string | null | undefined): string {
  return b === "blas" ? "cpu+blas" : b || "cpu";
}

/** Полная информация для панели настроек движка. */
function setupInfo(): SetupInfo {
  const build = activeBuild();
  // Подсказки «лучше для вашего ПК»: считаем один раз на ответ, чтобы панель
  // не пересчитывала их на клиенте и не расходилась с сервером.
  const sys = detectSystem();
  return {
    engine: engineSummary(),
    gpu: gpuCache || {
      devices: [],
      cudaCapable: false,
      name: "",
      memoryMb: 0,
      driver: "",
      cpu: "",
      blackwell: false,
      pending: true,
    },
    builds: buildsList().map((b) => ({
      ...b,
      active: !!build && b.id === build.id,
      recommend: buildRecommend(b, sys),
    })),
    models: modelsList().map((m) => ({ ...m, recommend: modelRecommend(m, sys) })),
    system: systemSummary(sys),
    task: taskSnapshot(),
    // Последний self-test: UI показывает его сразу после перезагрузки страницы,
    // не требуя заново гонять проверку.
    verify: verifyResult(),
    tag: WHISPER_TAG,
    dirs: { whisper: WHISPER_DIR, models: MODELS_DIR, builds: BUILDS_DIR },
  };
}

/** Последний результат self-test (для UI). */
let lastVerify: VerifyResult | null = null;
function verifyResult(): VerifyResult | null {
  return lastVerify;
}

/* ------------------------- Флаги запуска whisper-cli ------------------------- */

/**
 * Аргументы whisper-cli — ОДНО место для транскрипции и self-test, чтобы тест
 * проверял ровно те флаги, которыми потом идёт расшифровка лекций.
 */
function transcribeArgs(
  model: string,
  wavPath: string,
  outBase: string,
  opts: TranscribeOptions = {},
): string[] {
  const c = cfg();
  // opts.prompt: строка — подсказка (по умолчанию из настроек); null — флага
  // --prompt в команде НЕ будет. Второй вариант нужен откату в lecture.js:
  // large-v3-turbo на длинную русскую подсказку отвечает пустым SRT (движок
  // стартует, грузит модель в VRAM и молча завершается), а повтор без неё
  // возвращает нормальный текст (см. needsPromptlessRetry).
  const prompt = opts.prompt === undefined ? c.initialPrompt || "" : opts.prompt;
  const args = [
    "-m",
    model,
    "-f",
    wavPath,
    "-l",
    String(c.language || "ru"),
    "-np", // тихий вывод: только результат
    // ВНИМАНИЕ: без -nt. Флаг --no-timestamps применяется и к -osrt, и тогда
    // whisper пишет один сегмент с фиктивным временем (00:00:00 → 00:00:30),
    // т.е. тайминги сегментов теряются. Нам нужны валидные SRT-сегменты.
    "-t",
    String(Math.max(1, Math.min(16, Number(c.threads) || 4))),
  ];
  if (prompt !== null) args.push("--prompt", String(prompt));
  args.push(
    ...deviceArgs(),
    "-of",
    outBase,
    "-osrt", // сегменты с таймингами
  );
  return args;
}

/** Текущая подсказка распознавания (то, что уйдёт в --prompt). */
function initialPrompt(): string {
  return String(cfg().initialPrompt || "");
}

/**
 * Нужен ли повтор прогона БЕЗ подсказки: движок не нашёл текст, а подсказка была.
 *
 * Зачем: у large-v3-turbo длинная русская подсказка выбивает декодер в пустой
 * ответ (проверено на сборке cuda124: с подсказкой — 0 байт SRT за ~2 с,
 * без неё — нормальный текст; на CPU-прогоне той же сборки с -ng — тоже пусто,
 * т.е. дело не в видеокарте). small с той же подсказкой считает нормально.
 * Пользователь видел это как «включил GPU — модель мигнула и нечего
 * расшифровывать», поэтому при пустом ответе повторяем прогон без --prompt.
 */
function needsPromptlessRetry(text: unknown, prompt: unknown): boolean {
  return !String(text || "").trim() && String(prompt || "").trim().length > 0;
}

/**
 * Модели, на которых подсказка распознавания уже дала пустой ответ.
 *
 * Зачем: повтор прогона без --prompt спасает результат, но стоит полной загрузки
 * модели. Если прогон без подсказки прошёл успешно, дальше по этой модели
 * подсказка не передаётся вовсе — иначе каждый чанк лекции оплачивался бы двумя
 * запусками модели (на GPU +2–3 с, на CPU +10–20 с на чанк).
 *
 * Ключ — путь к файлу модели: поведение зависит именно от модели (large-v3-turbo
 * с длинной русской подсказкой), а не от сборки движка (воспроизводится и на
 * cuda124, и на blas). Флаг живёт до перезапуска процесса: если в новой версии
 * whisper.cpp это исправят, ограничение снимет само.
 */
const promptUnusable = new Set<string>();

/** Запомнить, что на модели подсказка ломает распознавание. true — запомнили впервые. */
function notePromptUnusable(modelPath: unknown): boolean {
  const key = modelPath ? String(modelPath) : "";
  if (!key || promptUnusable.has(key)) return false;
  promptUnusable.add(key);
  logger.warn("whisperEngine.prompt_unusable", { model: path.basename(key) });
  return true;
}

/** Подсказка на этой модели уже давала пустой ответ (прогон пойдёт без --prompt). */
function promptUnusableFor(modelPath: unknown): boolean {
  return !!modelPath && promptUnusable.has(String(modelPath));
}

/** Небольшой WAV (PCM 16 кГц моно) для self-test — без внешних файлов. */
function makeTestWav(sampleRate = 16000, seconds = 1.5) {
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  // Тихий шум: ровная тишина иногда даёт «фантомную» расшифровку, но нам важен
  // только успешный запуск и загрузка бэкенда, поэтому сигнал минимальный.
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 60);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Self-test движка: прогон модели на синтетическом WAV.
 *
 * Зачем: наличие файлов ggml-cuda.dll ещё не значит, что ядро запустится —
 * CUDA-сборки whisper.cpp собраны под CUDA 12.4, а Blackwell (RTX 50xx) требует
 * sm_120. Тест показывает РЕАЛЬНЫЙ итог: поднялся ли CUDA, что ответил драйвер,
 * сколько заняло времени. Ошибки вида «no kernel image» видно сразу.
 */
function verify(): Promise<VerifyResult> {
  return new Promise<VerifyResult>((resolve) => {
    const bin = findBin();
    const model = findModel();
    const active = activeBuild();
    const buildId = active ? active.id : null;
    const base = {
      ok: false,
      at: Date.now(),
      bin,
      model,
      modelId: modelIdOf(model),
      build: buildId,
      backend: null,
      gpuUsed: false,
      computeCapability: "",
      elapsedMs: 0,
      log: "",
      error: "",
    };
    // lastVerify заполняется в ЛЮБОМ исходе (в том числе «движок не найден»):
    // панель настроек читает setup.verify, чтобы показать итог после перезагрузки.
    const done = (result: VerifyResult) => {
      lastVerify = result;
      resolve(result);
    };
    if (!bin) return done({ ...base, error: "whisper_not_installed" });
    if (!model) return done({ ...base, error: "whisper_model_missing" });
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const wav = path.join(TMP_DIR, `verify_${Date.now()}.wav`);
      fs.writeFileSync(wav, makeTestWav());
      const outBase = wav.replace(/\.wav$/i, "");
      const started = Date.now();
      const proc = spawn(bin, transcribeArgs(model, wav, outBase), { windowsHide: true });
      let log = "";
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, 180000);
      const finish = (code: number | null) => {
        clearTimeout(timer);
        try {
          fs.rmSync(wav, { force: true });
          fs.rmSync(outBase + ".srt", { force: true });
        } catch {
          /* ignore */
        }
        const elapsedMs = Date.now() - started;
        const cudaLoaded = /loaded CUDA backend|ggml_cuda_init|CUDA\d/i.test(log);
        const vulkanLoaded = /loaded Vulkan backend|Vulkan\d/i.test(log);
        const cc = (/(?:compute capability|compute_cap)[ =:]*(\d+\.\d+)/i.exec(log) || [])[1] || "";
        const errLine =
          (/no kernel image|CUDA error|out of memory|error loading model|failed to (?:load|initialize)[^\n]*/i.exec(
            log,
          ) || [])[0] || "";
        // CUDA/Vulkan подтверждаются логом: движок мог тихо уйти на процессор.
        // OpenBLAS — свойство сборки (отдельной строки в логе у него нет),
        // поэтому его берём из активной сборки, иначе тест писал бы «процессор»
        // на ускоренной сборке.
        const buildBackend = (activeBuild() || {}).backend || "cpu";
        const backend = cudaLoaded
          ? "cuda"
          : vulkanLoaded
            ? "vulkan"
            : buildBackend === "cuda" || buildBackend === "vulkan"
              ? "cpu"
              : buildBackend;
        const ok = code === 0 || /\bmain: processing\b|whisper_print_timings/i.test(log);
        const result = {
          ...base,
          ok: !!ok && !errLine,
          backend,
          gpuUsed: cudaLoaded || vulkanLoaded,
          computeCapability: cc,
          elapsedMs,
          log: String(log).slice(-4000),
          error: errLine || (ok ? "" : `exit_${code}`),
        };
        lastVerify = result; // UI показывает итог теста даже после перезагрузки страницы
        resolve(result);
      };
      // Бэкенды логируются в stderr, расшифровка — в stdout. Собираем оба.
      proc.stdout.on("data", (d) => {
        log += d.toString("utf8");
      });
      proc.stderr.on("data", (d) => {
        log += d.toString("utf8");
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ...base, error: String(e.message || e) });
      });
      proc.on("close", (code) => finish(code));
    } catch (e) {
      resolve({ ...base, error: String((e as Error).message || e) });
    }
  });
}

/** Известные каталоги (для UI: показать, где искали движок). */
function dirs() {
  return { whisper: WHISPER_DIR, models: MODELS_DIR, builds: BUILDS_DIR };
}

export {
  WHISPER_TAG,
  MODEL_CATALOG,
  BUILD_CATALOG,
  MODELS_DIR,
  BUILDS_DIR,
  WHISPER_DIR,
  findBin,
  findModel,
  modelIdOf,
  modelsList,
  buildsList,
  findBuild,
  activeBuild,
  setupInfo,
  engineSummary,
  dirs,
  downloadModel,
  removeModel,
  selectModel,
  installBuild,
  selectBuild,
  setCustomBin,
  setGpuMode,
  cancelTask,
  taskSnapshot,
  verify,
  verifyResult,
  transcribeArgs,
  initialPrompt,
  needsPromptlessRetry,
  notePromptUnusable,
  promptUnusableFor,
  deviceArgs,
  deviceArgsFor,
  detectGpu,
  resetGpuCache,
  backendOf,
  detectSystem,
  modelNeeds,
  bestModelId,
  modelRecommend,
  buildRecommend,
  systemSummary,
};

/** id модели по её пути (UI подсвечивает активную строку). */
function modelIdOf(modelPath: string | null | undefined): string {
  if (!modelPath) return "";
  const base = path.basename(modelPath);
  const entry = MODEL_CATALOG.find((m) => m.file === base);
  return entry ? entry.id : "";
}
