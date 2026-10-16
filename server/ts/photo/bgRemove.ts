/**
 * Удаление фона: BiRefNet (MIT) через onnxruntime-node.
 *
 * Пайплайн: ffmpeg приводит картинку к 1024×1024 RGB → ImageNet-нормализация → ONNX →
 * карта значимости (сигмоида, если модель отдала логиты) → серая маска 1024×1024.
 * Дальше ffmpeg растягивает маску до размера оригинала и вклеивает её как альфа-канал,
 * поэтому качество и размер исходника сохраняются, а отдельной графической библиотеки не нужно.
 */
import fs from "fs";
import path from "path";
import logger from "../logger";
import settings from "../settings";
import { loadOrt, providerOrder } from "../upscale/runtime";
import { probeMedia } from "../mediaProbe";
import { isInstalled, modelFile, PHOTO_DIR } from "./modelStore";
import { runFfmpeg } from "./ff";

const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

interface OrtTensor {
  data: Float32Array;
  dims: number[];
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?: () => Promise<void>;
}
interface OrtLike {
  InferenceSession: { create(p: string, o?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

let session: { id: string; s: OrtSession; ort: OrtLike; provider: string } | null = null;
/** Провайдеры, которые уже падали при расчёте (DirectML умеет терять устройство) — до перезапуска не берём. */
const badProviders = new Set<string>();
let idle: NodeJS.Timeout | null = null;

export const OUT_DIR = path.join(PHOTO_DIR, "out");

export function unload(): void {
  const cur = session;
  session = null;
  if (idle) clearTimeout(idle);
  idle = null;
  if (cur?.s.release) void Promise.resolve(cur.s.release()).catch(() => undefined);
}

async function getSession(id: string): Promise<NonNullable<typeof session>> {
  if (session && session.id === id) return session;
  unload();
  if (!isInstalled(id)) throw new Error("model_not_installed");
  const ort = loadOrt() as unknown as OrtLike | null;
  if (!ort) throw new Error("runtime_missing");
  const pref = String(
    (settings.get("upscaler") as { provider?: unknown } | undefined)?.provider || "auto",
  );
  let lastErr: unknown = null;
  // DirectML на графе BiRefNet нестабилен (теряет устройство со второго запуска) и не быстрее CPU,
  // поэтому по умолчанию считаем на процессоре; видеокарта — только по явному выбору CUDA.
  const order = pref === "cuda" || pref === "tensorrt" ? providerOrder(pref) : ["cpu"];
  for (const provider of order.filter((p) => p === "cpu" || !badProviders.has(p))) {
    try {
      const s = await ort.InferenceSession.create(modelFile(id), {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });
      session = { id, s, ort, provider };
      logger.info("photo.bgremove.session", { id, provider });
      return session;
    } catch (e) {
      lastErr = e;
      logger.warn("photo.bgremove.provider_failed", {
        provider,
        error: String((e as Error).message).slice(0, 200),
      });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("session_failed");
}

/** Сырые RGB-пиксели 1024×1024 → тензор CHW с нормализацией. */
export function toTensorData(rgb: Buffer): Float32Array {
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

/** Выход модели → маска 0..255 (сигмоида, если значения вышли за [0, 1]). */
export function toMask(data: ArrayLike<number>): Buffer {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const logits = min < 0 || max > 1;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = logits ? 1 / (1 + Math.exp(-data[i])) : data[i];
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return out;
}

export type BgMode = "cutout" | "mask" | "color";
export interface BgOptions {
  model?: string;
  mode?: BgMode;
  /** Цвет фона для режима color (#rrggbb). */
  color?: string;
}

export async function removeBackground(
  input: string,
  output: string,
  opts: BgOptions = {},
): Promise<{ output: string; provider: string; sec: number }> {
  const t0 = Date.now();
  const mode: BgMode = opts.mode === "mask" || opts.mode === "color" ? opts.mode : "cutout";
  const model = opts.model || "birefnet-lite";
  const s = await getSession(model);
  if (idle) clearTimeout(idle);
  idle = setTimeout(unload, IDLE_UNLOAD_MS);
  idle.unref?.();

  const rgb = await runFfmpeg([
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${SIZE}:${SIZE}:flags=bicubic,format=rgb24`,
    "-f",
    "rawvideo",
    "-",
  ]);
  if (rgb.length < SIZE * SIZE * 3) throw new Error("decode_failed");

  const feed = toTensorData(rgb);
  let cur = s;
  let last: OrtTensor | undefined;
  for (;;) {
    try {
      const tensor = new cur.ort.Tensor("float32", feed, [1, 3, SIZE, SIZE]);
      const res = await cur.s.run({ [cur.s.inputNames[0]]: tensor });
      last = res[cur.s.outputNames[cur.s.outputNames.length - 1]];
      break;
    } catch (e) {
      // Расчёт на видеокарте упал (потеря устройства/нехватка памяти) — повторяем на следующем провайдере.
      if (cur.provider === "cpu") throw e;
      badProviders.add(cur.provider);
      logger.warn("photo.bgremove.run_failed", {
        provider: cur.provider,
        error: String((e as Error).message).slice(0, 200),
      });
      unload();
      cur = await getSession(model);
    }
  }
  if (!last?.data) throw new Error("bad_model_output");
  const mask = toMask(last.data);
  const provider = cur.provider;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const maskRaw = path.join(OUT_DIR, `mask_${Date.now()}.raw`);
  fs.writeFileSync(maskRaw, mask);
  try {
    const info = await probeMedia({ kind: "file", path: input });
    const w = info.video?.width || SIZE;
    const h = info.video?.height || SIZE;
    const maskIn = ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${SIZE}x${SIZE}`, "-i", maskRaw];
    if (mode === "mask") {
      await runFfmpeg([
        "-y",
        ...maskIn,
        "-vf",
        `scale=${w}:${h}:flags=bicubic`,
        "-frames:v",
        "1",
        output,
      ]);
    } else if (mode === "color") {
      const color = /^#?[0-9a-f]{6}$/i.test(opts.color || "")
        ? String(opts.color).replace("#", "")
        : "ffffff";
      await runFfmpeg([
        "-y",
        "-i",
        input,
        ...maskIn,
        "-f",
        "lavfi",
        "-i",
        `color=c=0x${color}:s=${w}x${h}`,
        "-filter_complex",
        `[1:v]scale=${w}:${h}:flags=bicubic[m];[0:v]format=rgba[a];[a][m]alphamerge[fg];[2:v][fg]overlay=shortest=1,format=rgb24`,
        "-frames:v",
        "1",
        output,
      ]);
    } else {
      await runFfmpeg([
        "-y",
        "-i",
        input,
        ...maskIn,
        "-filter_complex",
        `[1:v]scale=${w}:${h}:flags=bicubic[m];[0:v]format=rgba[a];[a][m]alphamerge`,
        "-frames:v",
        "1",
        output,
      ]);
    }
  } finally {
    fs.rmSync(maskRaw, { force: true });
  }
  return { output, provider, sec: Math.round((Date.now() - t0) / 100) / 10 };
}
