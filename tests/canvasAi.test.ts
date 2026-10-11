import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Холст, который понимает содержимое (server/ts/canvasAi.ts). */
const req = createRequire(import.meta.url);
let c: any;
beforeAll(() => {
  c = req("../server/canvasAi");
});

describe("описание объектов доски", () => {
  it("оставляет значимые объекты и склеивает подписи без повторов", () => {
    const items = c.describe(
      [
        { id: "a", type: "sticky", text: "Идея лендинга" },
        { id: "b", type: "line" },
        { id: "c", type: "note", name: "План", preview: "План", path: "План.md" },
        { id: "d", type: "image", text: "" },
        { id: "e", type: "link", text: "Лекция 3", link: { kind: "lecture", ref: "3" } },
      ],
      { image: { d: "Бюджет 50000" }, linked: { c: "этапы проекта" } },
    );
    expect(items).toEqual([
      { id: "a", kind: "sticky", label: "Идея лендинга" },
      { id: "c", kind: "note", label: "План — этапы проекта" },
      { id: "d", kind: "image", label: "[текст на картинке] Бюджет 50000" },
      { id: "e", kind: "link:lecture", label: "Лекция 3" },
    ]);
  });

  it("лимитирует число объектов", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, type: "sticky", text: `текст ${i}` }));
    expect(c.describe(many, {}, 10)).toHaveLength(10);
  });
});

describe("разбор ответа модели", () => {
  const ids = ["a", "b", "c", "d"];

  it("принимает только существующие id, убирает самосвязи и дубли", () => {
    const raw = JSON.stringify({
      links: [
        { from: "a", to: "b", why: "про одно" },
        { from: "b", to: "a", why: "дубль" },
        { from: "a", to: "a", why: "сам с собой" },
        { from: "a", to: "zzz", why: "нет такого" },
      ],
      groups: [
        { name: "Маркетинг", ids: ["a", "b", "nope"] },
        { name: "Одиночка", ids: ["c"] },
        { name: "", ids: ["a", "b"] },
      ],
      missing: [{ text: "Проверить гипотезу" }, { text: "" }],
    });
    const s = c.parseSuggestions(`вот:\n${raw}`, ids);
    expect(s.links).toEqual([{ from: "a", to: "b", why: "про одно" }]);
    expect(s.groups).toEqual([{ name: "Маркетинг", ids: ["a", "b"] }]);
    expect(s.missing).toEqual([{ text: "Проверить гипотезу" }]);
  });

  it("мусор и пустой ответ не ломают разбор", () => {
    expect(c.parseSuggestions("нет json", ids)).toEqual({ links: [], groups: [], missing: [] });
    expect(c.parseSuggestions("{сломано", ids)).toEqual({ links: [], groups: [], missing: [] });
  });

  it("промпт содержит объекты и ограничения", () => {
    const p = c.buildPrompt([{ id: "a", kind: "sticky", label: "Идея" }]);
    expect(p).toContain("a | sticky | Идея");
    expect(p).toContain("Используй только указанные id");
  });
});
