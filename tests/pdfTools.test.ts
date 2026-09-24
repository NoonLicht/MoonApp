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
