import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Обмен заметками с Obsidian, Notion и Anki (server/ts/noteInterchange.ts). */
const req = createRequire(import.meta.url);
let ni: any;
beforeAll(() => {
  ni = req("../server/noteInterchange");
});

const HASH = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const buf = (s: string) => Buffer.from(s, "utf8");

describe("имена и пути", () => {
  it("stripNotionHash убирает хэш из каждого сегмента", () => {
    expect(ni.stripNotionHash(`Проекты ${HASH}/План ${HASH}.md`)).toBe("Проекты/План.md");
    expect(ni.stripNotionHash("Без хэша.md")).toBe("Без хэша.md");
  });

  it("safeRelPath отбрасывает выход за пределы и чистит запрещённые символы", () => {
    expect(ni.safeRelPath("../etc/passwd")).toBeNull();
    expect(ni.safeRelPath("a/../b.md")).toBeNull();
    expect(ni.safeRelPath("Идеи/что: как?.md")).toBe("Идеи/что_ как_.md");
  });
});

describe("ссылки и разметка", () => {
  it("ссылки Notion превращаются в викиссылки, внешние остаются", () => {
    const md = `См. [план](Проекты%20${HASH}/План%20${HASH}.md) и [сайт](https://a.b/c.md) и ![img](a.png)`;
    expect(ni.convertNotionLinks(md)).toBe("См. [[План]] и [сайт](https://a.b/c.md) и ![img](a.png)");
  });

  it("комментарии Obsidian удаляются", () => {
    expect(ni.convertObsidian("до %%тайна\nна двух строках%% после")).toBe("до  после");
  });

  it("викиссылки уходят в обычные Markdown-ссылки для Notion", () => {
    expect(ni.wikiLinksToMarkdown("[[Моя цель]] и [[Цель|подпись]] и ![[pic.png]]")).toBe(
      "[Моя цель](%D0%9C%D0%BE%D1%8F%20%D1%86%D0%B5%D0%BB%D1%8C.md) и [подпись](%D0%A6%D0%B5%D0%BB%D1%8C.md) и ![[pic.png]]",
    );
  });
});

describe("planImport", () => {
  it("берёт только .md, пропускает служебное и вложения", () => {
    const plan = ni.planImport(
      [
        { name: ".obsidian/app.json", content: buf("{}") },
        { name: "Заметка.md", content: buf("%%x%%текст") },
        { name: "img/a.png", content: buf("") },
        { name: "../evil.md", content: buf("x") },
        { name: "папка/", content: buf("") },
      ],
      "obsidian",
      "Импорт",
    );
    expect(plan.notes).toEqual([{ path: "Импорт/Заметка.md", content: "текст" }]);
    expect(plan.skipped.map((s: any) => s.reason).sort()).toEqual(["not-markdown", "service", "unsafe-path"]);
  });

  it("Notion: хэши убираются, одинаковые имена не затирают друг друга", () => {
    const plan = ni.planImport(
      [
        { name: `Страница ${HASH}.md`, content: buf("a") },
        { name: `Страница ${"f".repeat(32)}.md`, content: buf("b") },
      ],
      "notion",
    );
    expect(plan.notes.map((n: any) => n.path)).toEqual(["Страница.md", "Страница (2).md"]);
  });
});

describe("Anki", () => {
  const md = [
    "Столица Франции :: Париж",
    "- Формула воды :: H<sub>2</sub>O",
    "Обычный текст",
    "```",
    "a :: b",
    "```",
    "Масса Земли {{c1::5.97e24 кг}}",
  ].join("\n");

  it("достаёт карточки и пропуски, игнорируя код", () => {
    expect(ni.extractBasicCards(md, "t")).toEqual([
      { front: "Столица Франции", back: "Париж", tag: "t" },
      { front: "Формула воды", back: "H<sub>2</sub>O", tag: "t" },
    ]);
    expect(ni.extractClozes(md, "t")).toEqual([{ text: "Масса Земли {{c1::5.97e24 кг}}", tag: "t" }]);
  });

  it("TSV содержит заголовки Anki и тег из пути", () => {
    const r = ni.ankiTsv([{ path: "Школа/География.md", content: md }], "basic");
    expect(r.count).toBe(2);
    expect(r.tsv.startsWith("#separator:tab\n#html:true\n#tags column:3\n")).toBe(true);
    expect(r.tsv).toContain("Столица Франции\tПариж\tШкола_География");
    expect(ni.ankiTsv([], "cloze")).toEqual({
      tsv: "#separator:tab\n#html:true\n#tags column:2\n",
      count: 0,
    });
  });
});
