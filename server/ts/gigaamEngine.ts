/**
 * Движок распознавания речи GigaAM v3 (Сбер, MIT) поверх onnxruntime-node.
 *
 * Зачем рядом с Whisper: GigaAM v3 — Conformer-модель (~220M параметров), обученная
 * на русской речи; на русском она заметно точнее small/medium Whisper и считает
 * быстрее реального времени даже на процессоре. Берём готовый ONNX-экспорт
 * istupakov/gigaam-v3-onnx — «e2e CTC» (сразу с пунктуацией и нормализацией),
 * квантованный int8 (~215 МБ, один файл).
 *
 * Пайплайн: WAV 16 кГц моно → лог-мел 64×T (окно Ханна 320, шаг 160, как в
 * gigaam.preprocess.FeatureExtractor) → ONNX → log_probs [1, T/4, 257] →
 * жадное CTC-декодирование (blank = последний класс) → текст.
 *
 * Входы длиннее ~25 с режутся на окна по самым тихим местам: у модели ограничена
 * длина контекста, а лекции/заметки бывают и по часу.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import settings from "./settings";
import logger from "./logger";
import { downloadToFile } from "./download";
import { createSetupTask } from "./setupTask";
import type { SetupTaskState } from "./setupTask";
import { loadOrt } from "./upscale/runtime";

const { DIRS } = config;

const GIGAAM_DIR = path.join(DIRS.storage, "gigaam");
const BASE_URL = "https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main";
const MODEL_FILE = "v3_e2e_ctc.int8.onnx";
const VOCAB_FILE = "v3_e2e_ctc_vocab.txt";
const MODEL_SIZE_MB = 215;
const UA = "MoonApp/1.0 (+GigaAM)";

/* ------------------------- Параметры признаков ------------------------- */

export const SAMPLE_RATE = 16000;
const N_FFT = 320;
const HOP = 160;
const N_MELS = 64;
const N_FREQS = N_FFT / 2 + 1; // 161
/** Одному кадру выхода соответствует 4 кадра признаков = 40 мс. */
const FRAME_SEC = (HOP * 4) / SAMPLE_RATE;
/** Окно подачи в модель и границы поиска «тихого места» для разреза. */
const WINDOW_SEC = 20;
const WINDOW_MAX_SEC = 25;
const CUT_SEARCH_SEC = 5;
/** Пауза (в кадрах выхода), после которой начинается новый сегмент. */
const SEGMENT_GAP_FRAMES = 16;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/* ------------------------- Настройки ------------------------- */

interface LectureCfg {
  asrEngine?: unknown;
  language?: unknown;
  threads?: unknown;
  [key: string]: unknown;
}

function cfg(): LectureCfg {
  return settings.get("lecture") as LectureCfg;
}

/** Выбранный пользователем движок: "gigaam" (по умолчанию) или "whisper". */
export function preferred(): "gigaam" | "whisper" {
  return cfg().asrEngine === "whisper" ? "whisper" : "gigaam";
}

/** GigaAM обучена на русском: для других языков лекции остаётся Whisper. */
export function languageSupported(language: unknown = cfg().language): boolean {
  const l = String(language || "ru").toLowerCase();
  return l === "ru" || l === "auto" || l === "";
}

/* ------------------------- Файлы модели ------------------------- */

function modelPath(): string {
  return path.join(GIGAAM_DIR, MODEL_FILE);
}
function vocabPath(): string {
  return path.join(GIGAAM_DIR, VOCAB_FILE);
}

/** Модель и словарь скачаны полностью (файлы появляются только после rename из .part). */
export function isInstalled(): boolean {
  try {
    return fs.statSync(modelPath()).size > 1024 && fs.statSync(vocabPath()).size > 0;
  } catch {
    return false;
  }
}

/** Скачивать-то есть куда: движок рантайма (onnxruntime-node) доступен. */
export function runtimeAvailable(): boolean {
  return !!loadOrt();
}

/* ------------------------- Установка ------------------------- */

const setup = createSetupTask("gigaam");

export function taskSnapshot(): SetupTaskState {
  return setup.snapshot();
}

