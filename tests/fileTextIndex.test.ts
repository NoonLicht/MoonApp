import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Текст файлов для поиска (server/ts/fileTextIndex.ts): типы, HTML, обход папок. */
const req = createRequire(import.meta.url);
let fx: any;
let dir: string;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fx-"));
  fx = req("../server/fileTextIndex");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fx-data-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "Договор аренды квартиры подписан в марте");
  fs.writeFileSync(path.join(dir, "page.html"), "<html><style>a{}</style><body><h1>Заголовок</h1><p>Тело &amp; текст</p></body></html>");
  fs.writeFileSync(path.join(dir, "tiny.txt"), "a");
  fs.writeFileSync(path.join(dir, "data.bin"), Buffer.from([1, 2, 3]));
});

describe("fileTextIndex", () => {
  it("определяет тип по расширению", () => {
    expect(fx.kindOf("a.PDF")).toBe("pdf");
    expect(fx.kindOf("a.jpeg")).toBe("image");
    expect(fx.kindOf("a.md")).toBe("text");
    expect(fx.kindOf("a.exe")).toBeNull();
  });

  it("htmlToText убирает теги, скрипты и стили", () => {
    expect(fx.htmlToText("<style>x{}</style><p>Привет&nbsp;мир &amp; все</p>")).toBe("Привет мир & все");
  });

  it("папки сохраняются без дублей и относительных путей", () => {
    expect(fx.setFolders([dir, dir, "relative/path"])).toEqual([dir]);
    expect(fx.getFolders()).toEqual([dir]);
  });

  it("обход складывает тексты поддерживаемых файлов в документы", async () => {
    fx.setFolders([dir]);
    fx.startScan();
    for (let i = 0; i < 100 && fx.scanState().running; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const st = fx.scanState();
    expect(st.running).toBe(false);
    expect(st.error).toBe("");
    const docs = fx.fileDocs();
    const names = docs.map((d: any) => d.title).sort();
    expect(names).toEqual(["notes.txt", "page.html"]);
    expect(docs.find((d: any) => d.title === "page.html").text).toBe("Заголовок Тело & текст");
  });
});
