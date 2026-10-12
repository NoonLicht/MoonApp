import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Ghost Context (server/ts/ghostContext.ts). */
const req = createRequire(import.meta.url);
let g: any;
beforeAll(() => {
  g = req("../server/ghostContext");
});

describe("запрос из заголовка окна", () => {
  it("убирает название приложения и расширение", () => {
    expect(g.queryFromTitle("Бюджет на ноябрь.docx - Word")).toBe("бюджет ноябрь");
    expect(g.queryFromTitle("Как работает FSRS — статья - Google Chrome")).toBe("работает fsrs статья");
  });

  it("не ищет по общим и чувствительным окнам", () => {
    expect(g.queryFromTitle("Новая вкладка")).toBe("");
    expect(g.queryFromTitle("Проводник")).toBe("");
    expect(g.queryFromTitle("KeePass — база паролей")).toBe("");
    expect(g.queryFromTitle("Сбербанк Онлайн")).toBe("");
    expect(g.queryFromTitle("")).toBe("");
  });
});

describe("запрос из выделения", () => {
  it("сводит длинный текст к ключевым словам", () => {
    const q = g.buildQuery({
      title: "Заметки - Obsidian",
      text: "Нейросети обучаются градиентным спуском. Градиентный спуск минимизирует функцию потерь нейросети.",
    });
    expect(q.split(" ").length).toBeLessThanOrEqual(10);
    expect(q).toContain("нейросети");
    expect(q).toContain("градиентным");
  });

  it("короткое выделение игнорируется в пользу заголовка", () => {
    expect(g.buildQuery({ title: "Договор аренды - Word", text: "да" })).toBe("договор аренды");
  });

  it("выделение с паролем не используется", () => {
    expect(g.buildQuery({ text: "мой пароль от почты: qwerty123456 и банк" })).toBe("");
  });
});

describe("группировка подсказок", () => {
  const h = (source: string, ref: string, score = 0.9) => ({ source, ref, title: ref, snippet: "", score });
  it("исключает текущий объект, слабые и дубликаты, ограничивает число", () => {
    const groups = g.groupHits(
      [
        h("note", "a.md"),
        h("note", "b.md"),
        h("note", "b.md"),
        h("note", "c.md"),
        h("note", "d.md"),
        h("budget", "42", 0.3),
        h("lecture", "7"),
        h("movie", "x"),
      ],
      { exclude: { source: "note", ref: "a.md" }, minScore: 0.6, perSource: 2 },
    );
    expect(groups.map((x: any) => x.source)).toEqual(["note", "lecture"]);
    expect(groups[0].items.map((x: any) => x.ref)).toEqual(["b.md", "c.md"]);
  });
});

describe("активное окно", () => {
  it("разбирает JSON из последней строки вывода", () => {
    expect(g.parseActiveWindow('шум\r\n{"title":"Заметка","process":"Code"}\r\n')).toEqual({
      title: "Заметка",
      process: "Code",
    });
    expect(g.parseActiveWindow("ошибка")).toBeNull();
  });
});
