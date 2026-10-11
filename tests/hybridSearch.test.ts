import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Гибридный поиск: разбор запроса, RRF и полнотекстовый индекс FTS5
 * (server/ts/hybridRank.ts, ftsIndex.ts). FTS проверяем на настоящей SQLite.
 */
const req = createRequire(import.meta.url);

let rank: any;
let fts: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fts-"));
  rank = req("../server/hybridRank");
  fts = req("../server/ftsIndex");
});

describe("hybridRank: запрос", () => {
  it("режет на токены, выкидывает короткие и приводит к нижнему регистру", () => {
    expect(rank.tokenize("Я купил КОФЕ-машину, 2 шт.")).toEqual(["купил", "кофе", "машину", "шт"]);
  });

  it("стемминг отрезает окончание у длинных слов, числа не трогает", () => {
    expect(rank.stem("заметками")).toBe("заметка");
    expect(rank.stem("дом")).toBe("дом");
    expect(rank.stem("2026")).toBe("2026");
  });

  it("ftsMatch: префиксы через OR, спецсимволы обезврежены", () => {
    expect(rank.ftsMatch("заметками про отпуск")).toBe('"заметка"* OR "про"* OR "отпу"*');
    expect(rank.ftsMatch('AND NEAR "x" *')).not.toContain("*)");
    expect(rank.ftsMatch("   ")).toBe("");
  });
});

describe("hybridRank: RRF", () => {
  const A = { source: "note", ref: "a" };
  const B = { source: "note", ref: "b" };
  const C = { source: "note", ref: "c" };

  it("документ, найденный в обоих списках, поднимается выше", () => {
    const r = rank.rrf([
      [A, B],
      [C, B],
    ]);
    expect(r[0].item.ref).toBe("b");
    expect(r[0].ranks).toEqual([2, 2]);
  });

  it("одинаковый ref в разных источниках — разные документы", () => {
    const r = rank.rrf([[{ source: "note", ref: "x" }], [{ source: "task", ref: "x" }]]);
    expect(r).toHaveLength(2);
  });

  it("вес списка влияет на порядок", () => {
    const r = rank.rrf([[A], [B]], { weights: [1, 3] });
    expect(r[0].item.ref).toBe("b");
  });
});

describe("ftsIndex: BM25 на SQLite", () => {
  it("находит слово из любого места документа, а не только из сниппета", () => {
    const long = "вступление ".repeat(80) + "секретнаяфраза в самом конце";
    fts.ftsPut("note", "n1", "Длинная", [long]);
    const hits = fts.ftsSearch("секретнаяфраза");
    expect(hits.map((h: any) => h.ref)).toContain("n1");
  });

  it("форма слова: «заметками» находит «заметка»", () => {
    fts.ftsPut("note", "n2", "Идеи", ["моя первая заметка про отпуск"]);
    expect(fts.ftsSearch("заметками").map((h: any) => h.ref)).toContain("n2");
  });

  it("совпадение в заголовке весит больше, чем в теле", () => {
    fts.ftsPut("note", "t1", "Квартальный отчёт", ["прочий текст"]);
    fts.ftsPut("note", "t2", "Прочее", ["в тексте упомянут квартальный отчёт один раз"]);
    const hits = fts.ftsSearch("квартальный отчёт");
    expect(hits[0].ref).toBe("t1");
  });

  it("фильтр по источникам и схлопывание кусков одного документа", () => {
    fts.ftsPut("task", "k1", "Купить", ["молоко", "молоко ещё раз", "молоко и хлеб"]);
    fts.ftsPut("note", "k2", "Список", ["молоко"]);
    const all = fts.ftsSearch("молоко");
    expect(all.filter((h: any) => h.ref === "k1")).toHaveLength(1);
    const onlyTasks = fts.ftsSearch("молоко", { sources: ["task"] });
    expect(onlyTasks.every((h: any) => h.source === "task")).toBe(true);
  });

  it("повторный ftsPut заменяет куски, ftsRemove удаляет", () => {
    fts.ftsPut("note", "r1", "Т", ["старыйтекст"]);
    fts.ftsPut("note", "r1", "Т", ["новыйтекст"]);
    expect(fts.ftsSearch("старыйтекст")).toHaveLength(0);
    expect(fts.ftsSearch("новыйтекст")).toHaveLength(1);
    expect(fts.ftsHas("note", "r1")).toBe(true);
    fts.ftsRemove("note", "r1");
    expect(fts.ftsHas("note", "r1")).toBe(false);
  });

  it("мусорный запрос не бросает исключений", () => {
    expect(() => fts.ftsSearch('"(*) OR AND NEAR/2')).not.toThrow();
    expect(fts.ftsSearch("")).toEqual([]);
  });
});
