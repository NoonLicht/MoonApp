import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Разбор YAML-frontmatter .md-файлов (server/ts/frontmatter.ts -> server/frontmatter.js).
 *
 * До фазы 1 один и тот же цикл разбора лежал двумя копиями: notes-fs.js
 * (storage/notes) и myspace-vault.js (файлы MySpace). Копии успели разойтись
 * обработкой кавычек, а формат общий: блок между двумя строками "---", строки
 * вида `ключ: "значение"`. Тесты фиксируют поведение парсера и то, что оба
 * потребителя используют ОДНУ реализацию.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");
const readServer = (name: string) => fs.readFileSync(path.join(root, "server", name), "utf8");

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-fm-"));
});

function frontmatter(): any {
  return req("../server/frontmatter");
}

describe("parseFrontmatter — разбор блока .md", () => {
  it("разбирает блок и отделяет тело документа", () => {
    const raw = [
      "---",
      'title: "Моя заметка"',
      "id: 7",
      'tags: "тег1 тег2"',
      "---",
      "",
      "Текст",
    ].join("\n");
    const { hasFrontmatter, frontmatter: fm, content } = frontmatter().parseFrontmatter(raw);
    expect(hasFrontmatter).toBe(true);
    expect(fm.title).toBe("Моя заметка");
    expect(fm.id).toBe("7");
    expect(fm.tags).toBe("тег1 тег2");
    expect(content).toBe("Текст");
  });

  it("снимает обрамляющие кавычки — и двойные, и одинарные", () => {
    const raw = ["---", `a: "в двойных"`, `b: 'в одинарных'`, "c: без кавычек", "---", "тело"].join(
      "\n",
    );
    const fm = frontmatter().parseFrontmatter(raw).frontmatter;
    expect(fm).toEqual({ a: "в двойных", b: "в одинарных", c: "без кавычек" });
  });

  it("снимает только крайние кавычки — внутренние остаются", () => {
    const raw = ["---", 'title: "он сказал "привет""', "---", "тело"].join("\n");
    const fm = frontmatter().parseFrontmatter(raw).frontmatter;
    expect(fm.title).toBe('он сказал "привет"');
  });

  it("возвращает исходный текст, если блока нет (файл из другого редактора)", () => {
    const raw = "# Заголовок\n\nПросто текст без frontmatter";
    const res = frontmatter().parseFrontmatter(raw);
    expect(res.hasFrontmatter).toBe(false);
    expect(res.frontmatter).toEqual({});
    expect(res.content).toBe(raw);
  });

  it("не считает блоком незакрытый frontmatter", () => {
    const raw = '---\ntitle: "без закрывающей"\nтело';
    const res = frontmatter().parseFrontmatter(raw);
    expect(res.hasFrontmatter).toBe(false);
    expect(res.content).toBe(raw);
  });

  it("пропускает строки блока без двоеточия", () => {
    const raw = ["---", "мусор без двоеточия", 'title: "ок"', "---", "тело"].join("\n");
    const fm = frontmatter().parseFrontmatter(raw).frontmatter;
    expect(fm).toEqual({ title: "ок" });
  });

  it("обрезает пробелы вокруг ключа и значения", () => {
    const raw = ["---", '   title   :   "Значение"   ', "---", "тело"].join("\n");
    const fm = frontmatter().parseFrontmatter(raw).frontmatter;
    expect(fm.title).toBe("Значение");
  });

  it("не трогает переносы строк внутри тела документа", () => {
    const raw = ["---", 'title: "t"', "---", "", "первая строка", "", "вторая строка"].join("\n");
    const { content } = frontmatter().parseFrontmatter(raw);
    expect(content).toBe("первая строка\n\nвторая строка");
  });
});

describe("контракт: общий парсер вместо двух копий", () => {
  it.each(["notes-fs.js", "myspace-vault.js"])('%s использует require("./frontmatter")', (name) => {
    const src = readServer(name);
    expect(src).toContain('require("./frontmatter")');
    expect(src).toContain("parseFrontmatter(");
    // Локальная копия цикла разбора не должна вернуться.
    expect(src, `${name}: вернулась ручная разборка блока`).not.toMatch(/raw\.indexOf\("---", 3\)/);
  });

  it("артефакт сборки server/frontmatter.js экспортирует parseFrontmatter", () => {
    expect(readServer("frontmatter.js")).toContain("exports.parseFrontmatter");
  });
});
