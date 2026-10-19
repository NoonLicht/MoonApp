/**
 * Whisper в GGUF (handy-computer/whisper-*-gguf) поверх transcribe.cpp.
 *
 * Зачем: прежний движок (whisper.cpp: свои сборки CPU/BLAS/CUDA, путь к whisper-cli,
 * резидентный сервер) заменён одной библиотекой. Модели — квантованные GGUF
 * (Q4_K_M по умолчанию), считает та же библиотека на видеокарте (Vulkan) или
 * процессоре. Пакет `transcribe-cpp` ESM, поэтому грузим его динамическим import().
 *
 * Файлы лежат в storage/asr; выбранная модель и режим GPU — в настройках лекций
 * (asrModel, asrGpu). GigaAM v3 (ONNX) остаётся отдельным движком по умолчанию.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import settings from "./settings";
import logger from "./logger";
import { downloadToFile } from "./download";
import { createSetupTask } from "./setupTask";
import type { SetupTaskState } from "./setupTask";
import { readWav, resampleTo16k } from "./gigaamEngine";
import type { AsrSegment } from "./gigaamEngine";

const { DIRS } = config;

export const ASR_DIR = path.join(DIRS.storage, "asr");
const UA = "MoonApp/1.0 (+ASR)";
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/* ------------------------- Каталог ------------------------- */

export type AsrQuant = "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0";
export const QUANTS: AsrQuant[] = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"];
export const DEFAULT_QUANT: AsrQuant = "Q4_K_M";

interface Family {
  id: string;
  repo: string;
  /** Размеры файлов по квантам, байты (по данным репозиториев Hugging Face). */
  bytes: Record<AsrQuant, number>;
  note: "tiny" | "base" | "small" | "medium" | "turbo" | "large";
}

const FAMILIES: Family[] = [
  {
    id: "whisper-tiny",
    repo: "handy-computer/whisper-tiny-gguf",
    note: "tiny",
    bytes: { Q4_K_M: 43621792, Q5_K_M: 44211616, Q6_K: 44838304, Q8_0: 45981088 },
  },
  {
    id: "whisper-base",
    repo: "handy-computer/whisper-base-gguf",
    note: "base",
    bytes: { Q4_K_M: 58870848, Q5_K_M: 63786048, Q6_K: 67865664, Q8_0: 84962880 },
  },
  {
    id: "whisper-small",
    repo: "handy-computer/whisper-small-gguf",
    note: "small",
    bytes: { Q4_K_M: 171630656, Q5_K_M: 193749056, Q6_K: 212107328, Q8_0: 269751136 },
  },
  {
    id: "whisper-medium",
    repo: "handy-computer/whisper-medium-gguf",
    note: "medium",
    bytes: { Q4_K_M: 504102848, Q5_K_M: 582746048, Q6_K: 648019904, Q8_0: 831538144 },
  },
  {
    id: "whisper-large-v3-turbo",
    repo: "handy-computer/whisper-large-v3-turbo-gguf",
    note: "turbo",
    bytes: { Q4_K_M: 536069696, Q5_K_M: 619628096, Q6_K: 692536896, Q8_0: 886381728 },
  },
  {
    id: "whisper-large-v3",
    repo: "handy-computer/whisper-large-v3-gguf",
    note: "large",
    bytes: { Q4_K_M: 997303008, Q5_K_M: 1161143008, Q6_K: 1297130208, Q8_0: 1668741440 },
  },
];

export interface AsrModelInfo {
  /** Имя файла, он же идентификатор: whisper-small-Q4_K_M.gguf */
  id: string;
  family: string;
  quant: AsrQuant;
  note: Family["note"];
  sizeMb: number;
  downloaded: boolean;
  downloadedMb: number;
  active: boolean;
  isDefault: boolean;
}

function fileOf(family: string, quant: string): string {
  return `${family}-${quant}.gguf`;
}

function parseId(id: string): { family: Family; quant: AsrQuant } | null {
  for (const f of FAMILIES) {
    for (const q of QUANTS) if (fileOf(f.id, q) === id) return { family: f, quant: q };
  }
  return null;
}

function pathOf(id: string): string {
  return path.join(ASR_DIR, id);
}

function fileSize(id: string): number {
  try {
    return fs.statSync(pathOf(id)).size;
  } catch {
    return 0;
  }
}

