/**
 * Сканер документов: собирает PDF из снимков (JPEG/PNG) с телефона. Каждая
 * страница — размера картинки (в пунктах), чтобы ничего не обрезалось и не
 * растягивалось. Распознанный текст кладётся в метаданные «ключевые слова».
 */
import { PDFDocument } from "pdf-lib";

export interface ScanPage {
  data: Buffer;
  mime: string;
}

const MAX_SIDE = 842 * 2; // А4 в пунктах ×2 — достаточно для чтения, не раздувает файл

/** Определяет формат по сигнатуре: mime от телефона бывает пустым или неверным. */
export function sniff(data: Buffer): "jpg" | "png" | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  return null;
}

export async function buildPdf(pages: ScanPage[], o: { title?: string; text?: string } = {}): Promise<Buffer> {
  if (!pages.length) throw new Error("no_pages");
  const doc = await PDFDocument.create();
  if (o.title) doc.setTitle(o.title.slice(0, 120));
  doc.setProducer("MoonApp");
  if (o.text) doc.setKeywords([o.text.replace(/\s+/g, " ").slice(0, 900)]);
  for (const p of pages) {
    const kind = sniff(p.data);
    if (!kind) throw new Error("unsupported_image");
    const img = kind === "jpg" ? await doc.embedJpg(p.data) : await doc.embedPng(p.data);
    const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.round(img.width * k);
    const h = Math.round(img.height * k);
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await doc.save());
}