/** Скачать словарь и модель; по завершении выбранным движком остаётся GigaAM. */
export function download(): SetupTaskState {
  if (setup.isWorking()) throw new Error("busy");
  setup.reset("model", "gigaam-v3");
  (async () => {
    try {
      fs.mkdirSync(GIGAAM_DIR, { recursive: true });
      const parts: [string, string][] = [
        [VOCAB_FILE, "vocab"],
        [MODEL_FILE, "model"],
      ];
      for (const [file] of parts) {
        const part = path.join(GIGAAM_DIR, `${file}.part`);
        await downloadToFile(`${BASE_URL}/${file}`, part, {
          userAgent: UA,
          shouldCancel: () => setup.shouldCancel(),
          onProgress: ({ total, received }) => setup.setDownloadProgress(received, total),
        });
        fs.rmSync(path.join(GIGAAM_DIR, file), { force: true });
        fs.renameSync(part, path.join(GIGAAM_DIR, file));
      }
      unload();
      settings.set({ lecture: { asrEngine: "gigaam" } });
      setup.done();
      logger.action("gigaam.model.installed", { file: MODEL_FILE });
    } catch (e) {
      setup.fail(e);
    }
  })();
  return setup.snapshot();
}

export function cancelTask(): SetupTaskState {
  return setup.cancel();
}

export function remove(): void {
  if (setup.isWorking()) throw new Error("busy");
  unload();
  for (const f of [MODEL_FILE, VOCAB_FILE]) {
    try {
      fs.rmSync(path.join(GIGAAM_DIR, f), { force: true });
    } catch {
      /* занятый файл */
    }
  }
  logger.action("gigaam.model.removed", {});
}

/** Выбор движка по умолчанию: "gigaam" | "whisper". */
export function selectEngine(engine: unknown): void {
  settings.set({ lecture: { asrEngine: engine === "whisper" ? "whisper" : "gigaam" } });
}

export interface GigaamInfo {
  installed: boolean;
  runtime: boolean;
  sizeMb: number;
  downloadedMb: number;
  preferred: "gigaam" | "whisper";
  languageOk: boolean;
  task: SetupTaskState;
  dir: string;
}

export function info(): GigaamInfo {
  let size = 0;
  try {
    size = fs.statSync(modelPath()).size;
  } catch {
    /* нет файла */
  }
  return {
    installed: isInstalled(),
    runtime: runtimeAvailable(),
    sizeMb: MODEL_SIZE_MB,
    downloadedMb: Math.round(size / (1024 * 1024)),
    preferred: preferred(),
    languageOk: languageSupported(),
    task: setup.snapshot(),
    dir: GIGAAM_DIR,
  };
}

/* ------------------------- Признаки (лог-мел) ------------------------- */

let melBank: Float32Array | null = null; // [N_FREQS * N_MELS], строка = частота
let winCos: Float64Array | null = null; // [N_FREQS * N_FFT] — окно уже учтено
let winSin: Float64Array | null = null;

/** HTK-мел, norm=None, f 0…8000 Гц: как torchaudio.functional.melscale_fbanks. */
export function buildMelBank(): Float32Array {
  const fMax = SAMPLE_RATE / 2;
  const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const mMin = hz2mel(0);
  const mMax = hz2mel(fMax);
  const fPts: number[] = [];
  for (let i = 0; i < N_MELS + 2; i++) fPts.push(mel2hz(mMin + ((mMax - mMin) * i) / (N_MELS + 1)));
  const fb = new Float32Array(N_FREQS * N_MELS);
  for (let k = 0; k < N_FREQS; k++) {
    const f = (fMax * k) / (N_FREQS - 1);
    for (let m = 0; m < N_MELS; m++) {
      const down = (f - fPts[m]) / (fPts[m + 1] - fPts[m]);
      const up = (fPts[m + 2] - f) / (fPts[m + 2] - fPts[m + 1]);
      fb[k * N_MELS + m] = Math.max(0, Math.min(down, up));
    }
  }
  return fb;
}

function ensureTables(): void {
  if (melBank && winCos && winSin) return;
  melBank = buildMelBank();
  winCos = new Float64Array(N_FREQS * N_FFT);
  winSin = new Float64Array(N_FREQS * N_FFT);
  for (let n = 0; n < N_FFT; n++) {
    // Периодическое окно Ханна — по умолчанию в torch.hann_window.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
    for (let k = 0; k < N_FREQS; k++) {
      const a = (2 * Math.PI * k * n) / N_FFT;
      winCos[k * N_FFT + n] = w * Math.cos(a);
      winSin[k * N_FFT + n] = w * Math.sin(a);
    }
  }
}

/**
 * Лог-мел признаки: Float32Array [N_MELS × T] (строка = мел-полоса) и T.
 * center=false: T = floor((n − 320) / 160) + 1; короче одного окна — T = 0.
 */
