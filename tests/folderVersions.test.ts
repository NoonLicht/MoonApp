import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/** Версии папок (server/ts/folderVersions.ts). */
const req = createRequire(import.meta.url);
let fv: any;
beforeAll(() => {
  fv = req("../server/folderVersions");
});

let tmp = "";
let work = "";
let root = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fv-"));
  work = path.join(tmp, "docs");
  root = path.join(tmp, "store");
  fs.mkdirSync(path.join(work, "sub"), { recursive: true });
  fs.mkdirSync(path.join(work, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(work, "a.txt"), "один");
  fs.writeFileSync(path.join(work, "sub", "b.txt"), "два");
  fs.writeFileSync(path.join(work, "node_modules", "x.js"), "пропуск");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("версии папок", () => {
  it("снимок копирует файлы, пропуская служебные каталоги, и попадает в список", () => {
    const v = fv.snapshotFolder(root, work, { label: "до правок", now: 1000 });
    expect(v.files).toBe(2);
    expect(v.label).toBe("до правок");
    expect(fv.listVersions(root, work).map((x: any) => x.id)).toEqual(["1000"]);
  });

  it("восстановление кладёт копию рядом и не трогает исходную папку", () => {
    const v = fv.snapshotFolder(root, work, { now: 5000 });
    fs.writeFileSync(path.join(work, "a.txt"), "изменено");
    const dest = fv.restoreVersion(root, work, v.id);
    expect(dest).not.toBe(work);
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("один");
    expect(fs.readFileSync(path.join(dest, "sub", "b.txt"), "utf8")).toBe("два");
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("изменено");
  });

  it("хранит не больше MAX_VERSIONS, старые удаляются", () => {
    for (let i = 1; i <= fv.MAX_VERSIONS + 2; i++) fv.snapshotFolder(root, work, { now: i * 1000 });
    const ids = fv.listVersions(root, work).map((x: any) => x.id);
    expect(ids.length).toBe(fv.MAX_VERSIONS);
    expect(ids).not.toContain("1000");
  });

  it("ошибки: не папка, хранилище внутри папки, неверный id", () => {
    expect(() => fv.snapshotFolder(root, path.join(tmp, "нет"))).toThrow("not_a_folder");
    expect(() => fv.snapshotFolder(path.join(work, "store"), work)).toThrow("folder_contains_storage");
    expect(() => fv.restoreVersion(root, work, "../x")).toThrow("bad_id");
    expect(() => fv.restoreVersion(root, work, "123")).toThrow("version_not_found");
  });

  it("deleteVersion удаляет конкретную версию", () => {
    const v = fv.snapshotFolder(root, work, { now: 1 });
    expect(fv.deleteVersion(root, work, v.id)).toBe(true);
    expect(fv.listVersions(root, work)).toEqual([]);
    expect(fv.deleteVersion(root, work, v.id)).toBe(false);
  });
});