function isDownloaded(id: string): boolean {
  const p = parseId(id);
  if (!p) return false;
  // Файл появляется только после rename из .part, но проверим и размер.
  return fileSize(id) >= p.family.bytes[p.quant] * 0.98;
}

/* ------------------------- Настройки ------------------------- */

interface Cfg {
  asrModel?: unknown;
  asrGpu?: unknown;
  language?: unknown;
  threads?: unknown;
  [k: string]: unknown;
}

function cfg(): Cfg {
  return settings.get("lecture") as Cfg;
}

/** Выбранная модель: сохранённая, иначе любая скачанная (приоритет small → …). */
export function activeModelId(): string {
  const wanted = String(cfg().asrModel || "");
  if (wanted && isDownloaded(wanted)) return wanted;
  for (const f of FAMILIES) {
    for (const q of QUANTS) {
      const id = fileOf(f.id, q);
      if (isDownloaded(id)) return id;
    }
  }
  return "";
}

export function isInstalled(): boolean {
  return !!activeModelId();
}

export function gpuMode(): "auto" | "off" {
  return cfg().asrGpu === "off" ? "off" : "auto";
}

export function setGpuMode(mode: unknown): void {
  settings.set({ lecture: { asrGpu: mode === "off" ? "off" : "auto" } });
  unload();
}

export function selectModel(id: string): void {
  if (!parseId(id)) throw new Error("unknown_model");
  if (!isDownloaded(id)) throw new Error("model_not_downloaded");
  settings.set({ lecture: { asrModel: id } });
  unload();
}

export function selectEngine(engine: unknown): void {
  settings.set({ lecture: { asrEngine: engine === "whisper" ? "whisper" : "gigaam" } });
}

/* ------------------------- Скачивание ------------------------- */

const setup = createSetupTask("asr");

export function downloadSnapshot(): SetupTaskState {
  return setup.snapshot();
}

export function download(id: string): SetupTaskState {
  const p = parseId(id);
  if (!p) throw new Error("unknown_model");
  if (setup.isWorking()) throw new Error("busy");
  setup.reset("model", id);
  (async () => {
    try {
      fs.mkdirSync(ASR_DIR, { recursive: true });
      const part = `${pathOf(id)}.part`;
      await downloadToFile(`https://huggingface.co/${p.family.repo}/resolve/main/${id}`, part, {
        userAgent: UA,
        shouldCancel: () => setup.shouldCancel(),
        onProgress: ({ total, received }) => setup.setDownloadProgress(received, total),
      });
      fs.rmSync(pathOf(id), { force: true });
      fs.renameSync(part, pathOf(id));
      // Первая скачанная модель сразу становится выбранной, а движок — Whisper.
      if (!cfg().asrModel || !isDownloaded(String(cfg().asrModel))) {
        settings.set({ lecture: { asrModel: id } });
      }
      unload();
      setup.done();
      logger.action("asr.model.installed", { id });
    } catch (e) {
      setup.fail(e);
    }
  })();
  return setup.snapshot();
}

export function cancelDownload(): SetupTaskState {
  return setup.cancel();
}

export function remove(id: string): void {
  if (!parseId(id)) throw new Error("unknown_model");
  if (setup.isWorking()) throw new Error("busy");
  unload();
  try {
    fs.rmSync(pathOf(id), { force: true });
  } catch {
    /* занятый файл */
  }
  logger.action("asr.model.removed", { id });
}

export interface AsrGgufInfo {
  installed: boolean;
  runtime: boolean;
  activeModel: string;
  gpu: "auto" | "off";
  backend: string | null;
  models: AsrModelInfo[];
  task: SetupTaskState;
  dir: string;
  defaultQuant: AsrQuant;
}

export function info(): AsrGgufInfo {
  const active = activeModelId();
  const models: AsrModelInfo[] = [];
  for (const f of FAMILIES) {
    for (const q of QUANTS) {
      const id = fileOf(f.id, q);
      const dl = isDownloaded(id);
      models.push({
        id,
        family: f.id,
        quant: q,
        note: f.note,
        sizeMb: Math.round(f.bytes[q] / 1048576),
        downloaded: dl,
        downloadedMb: dl ? Math.round(fileSize(id) / 1048576) : 0,
        active: id === active,
        isDefault: q === DEFAULT_QUANT,
      });
    }
  }
  return {
    installed: !!active,
    runtime: runtimeAvailable(),
    activeModel: active,
    gpu: gpuMode(),
    backend: loaded?.backend ?? null,
    models,
    task: setup.snapshot(),
    dir: ASR_DIR,
    defaultQuant: DEFAULT_QUANT,
  };
}

