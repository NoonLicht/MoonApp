import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Мини-сайт из заметок (server/ts/miniSite.ts). */
const req = createRequire(import.meta.url);
let ms: any;
beforeAll(() => {
  ms = req("../server/miniSite");
});

const notes = [
  { path: "Курс/Введение.md", title: "Введение", content: "---\ntags: a\n---\n# Привет\nСм. [[Тема|тему]] и [[Нет такой]].\n" },
  { path: "Курс/Тема.md", title: "Тема", content: "Текст\n:::private\nсекрет\n:::\n<script>alert(1)</script>\n" },
];

describe("buildSite", () => {
  it("создаёт индекс и страницу на каждую заметку", () => {
    const f = ms.buildSite(notes, "Мой курс");
    expect(Object.keys(f).sort()).toEqual(["index.html", "введение.html", "тема.html"]);
    expect(f["index.html"]).toContain('<a href="введение.html">Введение</a>');
    expect(f["index.html"]).toContain("Мой курс");
  });

  it("превращает wiki-ссылки в ссылки на страницы, неизвестные оставляет текстом", () => {
    const f = ms.buildSite(notes);
    expect(f["введение.html"]).toContain(`<a href="${encodeURI("тема.html")}">тему</a>`);
    expect(f["введение.html"]).toContain("Нет такой");
    expect(f["введение.html"]).not.toContain("[[");
    expect(f["введение.html"]).not.toContain("tags: a");
  });

  it("вырезает приватные блоки и экранирует сырой HTML", () => {
    const f = ms.buildSite(notes);
    expect(f["тема.html"]).not.toContain("секрет");
    expect(f["тема.html"]).not.toContain("<script>alert");
    expect(f["тема.html"]).toContain("&lt;script&gt;");
  });

  it("имена страниц уникальны при одинаковых заголовках", () => {
    const names = ms.pageNames([
      { path: "a/Тема.md", title: "Тема", content: "" },
      { path: "b/Тема.md", title: "Тема", content: "" },
      { path: "c/index.md", title: "index", content: "" },
    ]);
    expect([...names.values()]).toEqual(["тема.html", "тема-2.html", "index-2.html"]);
  });
});
