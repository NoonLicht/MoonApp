import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/notes-fs, переведённого на TS (server/ts/notes-fs.ts →
 * server/notes-fs.js).
 *
 * Заметки лежат отдельными .md-файлами с frontmatter, и на этом формате держатся
 * сразу три вещи: id берётся из меты (иначе заметки «перепутаются» после
 * сортировки каталога), смена заголовка переименовывает файл (slug в имени), а
 * upsert(id) перезаписывает ровно тот же файл — на этом построена синхронизация
 * конспектов лекций (server/lecture.js → syncNotesFile).
 */
const req = createRequire(import.meta.url);

let storage: string;
let notes: any;

const notesDir = (): string => path.join(storage, "notes");

function mdFiles(): string[] {
  return fs.existsSync(notesDir())
    ? fs
        .readdirSync(notesDir())
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
}

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesfs-"));
  process.env.MOONAPP_STORAGE = storage;
});

beforeEach(() => {
  notes = req("../server/notes-fs");
  notes.deleteAll();
});

describe("server/notes-fs — файлы и память", () => {
  it("require() отдаёт методы напрямую, включая delete (без { default })", () => {
    expect(notes.default).toBeUndefined();
    expect(typeof notes.insert).toBe("function");
    expect(typeof notes.delete).toBe("function");
    expect(typeof notes.upsert).toBe("function");
  });

  it("insert пишет .md с frontmatter, id и заголовком в имени файла", () => {
    const r = notes.insert("Заметка 1", "тело", "тег", "Папка");
    expect(r).toEqual({ lastInsertRowid: 1 });
    expect(mdFiles()).toEqual(["1-заметка-1.md"]);
    const raw = fs.readFileSync(path.join(notesDir(), mdFiles()[0]), "utf8");
    expect(raw).toContain('title: "Заметка 1"');
    expect(raw).toContain("id: 1");
    expect(raw).toContain('tags: "тег"');
    expect(raw).toContain("тело");
  });

  it("get возвращает копию (правки наружу не протекают в память)", () => {
    notes.insert("A", "x", "", "");
    const copy = notes.get(1);
    copy.title = "изменено";
    expect(notes.get(1).title).toBe("A");
    expect(notes.get(999)).toBeUndefined();
  });

  it("update переименовывает файл, если сменился заголовок (старый slug не остаётся)", () => {
    notes.insert("Старое имя", "x", "", "");
    notes.update("Новое имя", null, null, null, 1);
    expect(mdFiles()).toEqual(["1-новое-имя.md"]);
    expect(notes.get(1).title).toBe("Новое имя");
    expect(notes.get(1).content).toBe("x");
  });

  it("update несуществующей заметки сообщает changes = 0", () => {
    expect(notes.update("x", "y", null, null, 42)).toEqual({ changes: 0 });
  });

  it("all отдаёт свежие первыми по updated_at", () => {
    fs.mkdirSync(notesDir(), { recursive: true });
    fs.writeFileSync(
      path.join(notesDir(), "1-старая.md"),
      [
        "---",
        'title: "старая"',
        "id: 1",
        "created_at: 2026-01-01 10:00:00",
        "updated_at: 2026-01-01 10:00:00",
        "---",
        "",
        "x",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(notesDir(), "2-новая.md"),
      [
        "---",
        'title: "новая"',
        "id: 2",
        "created_at: 2026-01-02 10:00:00",
        "updated_at: 2026-01-02 10:00:00",
        "---",
        "",
        "y",
      ].join("\n"),
      "utf8",
    );
    notes.loadAll();
    expect(notes.all().map((n: any) => n.id)).toEqual([2, 1]);
  });

  it("search ищет по заголовку и телу, пустой запрос — пустой список", () => {
    notes.insert("Про кошек", "мяу", "", "");
    notes.insert("Про собак", "гав", "", "");
    expect(notes.search("собак").map((n: any) => n.id)).toEqual([2]);
    expect(notes.search("мяу").map((n: any) => n.id)).toEqual([1]);
    expect(notes.search("  ")).toEqual([]);
  });
});

describe("server/notes-fs — upsert, удаление и перезагрузка с диска", () => {
  it("upsert с известным id перезаписывает тот же файл и сохраняет created_at", () => {
    const first = notes.upsert(7, { title: "Конспект", content: "часть 1" });
    expect(first.id).toBe(7);
    const created = first.created_at;
    const second = notes.upsert(7, { content: "часть 2" });
    expect(second.created_at).toBe(created);
    expect(second.title).toBe("Конспект");
    expect(mdFiles()).toEqual(["7-конспект.md"]);
    expect(notes.get(7).content).toBe("часть 2");
  });

  it("upsert воссоздаёт заметку, если файл удалили с диска вручную (id сохраняется)", () => {
    notes.upsert(3, { title: "Восстанови", content: "v1" });
    notes.delete(3);
    expect(notes.get(3)).toBeUndefined();
    const again = notes.upsert(3, { title: "Восстанови", content: "v2" });
    expect(again.id).toBe(3);
    expect(notes.get(3).content).toBe("v2");
  });

  it("delete убирает заметку и её файл", () => {
    notes.insert("Удаляемая", "x", "", "");
    expect(notes.delete(1)).toEqual({ changes: 1 });
    expect(notes.delete(1)).toEqual({ changes: 0 });
    expect(notes.all()).toEqual([]);
    expect(mdFiles()).toEqual([]);
  });

  it("файл без frontmatter при загрузке пропускается (id берётся только из меты)", () => {
    fs.mkdirSync(notesDir(), { recursive: true });
    fs.writeFileSync(path.join(notesDir(), "5-без-меты.md"), "просто текст", "utf8");
    notes.loadAll();
    // Так было и до перевода на TS: parseNote без меты не знает id, а заметка
    // без id в память не попадает (иначе появился бы «фантом» id 0).
    expect(notes.get(5)).toBeUndefined();
    expect(notes.all()).toEqual([]);
  });

  it("deleteAll возвращает число удалённых и чистит каталог", () => {
    notes.insert("раз", "x", "", "");
    notes.insert("два", "y", "", "");
    expect(notes.deleteAll()).toEqual({ deleted: 2 });
    expect(mdFiles()).toEqual([]);
  });
});