/* ------------------------- Рантайм ------------------------- */

interface TModel {
  transcribe(pcm: Float32Array, opts?: Record<string, unknown>): Promise<TResult>;
  dispose(): void;
  readonly backend?: string;
}
interface TResult {
  text: string;
  language?: string;
  segments?: { t0Ms: number; t1Ms: number; text: string }[];
}
interface TLib {
  TranscribeModel: { load(p: string, o?: Record<string, unknown>): Promise<TModel> };
}

let lib: TLib | null | undefined;
let libLoading: Promise<TLib | null> | null = null;

async function loadLib(): Promise<TLib | null> {
  if (lib !== undefined) return lib;
  if (!libLoading) {
    libLoading = (async () => {
      try {
        // Динамический import: пакет ESM, а сервер собирается в CommonJS.
        const mod = await (new Function("m", "return import(m)") as (m: string) => Promise<unknown>)(
          "transcribe-cpp",
        );
        lib = mod as TLib;
      } catch (e) {
        logger.warn("asr.runtime.missing", { error: String((e as Error)?.message || e) });
        lib = null;
      }
      return lib ?? null;
    })();
  }
  return libLoading;
}

/** Пакет считается доступным, пока загрузка не упала (проверяется при первом запуске). */
export function runtimeAvailable(): boolean {
  return lib !== null;
}

interface Loaded {
  id: string;
  gpu: string;
  model: TModel;
  backend: string;
}
let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Прогоны идут по одному: библиотека держит одну сессию на модель. */
let chain: Promise<unknown> = Promise.resolve();

export function unload(): void {
  const l = loaded;
  loaded = null;
  loading = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  try {
    l?.model.dispose();
  } catch {
    /* уже выгружена */
  }
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

async function ensureLoaded(): Promise<Loaded> {
  const id = activeModelId();
  if (!id) throw new Error("asr_model_missing");
  const gpu = gpuMode();
  if (loaded && loaded.id === id && loaded.gpu === gpu) return loaded;
  if (loading) return loading;
  if (loaded) unload();
  loading = (async () => {
    const l = await loadLib();
    if (!l) throw new Error("runtime_missing");
    const backend = gpu === "off" ? "cpu" : "auto";
    const model = await l.TranscribeModel.load(pathOf(id), { backend });
    const res: Loaded = { id, gpu, model, backend: String(model.backend || backend) };
    loaded = res;
    logger.info("asr.model.loaded", { id, backend: res.backend });
    return res;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Загрузить модель заранее (вход на страницу «Лекторий»). */
export function warmup(): boolean {
  if (loaded || loading || !isInstalled()) return false;
  void ensureLoaded()
    .then(() => touchIdle())
    .catch(() => undefined);
  return true;
}

/* ------------------------- Расшифровка ------------------------- */

export interface AsrOptions {
  language?: string;
  prompt?: string;
}

/** Расшифровка WAV-файла: { text, segments } (секунды), как у GigaAM. */
export function transcribeWav(
  wavPath: string,
  opts: AsrOptions = {},
): Promise<{ text: string; segments: AsrSegment[] }> {
  const run = async () => {
    const l = await ensureLoaded();
    const wav = readWav(wavPath);
    const pcm = resampleTo16k(wav.samples, wav.sampleRate);
    const lang = String(opts.language ?? cfg().language ?? "").toLowerCase();
    const o: Record<string, unknown> = { timestamps: "segment" };
    if (lang && lang !== "auto") o.language = lang;
    if (opts.prompt) o.family = { kind: "whisper", initialPrompt: opts.prompt };
    const r = await l.model.transcribe(pcm, o);
    touchIdle();
    const segments: AsrSegment[] = (r.segments || [])
      .map((s) => ({ start: s.t0Ms / 1000, end: s.t1Ms / 1000, text: String(s.text || "").trim() }))
      .filter((s) => s.text);
    const text = (segments.length ? segments.map((s) => s.text).join(" ") : String(r.text || ""))
      .replace(/\s+/g, " ")
      .trim();
    return { text, segments };
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}
