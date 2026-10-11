import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
import { PDFDocument } from "pdf-lib";

/** Фото → чек-лист и сканер PDF (photoChecklist.ts, scanPdf.ts). */
const req = createRequire(import.meta.url);
let pc: any;
let sp: any;
beforeAll(() => {
  pc = req("../server/photoChecklist");
  sp = req("../server/scanPdf");
});

describe("разбор распознанного текста", () => {
  it("заголовок, пункты, выполненные и важные", () => {
    const text = [
      "План на неделю",
      "☐ Купить молоко",
      "[x] Позвонить маме",
      "- сдать отчёт!",
      "2) оплатить интернет",
      "| _ ~ ||",
      "…",
    ].join("\n");
    const r = pc.parseChecklist(text);
    expect(r.title).toBe("План на неделю");
    expect(r.items).toEqual([
      { text: "Купить молоко", done: false, important: false },
      { text: "Позвонить маме", done: true, important: false },
      { text: "Сдать отчёт", done: false, important: true },
      { text: "Оплатить интернет", done: false, important: false },
    ]);
    expect(r.dropped).toBe(2);
  });

  it("первая строка с маркером — это пункт, а не заголовок", () => {
    const r = pc.parseChecklist("- первый пункт\n- второй пункт");
    expect(r.title).toBe("");
    expect(r.items).toHaveLength(2);
  });

  it("шум и очень короткие строки отбрасываются; лимит пунктов соблюдается", () => {
    const many = Array.from({ length: 100 }, (_, i) => `- пункт номер ${i}`).join("\n");
    expect(pc.parseChecklist(many, { maxItems: 10 }).items).toHaveLength(10);
    expect(pc.parseChecklist("12 345 678\n.....\nab").items).toEqual([]);
  });

  it("заметка содержит картинку и чекбоксы; имя файла безопасно", () => {
    const c = { title: "Покупки", items: [{ text: "Хлеб", done: true, important: false }, { text: "Сыр", done: false, important: true }], dropped: 0 };
    const md = pc.checklistNote(c, { imageUrl: "/api/myspace/assets/abc", when: "2026-10-12 09:30" });
    expect(md).toContain("![Фото](/api/myspace/assets/abc)");
    expect(md).toContain("- [x] Хлеб");
    expect(md).toContain("- [ ] Сыр ❗");
    expect(pc.noteName('Пл:ан/на "день"', "2026-10-12 09:30")).toBe("Из фото/Пл ан на день 2026-10-12-09-30.md");
  });
});

describe("сканер PDF", () => {
  // минимальные валидные PNG и JPEG-подпись
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("распознаёт формат по сигнатуре", () => {
    expect(sp.sniff(png)).toBe("png");
    expect(sp.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpg");
    expect(sp.sniff(Buffer.from("GIF89a...."))).toBeNull();
  });

  it("собирает многостраничный PDF и кладёт текст в метаданные", async () => {
    const buf = await sp.buildPdf([{ data: png, mime: "image/png" }, { data: png, mime: "" }], {
      title: "Договор",
      text: "арендатор арендодатель",
    });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe("Договор");
    expect(doc.getKeywords()).toContain("арендатор");
  });

  it("не принимает не-картинки и пустой набор", async () => {
    await expect(sp.buildPdf([], {})).rejects.toThrow("no_pages");
    await expect(sp.buildPdf([{ data: Buffer.from("текст"), mime: "" }], {})).rejects.toThrow("unsupported_image");
  });
});
