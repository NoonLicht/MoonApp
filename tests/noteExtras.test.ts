import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Теги по смыслу, шаблоны, сравнение конспектов (server/ts/noteExtras.ts). */
const req = createRequire(import.meta.url);
let ne: any;
beforeAll(() => {
  ne = req("../server/noteExtras");
});

describe("теги по смыслу", () => {
  const notes = [
    { path: "a.md", content: "Нейронные сети обучаются градиентным спуском, веса нейронов обновляются", tags: ["ml"] },
    { path: "b.md", content: "Рецепт борща: свёкла, капуста, мясо, варить час", tags: ["кулинария"] },
    { path: "c.md", content: "Глубокое обучение и нейронные сети, градиент и функция потерь", tags: ["ml", "учёба"] },
  ];

  it("предлагает теги похожих заметок, без уже имеющихся", () => {
    const r = ne.suggestTags("Как нейронные сети обучаются градиентным спуском", notes, { have: ["учёба"] });
    expect(r.map((x: any) => x.tag)).toEqual(["ml"]);
    expect(r[0].from.length).toBe(2);
  });

  it("не предлагает ничего для постороннего текста и пропускает саму заметку", () => {
    expect(ne.suggestTags("квантовая хромодинамика", notes)).toEqual([]);
    const own = ne.suggestTags(notes[1].content, notes, { selfPath: "b.md" });
    expect(own.find((x: any) => x.tag === "кулинария")).toBeUndefined();
  });
});

describe("шаблоны", () => {
  it("подставляет дату, время и название; чужие поля не трогает", () => {
    const now = new Date(2026, 2, 5, 9, 7);
    expect(ne.renderTemplate("# {{title}} {{date}} {{time}} {{x}}", { title: "Тест", now })).toBe(
      "# Тест 2026-03-05 09:07 {{x}}",
    );
  });

  it("встроенные шаблоны уникальны по id", () => {
    const ids = ne.BUILTIN_TEMPLATES.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("сравнение конспектов", () => {
  it("находит общее и уникальное", () => {
    const a = "Митоз делится на четыре фазы. Мейоз нужен для половых клеток. ДНК удваивается перед делением.";
    const b = "Митоз состоит из четырёх фаз деления. Рибосомы синтезируют белок. ДНК удваивается перед делением клетки.";
    const r = ne.compareNotes(a, b, 0.5);
    expect(r.common.length).toBeGreaterThanOrEqual(1);
    expect(r.onlyA.some((s: string) => s.includes("Мейоз"))).toBe(true);
    expect(r.onlyB.some((s: string) => s.includes("Рибосомы"))).toBe(true);
    expect(r.similarity).toBeGreaterThan(0);
  });

  it("пустые тексты дают нулевое сходство", () => {
    expect(ne.compareNotes("", "").similarity).toBe(0);
  });
});
