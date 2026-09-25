/**
 * PDF-тулкит: слияние, разбиение, поворот, организация (переупорядочивание/
 * удаление страниц), водяной знак, номера страниц, сборка PDF из изображений,
 * извлечение текста. Всё через pdf-lib (запись PDF) + pdf-parse (уже
 * зависимость проекта, используется в server/ts/bookParser.ts для книг).
 * OCR, конвертация в/из Word/PowerPoint/Excel, PDF→JPG (растеризация страниц),
 * подпись и пароль-защита сознательно не реализованы: нет
 * OCR-библиотеки/рендерера офисных форматов/шифрования PDF в зависимостях —
 * см. UI-подсказку на фронте, честно помечено недоступным, а не заглушкой.
 */
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
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

/** Поворачивает все страницы PDF на заданный угол (90/180/270 по часовой). */
export async function rotatePdf(buf: Buffer, angle: number): Promise<Buffer> {
  const doc = await PDFDocument.load(buf);
  const norm = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  for (const page of doc.getPages()) {
    page.setRotation(degrees((page.getRotation().angle + norm) % 360));
  }
  const bytes = await doc.save();
  logger.info("pdfTools.rotate", { angle: norm, pages: doc.getPageCount() });
  return Buffer.from(bytes);
}

/** Переупорядочивает и/или удаляет страницы: order — 1-based индексы в новом
 * порядке (страницы, которых нет в списке, удаляются), например "3,1,2". */
export async function organizePdf(buf: Buffer, order: number[]): Promise<Buffer> {
  const src = await PDFDocument.load(buf);
  const total = src.getPageCount();
  const indices = order.filter((n) => n >= 1 && n <= total).map((n) => n - 1);
  if (indices.length === 0) throw new Error("empty_order");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const p of copied) out.addPage(p);
  const bytes = await out.save();
  logger.info("pdfTools.organize", { totalPages: total, resultPages: out.getPageCount() });
  return Buffer.from(bytes);
}

/** Диагональный текстовый водяной знак на каждой странице. */
export async function watermarkPdf(
  buf: Buffer,
  text: string,
  opts: { opacity?: number; fontSize?: number } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.load(buf);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 0.25));
  const fontSize = opts.fontSize ?? 48;
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity,
      rotate: degrees(45),
    });
  }
  const bytes = await doc.save();
  logger.info("pdfTools.watermark", { pages: doc.getPageCount() });
  return Buffer.from(bytes);
}

/** Номера страниц внизу по центру каждой страницы. */
export async function addPageNumbers(
  buf: Buffer,
  opts: { startAt?: number } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.load(buf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const start = opts.startAt ?? 1;
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const label = String(start + i);
    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, 11);
    page.drawText(label, {
      x: width / 2 - textWidth / 2,
      y: 20,
      size: 11,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  });
  const bytes = await doc.save();
  logger.info("pdfTools.pageNumbers", { pages: doc.getPageCount() });
  return Buffer.from(bytes);
}

/** Собирает PDF из изображений (JPG/PNG), одна картинка — одна страница
 * подогнанного под неё размера. */
export async function imagesToPdf(files: { buf: Buffer; mime: string }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const isPng = /png/i.test(f.mime);
    const img = isPng ? await doc.embedPng(f.buf) : await doc.embedJpg(f.buf);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const bytes = await doc.save();
  logger.info("pdfTools.imagesToPdf", { images: files.length });
  return Buffer.from(bytes);
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
