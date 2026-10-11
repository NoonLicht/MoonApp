import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Снимки заметок (server/ts/noteSnapshots.ts). */
const req = createRequire(import.meta.url);
let ns: any;
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ns-"));
  ns = req("../server/noteSnapshots");
});

describe("noteSnapshots", () => {
  it("сохраняет, перечисляет (новые первыми) и читает снимок", () => {
    const a = ns.snapshot("Папка/Заметка.md", "версия 1", "ai-format");
    const b = ns.snapshot("Папка/Заметка.md", "версия 2");
    const list = ns.list("Папка/Заметка.md");
    expect(list.map((s: any) => s.id)).toEqual([b.id, a.id]);
    expect(list[1].reason).toBe("ai-format");
    expect(ns.read("Папка/Заметка.md", a.id)).toBe("версия 1");
  });

  it("хранит не больше 20 последних", () => {
    for (let i = 0; i < 25; i++) ns.snapshot("many.md", "v" + i);
    expect(ns.list("many.md")).toHaveLength(20);
  });

  it("небезопасные пути и идентификаторы отвергаются", () => {
    expect(ns.snapshot("../evil.md", "x")).toBeNull();
    expect(ns.list("../evil.md")).toEqual([]);
    expect(ns.read("many.md", "../../x")).toBeNull();
    expect(ns.read("нет.md", "123")).toBeNull();
  });
});
