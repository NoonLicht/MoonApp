import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Вопрос по записи лекции: отбор отрывков и разбор ссылок на таймкоды. */
const req = createRequire(import.meta.url);
let la: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-la-"));
  la = req("../server/lectureAsk");
});

const chunks = [
  { start_ms: 0, end_ms: 30000, text: "Сегодня поговорим про организацию курса и экзамены" },
  { start_ms: 30000, end_ms: 90000, text: "Энтропия измеряет неопределённость источника сообщений" },
  { start_ms: 3_725_000, end_ms: 3_790_000, text: "Через энтропию определяется и количество информации" },
  { start_ms: 90000, end_ms: 120000, text: "   " },
];

describe("lectureAsk", () => {
  it("находит отрывки по смыслу слова, в том числе в другой форме", () => {
    const p = la.pickPassages(chunks, "Что такое энтропией?");
    expect(p.map((x: any) => x.startMs)).toEqual([30000, 3_725_000]);
  });

  it("пустой вопрос и вопрос без совпадений дают пустой список", () => {
    expect(la.pickPassages(chunks, "")).toEqual([]);
    expect(la.pickPassages(chunks, "квантовая гравитация")).toEqual([]);
  });

  it("промпт содержит метки времени и вопрос", () => {
    const p = la.pickPassages(chunks, "энтропия");
    const prompt = la.buildPrompt("Что такое энтропия?", p);
    expect(prompt).toContain("[00:00:30]");
    expect(prompt).toContain("[01:02:05]");
    expect(prompt).toContain("Что такое энтропия?");
  });

  it("ссылки разбираются в миллисекунды без повторов", () => {
    const c = la.parseCitations("Это мера [00:00:30]. И ещё [1:02:05], снова [00:00:30] и [02:10].");
    expect(c.map((x: any) => x.ms)).toEqual([30000, 3_725_000, 130000]);
    expect(c[1].label).toBe("01:02:05");
  });
});

describe("«я пропустил»", () => {
  it("отбирает отрывки, пересекающие интервал, по порядку", () => {
    const p = la.passagesInRange(chunks, 20_000, 100_000);
    expect(p.map((x: any) => x.startMs)).toEqual([0, 30000]);
    expect(la.passagesInRange(chunks, 200_000, 300_000)).toEqual([]);
    // пустые фрагменты не попадают
    expect(la.passagesInRange(chunks, 90_000, 120_000)).toEqual([]);
  });
});
