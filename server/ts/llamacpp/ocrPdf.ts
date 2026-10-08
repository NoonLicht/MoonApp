/**
 * PDF для распознавания: файл кладётся во временную папку, страницы отдаются картинками PNG
 * (рендер pdf-parse), а клиент гонит каждую страницу через Chandra OCR 2 и собирает заметку.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "../config";

interface PdfParser {
  getScreenshot(p: {
    partial?: number[];
    desiredWidth?: number;
    imageDataUrl?: boolean;
    imageBuffer?: boolean;
  }): Promise<{ total: number; pages: { data: Uint8Array }[] }>;
  destroy(): Promise<void>;
}

function parser(data: Buffer): PdfParser {
  const { PDFParse } = require("pdf-parse") as { PDFParse: new (o: { data: Buffer }) => PdfParser };
  return new PDFParse({ data });
}

const TTL_MS = 3 * 60 * 60 * 1000;
const MAX_PAGES = 500;
const docs = new Map<string, { file: string; pages: number; timer: NodeJS.Timeout }>();

const dir = (): string => path.join(config.DIRS.tmp, "ocr-pdf");

export function closePdf(id: string): void {
  const d = docs.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  docs.delete(id);
  fs.rm(d.file, { force: true }, () => undefined);
}

/** Принять PDF: проверить, что он читается, и вернуть число страниц. */
export async function openPdf(data: Buffer): Promise<{ id: string; pages: number }> {
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not_pdf");
  const p = parser(data);
  const total = await p
    .getScreenshot({ partial: [1], desiredWidth: 200, imageDataUrl: false })
    // Страница 1 заодно проверяет, что документ открывается (зашифрованный упадёт здесь).
    .then((r) => r.total)
    .catch((e: Error) => {
      throw new Error(`pdf_unreadable: ${String(e.message).slice(0, 120)}`, { cause: e });
    })
    .finally(() => p.destroy().catch(() => undefined));
  if (!total) throw new Error("pdf_empty");
  if (total > MAX_PAGES) throw new Error("pdf_too_long");
  fs.mkdirSync(dir(), { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const file = path.join(dir(), `${id}.pdf`);
  fs.writeFileSync(file, data);
  const timer = setTimeout(() => closePdf(id), TTL_MS);
  timer.unref?.();
  docs.set(id, { file, pages: total, timer });
  return { id, pages: total };
}

/** Страница PDF (нумерация с 1) картинкой PNG шириной `width` пикселей. */
export async function renderPdfPage(id: string, page: number, width = 1800): Promise<Buffer> {
  const d = docs.get(id);
  if (!d) throw new Error("pdf_expired");
  if (!Number.isInteger(page) || page < 1 || page > d.pages) throw new Error("bad_page");
  const p = parser(fs.readFileSync(d.file));
  try {
    const r = await p.getScreenshot({
      partial: [page],
      desiredWidth: Math.min(3000, Math.max(600, width)),
      imageDataUrl: false,
      imageBuffer: true,
    });
    const shot = r.pages[0];
    if (!shot) throw new Error("render_failed");
    return Buffer.from(shot.data);
  } finally {
    await p.destroy().catch(() => undefined);
  }
}
