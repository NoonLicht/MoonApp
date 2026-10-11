import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Разбор OCR-текста чека (server/ts/receiptParser.ts). */
const req = createRequire(import.meta.url);
let rp: any;
beforeAll(() => {
  rp = req("../server/receiptParser");
});

const RECEIPT = `ООО "Пятёрочка"
г. Москва, ул. Ленина 5
КАССОВЫЙ ЧЕК  Приход
Дата 14.03.2026 18:42
1. Молоко 3.2% 0.93л   89,90
2. Хлеб Бородинский   2 х 45,00 = 90,00
3. Аспирин таблетки  1 299,50
4. Пакет майка   7,00
НДС 20%   35,10
ИТОГО   486,40
Наличными   500,00
Сдача   13,60`;

describe("receiptParser", () => {
  it("находит магазин, дату и итог", () => {
    const r = rp.parseReceipt(RECEIPT);
    expect(r.merchant).toContain("Пятёрочка");
    expect(r.date).toBe("2026-03-14");
    expect(r.total).toBe(486.4);
  });

  it("берёт позиции, отбрасывая НДС, налички и сдачу", () => {
    const r = rp.parseReceipt(RECEIPT);
    expect(r.items.map((i: any) => i.amount)).toEqual([89.9, 90, 1299.5, 7]);
    expect(r.items[1].name).toBe("Хлеб Бородинский");
  });

  it("раскладывает по категориям", () => {
    const r = rp.parseReceipt(RECEIPT);
    expect(r.items.map((i: any) => i.category)).toEqual(["Еда", "Еда", "Здоровье", "Другое"]);
  });

  it("считает расхождение суммы позиций с итогом", () => {
    const r = rp.parseReceipt(RECEIPT);
    expect(r.mismatch).toBe(Math.round((89.9 + 90 + 1299.5 + 7 - 486.4) * 100) / 100);
    expect(rp.parseReceipt("Магазин\nХлеб 50,00\nИТОГО 50,00").mismatch).toBe(0);
  });

  it("пустой и мусорный текст не падает", () => {
    expect(rp.parseReceipt("").items).toEqual([]);
    expect(rp.parseReceipt("@@## ~~").total).toBeNull();
  });

  it("дата в формате с двузначным годом и ISO", () => {
    expect(rp.parseDate("от 01.02.26")).toBe("2026-02-01");
    expect(rp.parseDate("2025-12-31T10:00")).toBe("2025-12-31");
    expect(rp.parseDate("99.99.2026")).toBe("");
  });
});
