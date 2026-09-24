/**
 * PDF-тулкит: слияние, разбиение по диапазонам страниц, извлечение текста.
 * merge/split — через pdf-lib (запись PDF), извлечение текста — через
 * pdf-parse (уже зависимость проекта, используется в server/ts/bookParser.ts
 * для книг). OCR сюда сознательно не входит: нет OCR-библиотеки/нативного
 * биндинга в зависимостях, тащить его за одну ночь без возможности
 * протестировать — слишком рискованно, поэтому OCR явно не реализован
 * (см. UI-подсказку на фронте), а не притворяется рабочим.
 */
import { PDFDocument } from "pdf-lib";
import AdmZip from "adm-zip";
import logger from "./logger";

/** "1-3,5,7-9" → [1,2,3,5,7,8,9] (1-based, как показывают в UI). */
export function parsePageRanges(spec: string, maxPage: number): number[] {
  const out = new Set<number>();
  for (const part of String(spec || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(maxPage, b); i++) out.add(i);
    } else if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (n >= 1 && n <= maxPage) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Склеивает несколько PDF в один (в порядке переданных буферов). */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  logger.info("pdfTools.merge", { inputs: buffers.length, pages: out.getPageCount() });
  return Buffer.from(bytes);
}

/**
 * Разбивает PDF по диапазону страниц на N отдельных PDF (по одному диапазону
 * на файл) и упаковывает в zip. Один диапазон → один файл (не по странице),
 * чтобы "1-3,5,7-9" дало ровно два/три логических куска, а не 7 файлов.
 */
export async function splitPdf(
  buf: Buffer,
  rangesSpec: string,
): Promise<{ zip: Buffer; fileCount: number }> {
  const src = await PDFDocument.load(buf);
  const total = src.getPageCount();
  const groups = String(rangesSpec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (groups.length === 0) throw new Error("empty_ranges");

  const zip = new AdmZip();
  let idx = 0;
  for (const group of groups) {
    const pages = parsePageRanges(group, total);
    if (pages.length === 0) continue;
    idx++;
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      src,
      pages.map((p) => p - 1),
    );
    for (const p of copied) out.addPage(p);
    const bytes = await out.save();
    zip.addFile(`part_${idx}_p${pages[0]}-${pages[pages.length - 1]}.pdf`, Buffer.from(bytes));
  }
  if (idx === 0) throw new Error("no_valid_ranges");
  logger.info("pdfTools.split", { totalPages: total, parts: idx });
  return { zip: zip.toBuffer(), fileCount: idx };
}

/** Извлекает текстовый слой PDF. Отсканированные PDF без текстового слоя дадут пустую строку — это не OCR. */
export async function extractText(buf: Buffer): Promise<{ text: string; pages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text: string; pages?: unknown[] }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return { text: result.text || "", pages: Array.isArray(result.pages) ? result.pages.length : 0 };
  } finally {
    await parser.destroy();
  }
}
