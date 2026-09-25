/**
 * OCR: распознавание текста с изображения (скриншот → текст в буфер).
 *
 * tesseract.js — чистый JS + WebAssembly (без нативных биндингов, в отличие
 * от классического tesseract/tesseract-ocr, установка которого требует
 * системный бинарь и была бы рискованной автономной установкой ночью).
 * Скачанные языковые модели (.traineddata) кэшируются в storage/ocr — первое
 * распознавание требует интернет (~несколько МБ на язык), дальше работает
 * офлайн, тем же принципом, что модели Whisper/апскейла в проекте.
 */
import config from "./config";
import logger from "./logger";

const { DIRS } = config;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TesseractWorker = any;

let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Tesseract = require("tesseract.js");
      const worker = await Tesseract.createWorker(["rus", "eng"], 1, {
        cachePath: DIRS.ocr,
      });
      return worker;
    })().catch((e) => {
      workerPromise = null; // не кэшируем провал — следующий вызов попробует снова
      throw e;
    });
  }
  return workerPromise;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export async function recognize(imageBuffer: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  logger.info("ocr.recognize", { chars: (data.text || "").length, confidence: data.confidence });
  return { text: data.text || "", confidence: data.confidence || 0 };
}

/** Освобождает воркер (память/WASM-инстанс) — вызывается при остановке сервера. */
export async function terminate(): Promise<void> {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* ignore */
  } finally {
    workerPromise = null;
  }
}
