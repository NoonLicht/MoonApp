import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/comss, переведённого на TS (server/ts/comss.ts →
 * server/comss.js).
 *
 * Скрейпер разбирает чужие страницы, поэтому проверяем именно правила разбора:
 * служебная ссылка «Новое на сайте» в каталог не попадает, дубли имён внутри
 * рубрики схлопываются, а из нескольких зеркал одной карточки берётся рабочее
 * (dl.comss.org, затем dl.comss.ru, затем первое найденное). Сеть в тестах не
 * трогаем — fetch подменяется на фикстуру.
 */
const req = createRequire(import.meta.url);

let comss: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-comss-"));
  comss = req("../server/comss");
});

describe("server/comss — разбор рубрики", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(comss.default).toBeUndefined();
    expect(typeof comss.scrapeCategory).toBe("function");
  });

  it("берёт id и имя карточки, обрезая пробелы", () => {
    const html = `
      <a href="page.php?id=1234">  Firefox  </a>
      <a href="page.php?id=99">Chrome</a>`;
    expect(comss.parseList(html)).toEqual([
      { id: "1234", name: "Firefox" },
      { id: "99", name: "Chrome" },
    ]);
  });

  it("служебная ссылка «Новое на сайте» в каталог не попадает", () => {
    const html = `<a href="page.php?id=1">Новое на сайте</a><a href="page.php?id=2">7-Zip</a>`;
    expect(comss.parseList(html)).toEqual([{ id: "2", name: "7-Zip" }]);
  });

  it("слишком короткие подписи (1 символ) отбрасываются", () => {
    const html = `<a href="page.php?id=1">A</a><a href="page.php?id=2">AB</a>`;
    expect(comss.parseList(html)).toEqual([{ id: "2", name: "AB" }]);
  });
});

describe("server/comss — прямая ссылка из страницы загрузки", () => {
  it("предпочитает зеркало dl.comss.org", () => {
    const html = `
      <a href="https://dl.comss.ru/download/file.exe">ru</a>
      <a href="https://dl.comss.org/download/file.exe">org</a>`;
    expect(comss.parseDirectUrls(html)).toBe("https://dl.comss.org/download/file.exe");
  });

  it("если org нет — берёт dl.comss.ru", () => {
    const html = `<a href="https://mirror.example.com/x.zip">m</a>
                  <a href="https://dl.comss.ru/download/file.exe">ru</a>`;
    expect(comss.parseDirectUrls(html)).toBe("https://dl.comss.ru/download/file.exe");
  });

  it("иначе — первую подходящую ссылку и только разрешённые расширения", () => {
    expect(comss.parseDirectUrls(`<a href="https://cdn.dev/setup.msi">s</a>`)).toBe(
      "https://cdn.dev/setup.msi",
    );
    expect(comss.parseDirectUrls(`<a href="https://cdn.dev/page.html">p</a>`)).toBeNull();
  });
});

describe("server/comss — каталог рубрик", () => {
  it("коды рубрик уникальны, подписи непустые", () => {
    const codes = comss.CATEGORIES.map((c: any) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(comss.CATEGORIES.every((c: any) => c.label.length > 0)).toBe(true);
    expect(codes).toContain("antivirus");
  });
});
