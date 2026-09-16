import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Удаление путей с не-ASCII именами (server/fsUtil.js).
 *
 * Регресс: на Windows fs.rmSync МОЛЧА не удаляет файл с кириллическим именем —
 * вызов проходит, файл остаётся. Из-за этого «удалил заметку» в MySpace и
 * «удалил лекцию» возвращали успех, а .md файл продолжал лежать в storage.
 * Тесты фиксируют ПОВЕДЕНИЕ removePath (файл действительно исчез), а не
 * конкретную реализацию обхода.
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  // storage подменяем ДО загрузки server/*: config читает MOONAPP_STORAGE при require.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-fsutil-"));
});

function fsUtil(): any {
  return req("../server/fsUtil");
}

describe("removePath — удаление файлов и каталогов", () => {
  it("удаляет файл с кириллическим именем", () => {
    const dir = req("../server/config").DIRS.tmp;
    const file = path.join(dir, "1-лекция-история-2026-09-16.md");
    fs.writeFileSync(file, "текст");
    expect(fs.existsSync(file)).toBe(true);

    expect(fsUtil().removePath(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("удаляет каталог вместе с вложенными файлами с русскими именами", () => {
    const dir = req("../server/config").DIRS.tmp;
    const sub = path.join(dir, "Заметки");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "Тема 1.md"), "x");
    fs.writeFileSync(path.join(dir, "Отдельная.md"), "y");

    expect(fsUtil().removePath(sub)).toBe(true);
    expect(fs.existsSync(sub)).toBe(false);
    expect(fs.existsSync(path.join(dir, "Отдельная.md"))).toBe(true);

    fs.unlinkSync(path.join(dir, "Отдельная.md"));
  });

  it("считает уже удалённый путь успехом (идемпотентность)", () => {
    const missing = path.join(req("../server/config").DIRS.tmp, "нет-такого-файла.md");
    expect(fsUtil().removePath(missing)).toBe(true);
  });
});

describe("Заметки MySpace — удаление файла с русским именем", () => {
  it("deleteFile действительно убирает .md из vault/notes", () => {
    const vault = req("../server/myspace-vault");
    const name = "Тестовая заметка.md";
    vault.writeFile(name, "# Текст заметки");
    const full = path.join(req("../server/config").DIRS.vaultNotes, name);
    expect(fs.existsSync(full)).toBe(true);

    expect(vault.deleteFile(name)).toEqual({ ok: true });

    expect(fs.existsSync(full)).toBe(false);
    expect(vault.buildTree().some((n: any) => n.path === name)).toBe(false);
  });
});