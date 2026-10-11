import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Миграции и устойчивость SQLite-хранилища (server/ts/db.ts).
 *
 * Каждый сценарий исполняется в ОТДЕЛЬНОМ процессе node: модуль db открывает БД
 * при загрузке, а storage берётся из окружения один раз — иначе нельзя ни
 * проверить «открытие старой БД новой версией приложения», ни переоткрытие файла.
 */
const DB_MODULE = path.resolve(__dirname, "..", "server", "db.js");

function storage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-dbmig-"));
}

/** Выполняет JS в новом процессе с заданным storage и возвращает JSON из stdout. */
function runIn<T>(dir: string, body: string): T {
  const script = `
    const db = require(${JSON.stringify(DB_MODULE)});
    const out = (() => { ${body} })();
    db.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, MOONAPP_STORAGE: dir },
    encoding: "utf8",
  });
  // Логгер приложения может писать в stdout свои строки — результат идёт последней.
  return JSON.parse(stdout.trim().split(/\r?\n/).pop() as string);
}

describe("db — схема и миграции SQLite", () => {
  it("новая БД получает версию схемы, все таблицы и индексы", () => {
    const dir = storage();
    const v = runIn<number>(dir, "return db.SCHEMA_VERSION;");
    const sq = new Database(path.join(dir, "data.db"), { readonly: true });
    try {
      expect(sq.pragma("user_version", { simple: true })).toBe(v);
      const idx = (
        sq.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string;
        }[]
      ).map((i) => i.name);
      expect(idx).toContain("idx_messages_conversation_id");
      expect(idx).toContain("idx_lecture_chunks_lecture_id");
      expect(idx).toContain("idx_torrent_downloads_info_hash");
    } finally {
      sq.close();
    }
  });

  it("данные переживают перезапуск; id удалённых строк не переиспользуются", () => {
    const dir = storage();
    const first = runIn<{ a: number; b: number }>(
      dir,
      `const a = db.stmts.taskInsert.run("a", 0, "low", "").lastInsertRowid;
       const b = db.stmts.taskInsert.run("b", 0, "low", "").lastInsertRowid;
       db.stmts.taskDelete.run(b); // удаляем строку с самым большим id
       return { a, b };`,
    );
    const second = runIn<{ texts: string[]; next: number }>(
      dir,
      `const texts = db.stmts.taskAll.all().map((t) => t.text);
       const next = db.stmts.taskInsert.run("c", 0, "low", "").lastInsertRowid;
       return { texts, next };`,
    );
    expect(second.texts).toEqual(["a"]);
    // Раньше seq хранился в data.json и тоже не откатывался: ссылки на удалённые
    // строки (conversation_id, list_id…) не должны внезапно указывать на новые.
    expect(second.next).toBeGreaterThan(first.b);
  });

  it("колонка, добавленная в код позже, появляется в старой БД, значения не поехали", () => {
    const dir = storage();
    // «Старая» БД: создаём настоящую, затем снимаем с catalog колонку wingetId
    // (её добавили в код позже) и откатываем версию схемы.
    runIn(dir, `db.stmts.catInsert.run("Old", "https://old", "seed", "Other", null); return {};`);
    const old = new Database(path.join(dir, "data.db"));
    old.exec("ALTER TABLE catalog DROP COLUMN wingetId");
    old.pragma("user_version = 1");
    old.close();

    const res = runIn<{ cols: string[]; old: Record<string, unknown>; fresh: Record<string, unknown> }>(
      dir,
      `db.stmts.catInsert.run("New", "https://new", "seed", "Tools", "7zip.7zip");
       const rows = db.tables.catalog.all();
       return {
         cols: db.tables.catalog.cols,
         old: rows.find((r) => r.name === "Old"),
         fresh: rows.find((r) => r.name === "New"),
       };`,
    );
    expect(res.cols).toContain("wingetId");
    expect(res.old).toMatchObject({ name: "Old", favorite: 0, wingetId: null });
    expect(res.fresh).toMatchObject({ name: "New", wingetId: "7zip.7zip", favorite: 0 });
    // Версия схемы подтянулась до актуальной (миграция индексов применилась).
    const sq = new Database(path.join(dir, "data.db"), { readonly: true });
    try {
      expect(sq.pragma("user_version", { simple: true })).toBeGreaterThan(1);
    } finally {
      sq.close();
    }
  });

  it("БД от более новой версии приложения не открывается (чтобы не испортить данные)", () => {
    const dir = storage();
    const future = new Database(path.join(dir, "data.db"));
    future.pragma("user_version = 9999");
    future.close();
    expect(() => runIn(dir, "return 1;")).toThrow(/schema_too_new/);
  });

  it("старый data.json импортируется один раз и остаётся как data.json.migrated", () => {
    const dir = storage();
    fs.writeFileSync(
      path.join(dir, "data.json"),
      JSON.stringify({
        tasks: {
          cols: ["text", "done", "priority", "tag", "pos", "created_at"],
          rows: [{ id: 5, text: "из json", done: 0, priority: "high", tag: "", pos: 1, created_at: "x" }],
          seq: 9,
        },
      }),
    );
    const res = runIn<{ texts: string[]; next: number }>(
      dir,
      `const texts = db.stmts.taskAll.all().map((t) => t.text);
       const next = db.stmts.taskInsert.run("новая", 0, "low", "").lastInsertRowid;
       return { texts, next };`,
    );
    expect(res.texts).toEqual(["из json"]);
    expect(res.next).toBe(10); // seq из файла сохранён (9) — id не пересекаются
    expect(fs.existsSync(path.join(dir, "data.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "data.json.migrated"))).toBe(true);
    // Повторный запуск не импортирует заново и не дублирует строки.
    const again = runIn<string[]>(dir, "return db.stmts.taskAll.all().map((t) => t.text);");
    expect(again).toEqual(["из json", "новая"]);
  });

  it("backupTo делает самостоятельный консистентный снимок", () => {
    const dir = storage();
    const snap = path.join(dir, "snap.db");
    runIn(
      dir,
      `db.stmts.taskInsert.run("в снимке", 0, "low", "");
       db.backupTo(${JSON.stringify(snap)});
       return {};`,
    );
    const sq = new Database(snap, { readonly: true });
    try {
      expect(sq.prepare("SELECT text FROM tasks").all()).toEqual([{ text: "в снимке" }]);
    } finally {
      sq.close();
    }
  });
});
