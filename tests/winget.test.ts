import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/winget, переведённого на TS (server/ts/winget.ts →
 * server/winget.js).
 *
 * Разбор чужой таблицы — самая хрупкая часть: колонки разделены «широкими»
 * пробелами, названия содержат пробелы (поэтому ИД ищется по точке, а не по
 * позиции), а сам winget печатает то UTF-8, то UTF-16LE. Плюс проверяем, что
 * стартовый список каталога и кэш индекса отдаются через CommonJS-форму.
 */
const req = createRequire(import.meta.url);

let storage: string;
let winget: any;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-winget-"));
  process.env.MOONAPP_STORAGE = storage;
  winget = req("../server/winget");
});

const TABLE = [
  "Name                          Id                     Version   Match        Source",
  "-------------------------------------------------------------------------------",
  "Google Chrome                 Google.Chrome          120.0.1                winget",
  "Mozilla Firefox               Mozilla.Firefox        121.0     moz         winget",
  "Visual Studio Code            Microsoft.VisualStudioCode  1.85             winget",
].join("\r\n");

describe("server/winget — разбор таблицы поиска", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(winget.default).toBeUndefined();
    expect(typeof winget.search).toBe("function");
    expect(typeof winget.seed).toBe("function");
  });

  it("берёт имя с пробелами, ИД по точке, версию и источник", () => {
    expect(winget.parseTable(Buffer.from(TABLE, "utf8"))).toEqual([
      { name: "Google Chrome", id: "Google.Chrome", version: "120.0.1", source: "winget" },
      { name: "Mozilla Firefox", id: "Mozilla.Firefox", version: "121.0", source: "winget" },
      {
        name: "Visual Studio Code",
        id: "Microsoft.VisualStudioCode",
        version: "1.85",
        source: "winget",
      },
    ]);
  });

  it("колонка «Совпадение» игнорируется: версия берётся сразу за ИД, источник — последний токен", () => {
    const row = winget.parseTable(Buffer.from(TABLE, "utf8"))[1];
    expect(row.version).toBe("121.0");
    expect(row.source).toBe("winget");
  });

  it("ИД, начинающийся с цифры (7zip.7zip), отбрасывается — известное ограничение разбора", () => {
    // Правило «ИД — токен с точкой, не начинающийся с цифры» защищает от версий
    // вида 120.0.1, но заодно теряет пакеты вроде 7zip.7zip. В UI они есть в
    // стартовом списке (seed), поэтому поведение зафиксировано, а не «исправлено».
    const html =
      "7-Zip                         7zip.7zip              23.01                  winget";
    expect(winget.parseTable(Buffer.from(html, "utf8"))).toEqual([]);
  });

  it("строки-заголовок и разделитель пропускаются (меньше 4 токенов / нет ИД с точкой)", () => {
    const rows = winget.parseTable(Buffer.from(TABLE, "utf8"));
    expect(rows.some((r: any) => r.name === "Name")).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("UTF-16LE (с BOM и без) декодируется правильно", () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TABLE, "utf16le")]);
    expect(winget.parseTable(withBom)[0].id).toBe("Google.Chrome");
    expect(winget.parseTable(Buffer.from(TABLE, "utf16le"))[0].id).toBe("Google.Chrome");
  });

  it("дубли одного ИД схлопываются", () => {
    const dupes = [
      TABLE,
      "Google Chrome                 Google.Chrome          121.0                winget",
    ].join("\r\n");
    expect(winget.parseTable(Buffer.from(dupes, "utf8"))).toHaveLength(3);
  });

  it("пустой вывод не ломает разбор", () => {
    expect(winget.parseTable(Buffer.alloc(0))).toEqual([]);
  });
});

describe("server/winget — стартовый список и кэш каталога", () => {
  it("seed() отдаёт записи с категорией и пустой версией", () => {
    const rows = winget.seed();
    expect(rows.length).toBeGreaterThan(40);
    expect(rows[0]).toMatchObject({ name: "Google Chrome", id: "Google.Chrome", version: "" });
    expect(rows[0].category).toBe("Browser");
    expect(rows.every((r: any) => r.source === "winget" && r.category.length > 0)).toBe(true);
  });

  it("indexStatus без кэша сообщает cached = 0", () => {
    expect(winget.indexStatus()).toMatchObject({ state: "none", done: 0, total: 0, cached: 0 });
  });

  it("readIndex читает кэш из storage, а битый файл считает отсутствующим", () => {
    const indexFile = path.join(storage, "winget_index.json");
    fs.writeFileSync(
      indexFile,
      JSON.stringify([{ name: "A", id: "A.A", version: "1", source: "winget" }]),
      "utf8",
    );
    expect(winget.indexStatus().cached).toBe(1);
    expect(winget.readIndex()[0].id).toBe("A.A");

    fs.writeFileSync(indexFile, "{не json", "utf8");
    expect(winget.readIndex()).toBeNull();
    expect(winget.indexStatus().cached).toBe(0);
  });
});