export function logMel(samples: Float32Array): { data: Float32Array; frames: number } {
  ensureTables();
  const frames = samples.length < N_FFT ? 0 : Math.floor((samples.length - N_FFT) / HOP) + 1;
  const out = new Float32Array(N_MELS * frames);
  const cosT = winCos as Float64Array;
  const sinT = winSin as Float64Array;
  const bank = melBank as Float32Array;
  const power = new Float64Array(N_FREQS);
  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let k = 0; k < N_FREQS; k++) {
      let re = 0;
      let im = 0;
      const base = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        const x = samples[off + n];
        re += x * cosT[base + n];
        im += x * sinT[base + n];
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      for (let k = 0; k < N_FREQS; k++) s += power[k] * bank[k * N_MELS + m];
      out[m * frames + t] = Math.log(Math.min(Math.max(s, 1e-9), 1e9));
    }
  }
  return { data: out, frames };
}

/* ------------------------- WAV и разбиение ------------------------- */

/** PCM16 WAV (любой частоты) → Float32 [-1..1] моно; частоту отдаёт отдельно. */
export function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF")
    throw new Error("gigaam_bad_wav");
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2) || 1;
      sampleRate = buf.readUInt32LE(body + 4) || SAMPLE_RATE;
      bits = buf.readUInt16LE(body + 14) || 16;
    } else if (id === "data") {
      dataStart = body;
      // ffmpeg в потоке пишет 0xFFFFFFFF — берём до конца файла.
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2);
  }
  if (dataStart < 0 || bits !== 16) throw new Error("gigaam_bad_wav");
  const frameBytes = 2 * channels;
  const n = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataStart + i * frameBytes + c * 2);
    out[i] = sum / channels / 32768;
  }
  return { samples: out, sampleRate };
}

/** Линейная передискретизация до 16 кГц (на входе обычно уже 16 кГц — копия не нужна). */
export function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (rate === SAMPLE_RATE || !rate) return samples;
  const ratio = rate / SAMPLE_RATE;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = samples[j] * (1 - f) + (samples[Math.min(j + 1, samples.length - 1)] ?? 0) * f;
  }
  return out;
}

/**
 * Границы окон ≤ 25 с: режем у самой тихой 20-мс области в последних 5 с
 * окна, чтобы не рвать слово посередине.
 */
export function planWindows(samples: Float32Array): [number, number][] {
  const total = samples.length;
  if (total <= WINDOW_MAX_SEC * SAMPLE_RATE) return [[0, total]];
  const out: [number, number][] = [];
  const block = SAMPLE_RATE / 50;
  let start = 0;
  while (total - start > WINDOW_MAX_SEC * SAMPLE_RATE) {
    const target = start + WINDOW_SEC * SAMPLE_RATE;
    const from = Math.max(start + block, target - CUT_SEARCH_SEC * SAMPLE_RATE);
    const to = Math.min(total - block, target + CUT_SEARCH_SEC * SAMPLE_RATE * 0.8);
    let bestAt = target;
    let best = Infinity;
    for (let p = from; p + block <= to; p += block) {
      let e = 0;
      for (let i = 0; i < block; i++) e += samples[p + i] * samples[p + i];
      if (e < best) {
        best = e;
        bestAt = p + block / 2;
      }
    }
    const cut = Math.min(Math.round(bestAt), start + WINDOW_MAX_SEC * SAMPLE_RATE);
    out.push([start, cut]);
    start = cut;
  }
  out.push([start, total]);
  return out;
}

/* ------------------------- Декодирование ------------------------- */

/** Словарь «токен индекс» → массив токенов (индекс = номер класса). */
export function parseVocab(text: string): string[] {
  const tokens: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line) continue;
    const sp = line.lastIndexOf(" ");
    if (sp <= 0) continue;
    const idx = Number(line.slice(sp + 1));
    if (Number.isInteger(idx)) tokens[idx] = line.slice(0, sp);
  }
  return tokens;
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Жадное CTC: argmax по кадру, схлопнуть повторы, убрать blank (последний класс).
 * Сегменты делятся по паузам ≥ ~0.64 с, тайминги — по кадрам (40 мс), от offsetSec.
 */
