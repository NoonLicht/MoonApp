import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Удаление путей с не-ASCII именами (server/ts/fsUtil.ts -> server/fsUtil.js).
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

/**
 * TTL-уборка каталогов-хранилищ (server/ts/fsUtil.ts -> server/fsUtil.js).
 *
 * До фазы 1 этот цикл был скопирован в compressor.js, tts.js и sitebak.js.
 * Копии расходились списком исключений (в tts профили и пресеты удалять
 * нельзя), а уборка шла штатным fs.rmSync — тем самым, который на Windows
 * молча не удаляет имена с кириллицей.
 */
const HOUR = 60 * 60 * 1000;

function ttlDir(name: string): string {
  const dir = path.join(req("../server/config").DIRS.tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Создаёт запись с заданным «возрастом» (mtime в прошлом). */
function touch(dir: string, name: string, ageMs: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x");
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(full, at, at);
  return full;
}

describe("removeOlderThan — TTL-уборка каталога", () => {
  it("удаляет старое и оставляет свежее", () => {
    const dir = ttlDir("ttl-старое-свежее");
    const old = touch(dir, "old-job", 48 * HOUR);
    const fresh = touch(dir, "fresh-job", 1 * HOUR);

    const removed = fsUtil().removeOlderThan({ dir, ttlMs: 24 * HOUR });

    expect(removed).toEqual(["old-job"]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("не трогает имена из keep (профили и пресеты TTS)", () => {
    const dir = ttlDir("ttl-keep");
    const profile = touch(dir, "profiles.json", 90 * 24 * HOUR);
    const preset = touch(dir, "presets.json", 90 * 24 * HOUR);
    const job = touch(dir, "job-1", 90 * 24 * HOUR);

    const removed = fsUtil().removeOlderThan({
      dir,
      ttlMs: 24 * HOUR,
      keep: ["profiles.json", "presets.json"],
    });

    expect(removed).toEqual(["job-1"]);
    expect(fs.existsSync(profile)).toBe(true);
    expect(fs.existsSync(preset)).toBe(true);
    expect(fs.existsSync(job)).toBe(false);
  });

  it("удаляет каталог задания вместе с вложенными файлами с кириллицей", () => {
    const dir = ttlDir("ttl-кириллица");
    const job = path.join(dir, "job-кириллица");
    fs.mkdirSync(job, { recursive: true });
    const inner = path.join(job, "Лекция про историю.mp4");
    fs.writeFileSync(inner, "x");
    const at = new Date(Date.now() - 48 * HOUR);
    fs.utimesSync(inner, at, at);
    fs.utimesSync(job, at, at);

    const removed = fsUtil().removeOlderThan({ dir, ttlMs: 24 * HOUR });

    expect(removed).toEqual(["job-кириллица"]);
    expect(fs.existsSync(job)).toBe(false);
  });

  it("молча выходит, если каталога нет (движок ещё не создавал storage)", () => {
    const missing = path.join(req("../server/config").DIRS.tmp, "нет-такого-каталога-ttl");
    expect(fs.existsSync(missing)).toBe(false);
    expect(fsUtil().removeOlderThan({ dir: missing, ttlMs: 24 * HOUR })).toEqual([]);
  });

  it("уважает параметр now: возраст считается от переданного времени", () => {
    const dir = ttlDir("ttl-now");
    const file = touch(dir, "job-now", 0);

    // ttl 0 при now = mtime + 1 мс: запись уже «устарела».
    const mtime = fs.statSync(file).mtimeMs;
    expect(fsUtil().removeOlderThan({ dir, ttlMs: 0, now: mtime + 1 })).toEqual(["job-now"]);
    expect(fs.existsSync(file)).toBe(false);
  });
});
