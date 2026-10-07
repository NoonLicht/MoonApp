/**
 * OCR для перевода изображений: Tesseract (WASM) возвращает абзацы с рамками.
 * Языковые данные кэшируются в storage/ocr (общий кэш со скриншотным OCR).
 * Распознанный текст переводит TranslateGemma, а рамки нужны, чтобы нарисовать
 * перевод поверх исходной картинки.
 */
import config from "../config";
import logger from "../logger";
import { TESS_LANG } from "./languages";

const { DIRS } = config;

export interface OcrBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Средняя высота строки — по ней подбирается размер шрифта перевода. */
  lineH: number;
  text: string;
  confidence: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Worker = any;
let cached: { key: string; worker: Promise<Worker> } | null = null;

async function getWorker(langs: string[]): Promise<Worker> {
  const key = langs.join("+");
  if (cached?.key === key) return cached.worker;
  if (cached) {
    const old = cached.worker;
    void old.then((w: Worker) => w.terminate()).catch(() => {});
  }
  const worker = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Tesseract = require("tesseract.js");
    return Tesseract.createWorker(langs, 1, { cachePath: DIRS.ocr });
  })();
  cached = { key, worker };
  worker.catch(() => {
    if (cached?.worker === worker) cached = null;
  });
  return worker;
}

export const ocrLanguage = (src: string): string | null => TESS_LANG[src] ?? null;

interface TessPara {
  text?: string;
  confidence?: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  lines?: { bbox: { y0: number; y1: number } }[];
}

export async function recognizeBlocks(image: Buffer, srcLang: string): Promise<OcrBlock[]> {
  const lang = ocrLanguage(srcLang);
  if (!lang) throw new Error("ocr_language_unsupported");
  // Английский добавляем всегда: цифры, URL и латиница встречаются в любом тексте.
  const langs = lang === "eng" ? ["eng"] : [lang, "eng"];
  const worker = await getWorker(langs);
  const { data } = await worker.recognize(image, {}, { blocks: true });
  const out: OcrBlock[] = [];
  for (const b of (data.blocks || []) as { paragraphs?: TessPara[] }[]) {
    for (const p of b.paragraphs || []) {
      const text = String(p.text || "")
        .replace(/-\n(?=\p{Ll})/gu, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
      if (!text || !/\p{L}/u.test(text)) continue;
      const lines = p.lines || [];
      const lineH = lines.length
        ? lines.reduce((n, l) => n + (l.bbox.y1 - l.bbox.y0), 0) / lines.length
        : p.bbox.y1 - p.bbox.y0;
      out.push({
        x: p.bbox.x0,
        y: p.bbox.y0,
        w: p.bbox.x1 - p.bbox.x0,
        h: p.bbox.y1 - p.bbox.y0,
        lineH,
        text,
        confidence: p.confidence ?? 0,
      });
    }
  }
  logger.info("translate.ocr", { lang, blocks: out.length });
  return out.filter((b) => b.confidence >= 25);
}

export async function terminateOcr(): Promise<void> {
  if (!cached) return;
  const w = cached.worker;
  cached = null;
  try {
    await (await w).terminate();
  } catch {
    /* ignore */
  }
}