export function ctcDecode(
  logProbs: ArrayLike<number>,
  frames: number,
  classes: number,
  vocab: string[],
  offsetSec = 0,
): AsrSegment[] {
  const blank = classes - 1;
  const segs: AsrSegment[] = [];
  let cur: { first: number; last: number; text: string } | null = null;
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    let bestV = -Infinity;
    const base = t * classes;
    for (let c = 0; c < classes; c++) {
      const v = logProbs[base + c];
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best !== prev && best !== blank) {
      const piece = (vocab[best] ?? "").replace(/▁/g, " ");
      if (piece) {
        // Знак препинания после паузы — продолжение прежней фразы, а не новый сегмент.
        const punct = /^[.,!?;:…]+$/.test(piece.trim());
        if (cur && !punct && t - cur.last > SEGMENT_GAP_FRAMES) {
          segs.push(finish(cur, offsetSec));
          cur = null;
        }
        if (!cur) cur = { first: t, last: t, text: "" };
        cur.text += piece;
        cur.last = t;
      }
    }
    prev = best;
  }
  if (cur) segs.push(finish(cur, offsetSec));
  return segs.filter((s) => s.text);
}

function finish(c: { first: number; last: number; text: string }, offsetSec: number): AsrSegment {
  return {
    start: offsetSec + c.first * FRAME_SEC,
    end: offsetSec + (c.last + 1) * FRAME_SEC,
    text: c.text.replace(/\s+/g, " ").trim(),
  };
}

/* ------------------------- Сессия ONNX ------------------------- */

interface OrtTensor {
  data: ArrayLike<number>;
  dims: readonly number[];
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?: () => Promise<void>;
}
interface OrtLike {
  InferenceSession: { create(p: string, o?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: unknown, dims: number[]) => OrtTensor;
}

interface Loaded {
  ort: OrtLike;
  session: OrtSession;
  vocab: string[];
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function unload(): void {
  const l = loaded;
  loaded = null;
  loading = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (l?.session.release) void Promise.resolve(l.session.release()).catch(() => undefined);
}

async function ensureLoaded(): Promise<Loaded> {
  if (loaded) return loaded;
  if (loading) return loading;
  loading = (async () => {
    if (!isInstalled()) throw new Error("gigaam_not_installed");
    const ort = loadOrt() as unknown as OrtLike | null;
    if (!ort) throw new Error("runtime_missing");
    const threads = Math.round(Number(cfg().threads) || 0);
    const options: Record<string, unknown> = {
      // int8-граф: DirectML/CUDA для него не нужны, процессор считает быстрее речи.
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    };
    if (threads > 0) options.intraOpNumThreads = Math.min(threads, 32);
    const session = await ort.InferenceSession.create(modelPath(), options);
    const vocab = parseVocab(fs.readFileSync(vocabPath(), "utf8"));
    if (vocab.length < 2) throw new Error("gigaam_bad_vocab");
    const l: Loaded = { ort, session, vocab };
    loaded = l;
    logger.info("gigaam.session", { classes: vocab.length });
    return l;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Загрузить модель заранее (вход на страницу «Лекторий»): первый запрос не ждёт старта сессии. */
export function warmup(): boolean {
  if (loaded || loading) return false;
  if (preferred() !== "gigaam" || !isInstalled() || !runtimeAvailable()) return false;
  void ensureLoaded()
    .then(() => touchIdle())
    .catch(() => undefined);
  return true;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

/* ------------------------- Расшифровка ------------------------- */

/** Окно речи (≤ 25 с) → сегменты. */
async function recognizeWindow(
  l: Loaded,
  samples: Float32Array,
  offsetSec: number,
): Promise<AsrSegment[]> {
  const { data, frames } = logMel(samples);
  if (frames < 4) return [];
  const feeds = {
    features: new l.ort.Tensor("float32", data, [1, N_MELS, frames]),
    feature_lengths: new l.ort.Tensor("int64", BigInt64Array.from([BigInt(frames)]), [1]),
  };
  const res = await l.session.run(feeds);
  const out = res.log_probs ?? Object.values(res)[0];
  const dims = out.dims;
  const classes = Number(dims[dims.length - 1]);
  const outFrames = Number(dims[dims.length - 2]);
  return ctcDecode(out.data, outFrames, classes, l.vocab, offsetSec);
}

/** Расшифровка WAV-файла: { text, segments } — как у whisper-пути. */
export async function transcribeWav(
  wavPath: string,
): Promise<{ text: string; segments: AsrSegment[] }> {
  const l = await ensureLoaded();
  const wav = readWav(wavPath);
  const samples = resampleTo16k(wav.samples, wav.sampleRate);
  const segments: AsrSegment[] = [];
  for (const [a, b] of planWindows(samples)) {
    segments.push(...(await recognizeWindow(l, samples.subarray(a, b), a / SAMPLE_RATE)));
  }
  touchIdle();
  const text = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:…])/g, "$1")
    .trim();
  return { text, segments };
}

/** Выгрузить сессию (тесты и смена модели). */
export function unloadForTests(): void {
  unload();
}
