import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Карта белых пятен (server/ts/knowledgeGaps.ts). */
const req = createRequire(import.meta.url);
let g: any;
beforeAll(() => {
  g = req("../server/knowledgeGaps");
});

const note = (title: string, text: string) => ({ ref: `${title}.md`, title, text });

describe("частые темы", () => {
  it("считает документы со словом, отсекая редкие", () => {
    const docs = [
      note("A", "нейросети обучение данные"),
      note("B", "нейросети архитектура"),
      note("C", "нейросети и оптимизация"),
      note("D", "кулинария борщ"),
    ];
    const t = g.topTopics(docs, { minDocs: 3 });
    expect(t).toEqual([{ term: "нейросети", docs: 3 }]);
  });
});

describe("висячие ссылки", () => {
  it("находит ссылки на несуществующие заметки и считает упоминания", () => {
    const docs = [
      note("Проект", "см. [[Бюджет]] и [[Риски|риски]], а ещё [[Бюджет]]"),
      note("Бюджет", "числа"),
      note("Идеи", "[[Риски]] и [[task:42]] и ![[картинка.png]]"),
    ];
    const d = g.danglingLinks(docs);
    expect(d).toEqual([{ target: "Риски", mentions: 2, from: ["Проект", "Идеи"] }]);
  });

  it("путь в ссылке сопоставляется с именем заметки", () => {
    const docs = [note("Main", "[[Папка/Цель]]"), note("Цель", "x")];
    expect(g.danglingLinks(docs)).toEqual([]);
  });
});

describe("покрытие и подсказки", () => {
  const docs = [
    note("1", "градиентный спуск и обратное распространение"),
    note("2", "градиентный спуск для регрессии"),
    note("3", "про кошек"),
  ];

  it("тема покрыта, если все её слова есть в документе", () => {
    expect(g.coverageOf("градиентный спуск", docs)).toBe(2);
    expect(g.coverageOf("обратное распространение", docs)).toBe(1);
    expect(g.coverageOf("регуляризация", docs)).toBe(0);
    expect(g.coverageOf("", docs)).toBe(0);
  });

  it("разбирает список модели без маркеров и пояснений", () => {
    const out = g.parseSuggestions(
      "1. Регуляризация — предотвращает переобучение\n- «Батч-нормализация»\n* Регуляризация\n\n" +
        "Очень длинная строка которая явно не является названием темы вообще никак",
    );
    expect(out).toEqual(["Регуляризация", "Батч-нормализация"]);
  });

  it("отчёт ставит пятна (≤1 документа) первыми", () => {
    const r = g.gapReport("нейросети", ["градиентный спуск", "регуляризация", "обратное распространение"], docs);
    expect(r.items.map((i: any) => [i.topic, i.docs, i.gap])).toEqual([
      ["регуляризация", 0, true],
      ["обратное распространение", 1, true],
      ["градиентный спуск", 2, false],
    ]);
  });
});
