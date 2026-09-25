import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as pdfTools from "../server/pdfTools";

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe("server/pdfTools — parsePageRanges", () => {
  it("разбирает диапазоны и одиночные страницы, сортирует и дедуплицирует", () => {
    expect(pdfTools.parsePageRanges("1-3,5,7-9", 20)).toEqual([1, 2, 3, 5, 7, 8, 9]);
    expect(pdfTools.parsePageRanges("5,1,3", 20)).toEqual([1, 3, 5]);
    expect(pdfTools.parsePageRanges("1-3,2-4", 20)).toEqual([1, 2, 3, 4]);
  });

  it("обрезает по maxPage и игнорирует мусор", () => {
    expect(pdfTools.parsePageRanges("1-100", 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pdfTools.parsePageRanges("abc,, 2", 5)).toEqual([2]);
  });

  it("переставляет местами обратный диапазон (5-2 -> 2..5)", () => {
    expect(pdfTools.parsePageRanges("5-2", 10)).toEqual([2, 3, 4, 5]);
  });
});

describe("server/pdfTools — merge/split/extractText на реальных PDF", () => {
  it("mergePdfs склеивает страницы в заданном порядке", async () => {
    const a = await makePdf(2);
    const b = await makePdf(3);
    const merged = await pdfTools.mergePdfs([a, b]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(5);
  });

  it("splitPdf делает по одному файлу на группу диапазонов", async () => {
    const src = await makePdf(9);
    const { zip, fileCount } = await pdfTools.splitPdf(src, "1-3,5,7-9");
    expect(fileCount).toBe(3);
    expect(zip.length).toBeGreaterThan(0);
  });

  it("splitPdf с пустыми диапазонами кидает понятную ошибку", async () => {
    const src = await makePdf(3);
    await expect(pdfTools.splitPdf(src, "")).rejects.toThrow("empty_ranges");
    await expect(pdfTools.splitPdf(src, "50-60")).rejects.toThrow("no_valid_ranges");
  });

  it("extractText на PDF без текста отдаёт пустую строку, а не падает", async () => {
    const src = await makePdf(1);
    const result = await pdfTools.extractText(src);
    expect(typeof result.text).toBe("string");
  });
});

describe("server/pdfTools — rotate/organize/watermark/pageNumbers/imagesToPdf", () => {
  it("rotatePdf выставляет угол поворота на всех страницах", async () => {
    const src = await makePdf(3);
    const out = await pdfTools.rotatePdf(src, 90);
    const doc = await PDFDocument.load(out);
    for (const page of doc.getPages()) expect(page.getRotation().angle).toBe(90);
  });

  it("rotatePdf складывает поворот с уже существующим (270 после 90 -> 0)", async () => {
    const once = await pdfTools.rotatePdf(await makePdf(1), 90);
    const twice = await pdfTools.rotatePdf(once, 270);
    const doc = await PDFDocument.load(twice);
    expect(doc.getPages()[0].getRotation().angle).toBe(0);
  });

  it("organizePdf переставляет и удаляет страницы по 1-based списку", async () => {
    const src = await PDFDocument.create();
    for (const [w] of [[100], [200], [300]] as const) src.addPage([w, 50]);
    const buf = Buffer.from(await src.save());
    const out = await pdfTools.organizePdf(buf, [3, 1]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages()[0].getWidth()).toBe(300);
    expect(doc.getPages()[1].getWidth()).toBe(100);
  });

  it("organizePdf с пустым списком кидает понятную ошибку", async () => {
    await expect(pdfTools.organizePdf(await makePdf(2), [50])).rejects.toThrow("empty_order");
  });

  it("watermarkPdf и addPageNumbers не ломают документ и сохраняют число страниц", async () => {
    const src = await makePdf(2);
    const wm = await pdfTools.watermarkPdf(src, "DRAFT", { opacity: 0.3 });
    const wmDoc = await PDFDocument.load(wm);
    expect(wmDoc.getPageCount()).toBe(2);

    const numbered = await pdfTools.addPageNumbers(src, { startAt: 5 });
    const numDoc = await PDFDocument.load(numbered);
    expect(numDoc.getPageCount()).toBe(2);
  });

  it("imagesToPdf собирает PDF из PNG с одной страницей на картинку", async () => {
    // Минимальный валидный 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const out = await pdfTools.imagesToPdf([
      { buf: png, mime: "image/png" },
      { buf: png, mime: "image/png" },
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });
});
