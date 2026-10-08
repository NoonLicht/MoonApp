/**
 * Распознавание картинки из заметки (Chandra OCR 2 в встроенном llama.cpp):
 * загрузка картинки → подгонка размера → модель → Markdown с вырезанными рисунками.
 */
import { api } from "@/api/client";
import { BASE, pageHeaders, tokenHeaders } from "@/api/apiHttp";
import { chandraToMarkdown } from "@/lib/chandraMarkdown";
import type { Bbox } from "@/lib/chandraMarkdown";

export type OcrDevice = "auto" | "cpu" | "gpu" | "vulkan" | "cuda";

export interface OcrPrefs {
  /** Файл GGUF; пусто — первая установленная модель Chandra. */
  model: string;
  device: OcrDevice;
}

const KEY = "moonapp.noteOcr";
const DEVICES: OcrDevice[] = ["auto", "cpu", "gpu", "vulkan", "cuda"];

export function loadOcrPrefs(): OcrPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<OcrPrefs>;
    return {
      model: typeof j.model === "string" ? j.model : "",
      device: DEVICES.includes(j.device as OcrDevice) ? (j.device as OcrDevice) : "auto",
    };
  } catch {
    return { model: "", device: "auto" };
  }
}

export function saveOcrPrefs(p: OcrPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* хранилище недоступно — настройки не запомнятся */
  }
}

/** Картинка заметки в виде Blob: свои вложения, data:-ссылки и внешние адреса (через сервер при CORS). */
export async function loadImageBlob(src: string): Promise<Blob> {
  const local = src.startsWith("/");
  try {
    const res = await fetch(local ? `${BASE}${src}` : src, {
      headers: local ? { ...tokenHeaders(), ...pageHeaders() } : undefined,
    });
    if (res.ok) {
      const b = await res.blob();
      if (b.type.startsWith("image/")) return b;
    }
  } catch {
    /* CORS или сеть: внешнюю ссылку скачает сервер */
  }
  if (/^https?:\/\//i.test(src)) return api.llamaFetchImage(src);
  throw new Error("image_unavailable");
}

const LONG_MIN = 1536;
const LONG_MAX = 2560;

function toBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas_failed"))), type, q),
  );
}

/** Размер для модели: длинная сторона 1536–2560 px (мелкий текст иначе не читается). */
async function prepare(bmp: ImageBitmap): Promise<Blob> {
  const long = Math.max(bmp.width, bmp.height);
  const k = long < LONG_MIN ? Math.min(3, LONG_MIN / long) : long > LONG_MAX ? LONG_MAX / long : 1;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas_failed");
  ctx.fillStyle = "#fff"; // прозрачный фон скриншотов иначе станет чёрным в JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return toBlob(c, "image/jpeg", 0.93);
}

async function cropBlob(bmp: ImageBitmap, bbox: Bbox): Promise<Blob | null> {
  const pad = 6;
  const [x0, y0, x1, y1] = bbox;
  const sx = Math.max(0, Math.floor((x0 / 1000) * bmp.width) - pad);
  const sy = Math.max(0, Math.floor((y0 / 1000) * bmp.height) - pad);
  const ex = Math.min(bmp.width, Math.ceil((x1 / 1000) * bmp.width) + pad);
  const ey = Math.min(bmp.height, Math.ceil((y1 / 1000) * bmp.height) + pad);
  const w = ex - sx;
  const h = ey - sy;
  if (w < 12 || h < 12) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  return toBlob(c, "image/png");
}

export interface NoteOcrResult {
  markdown: string;
  ms: number;
  tokens: number;
  build: string;
  gpu: boolean;
}

/**
 * Распознать картинку. `upload` сохраняет вырезанный рисунок как вложение заметки
 * и возвращает его ссылку.
 */
export async function recognizeNoteImage(
  src: string,
  upload: (blob: Blob, name: string) => Promise<string>,
  prefs: OcrPrefs,
  signal?: AbortSignal,
): Promise<NoteOcrResult> {
  const blob = await loadImageBlob(src);
  const bmp = await createImageBitmap(blob);
  try {
    const scaled = await prepare(bmp);
    const res = await api.llamaOcr(scaled, { model: prefs.model, device: prefs.device, signal });
    const markdown = await chandraToMarkdown(res.html, async (bbox) => {
      const part = await cropBlob(bmp, bbox);
      return part ? upload(part, "figure.png") : null;
    });
    if (!markdown) throw new Error("ocr_empty");
    return { markdown, ms: res.ms, tokens: res.tokens, build: res.build, gpu: res.gpu };
  } finally {
    bmp.close();
  }
}
