import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

/**
 * Тесты хранилища (server/db): форма экспорта, импорт старого data.json, CRUD и persist.
 *
 * storage задаём ДО require: при первом запуске db импортирует data.json в SQLite.
 * Пишем СТАРЫЙ формат: catalog без wingetId, proxy_nodes без is_excluded.
 * Миграции схемы SQLite (версии, ALTER TABLE, слишком новая БД) проверяет
 * tests/dbMigrations.test.ts — там каждый сценарий идёт в отдельном процессе.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-db-"));
process.env.MOONAPP_STORAGE = STORAGE;

const legacyData = {
  catalog: {
    cols: ["name", "url", "source", "category", "favorite", "added_at"],
    rows: [
      {
        id: 1,
        name: "Old",
        url: "https://old.example",
        source: "seed",
        category: "Other",
        favorite: 1,
        added_at: "2024-01-01 00:00:00",
      },
    ],
    seq: 1,
  },
  proxy_nodes: {
    cols: ["sub_id", "name", "protocol", "config_json", "ping_ms", "country_code", "is_selected"],
    rows: [
      {
        id: 1,
        sub_id: 7,
        name: "legacy",
        protocol: "vless",
        config_json: JSON.stringify({ protocol: "vless", server: "1.1.1.1", port: 443 }),
        ping_ms: null,
        country_code: "",
        is_selected: 1,
      },
    ],
    seq: 1,
  },
};
fs.writeFileSync(path.join(STORAGE, "data.json"), JSON.stringify(legacyData), "utf8");

const require = createRequire(import.meta.url);
const dbm = require("../server/db");
const { stmts, tables, exportSnapshot, flush } = dbm;

const dbFile = path.join(STORAGE, "data.db");
/** Что реально лежит в файле БД (отдельное read-only соединение, мимо кэша в памяти). */
const onDisk = <T = any>(sql: string, ...args: unknown[]): T[] => {
  const ro = new Database(dbFile, { readonly: true });
  try {
    return ro.prepare(sql).all(...args) as T[];
  } finally {
    ro.close();
  }
};
describe("db — контракт CommonJS (порт server/db.js → server/ts/db.ts)", () => {
  it("отдаёт те же ключи, что .js-версия, и не имеет default", () => {
    // Роуты и тесты делают `require("./db")` и берут stmts/tables напрямую.
    expect(Object.keys(dbm).sort()).toEqual(
      [
        "SCHEMA_VERSION",
        "backupTo",
        "close",
        "db",
        "docStore",
        "exportSnapshot",
        "flush",
        "stmts",
        "tables",
      ].sort(),
    );
    expect(dbm.default).toBeUndefined();
  });

  it("db.exec/db.prepare — no-op заглушки для совместимости", () => {
    expect(dbm.db.exec()).toBeUndefined();
    expect(dbm.db.prepare().all()).toEqual([]);
    expect(dbm.db.prepare().get()).toBeNull();
  });
});

describe("db — импорт старого data.json", () => {
  it("переносит строки в SQLite, а старый файл оставляет как *.migrated", () => {
    expect(fs.existsSync(path.join(STORAGE, "data.json"))).toBe(false);
    expect(fs.existsSync(path.join(STORAGE, "data.json.migrated"))).toBe(true);
    expect(onDisk("SELECT name FROM catalog WHERE id = 1")).toEqual([{ name: "Old" }]);
    expect(onDisk("PRAGMA user_version")[0].user_version).toBe(dbm.SCHEMA_VERSION);
  });

  it("колонки берутся по именам: новые поля старых строк пусты, старые не поехали", () => {
    // is_excluded добавлена в код позже: у старого файла её нет.
    expect(tables.proxy_nodes.cols).toEqual([
      "sub_id",
      "name",
      "protocol",
      "config_json",
      "ping_ms",
      "country_code",
      "is_selected",
      "is_excluded",
    ]);
    // Старая строка читается по именам — её поля не поехали.
    const row = stmts.pnodeGet.get(1);
    expect(row.name).toBe("legacy");
    expect(row.is_selected).toBe(1);
    expect(row.is_excluded).toBeNull();
  });

  it("исключение и восстановление узла: скрытие снимает выбор", () => {
    // «Удаление» узла = is_excluded=1 (иначе обновление подписки вернёт его),
    // и выбор снимается, чтобы ядро не осталось на скрытом узле.
    stmts.pnodeExclude.run(1);
    expect(stmts.pnodeGet.get(1).is_excluded).toBe(1);
    expect(stmts.pnodeGet.get(1).is_selected).toBe(0);
    expect(stmts.pnodeExcludedForSub.all(7).map((n: any) => n.id)).toEqual([1]);
    stmts.pnodeRestore.run(1);
    expect(stmts.pnodeGet.get(1).is_excluded).toBe(0);
    expect(stmts.pnodeExcludedForSub.all(7)).toEqual([]);
  });

  it("insert после миграции колонок кладёт значения ровно в свои колонки", () => {
    // В .js-версии insert() раскладывал значения по порядку колонок из СТАРОГО файла,
    // а досыпанная колонка стояла в конце: для catalog (в файле не было wingetId)
    // значения уезжали в соседние колонки (favorite ← wingetId и т.д.).
    // Теперь порядок колонок всегда объявленный, и этот баг невозможен.
    stmts.catInsert.run("New", "https://new.example", "seed", "Tools", "7zip.7zip");
    const row = tables.catalog.all().find((r: any) => r.name === "New");
    expect(row.wingetId).toBe("7zip.7zip");
    expect(row.favorite).toBe(0);
    expect(String(row.added_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
describe("db — задачи (tasks)", () => {
  it("insert → all (по pos) → toggle/update → delete", () => {
    const a = stmts.taskInsert.run("первая", 0, "high", "work");
    const b = stmts.taskInsert.run("вторая", 0, "low", "home");
    // pos растёт автоматически: новые задачи идут в конец списка.
    const ids = stmts.taskAll.all().map((t: any) => t.text);
    expect(ids).toEqual(["первая", "вторая"]);
    stmts.taskToggle.run(1, a.lastInsertRowid);
    expect(tables.tasks.get(a.lastInsertRowid).done).toBe(1);
    stmts.taskUpdate.run("срочно", "priority", b.lastInsertRowid);
    expect(tables.tasks.get(b.lastInsertRowid).priority).toBe("срочно");
    // Перестановка: pos задаётся явно, all() сортирует по нему.
    stmts.taskOrder.run(0, b.lastInsertRowid);
    expect(stmts.taskAll.all().map((t: any) => t.text)).toEqual(["вторая", "первая"]);
    stmts.taskDelete.run(a.lastInsertRowid);
    expect(stmts.taskAll.all().map((t: any) => t.text)).toEqual(["вторая"]);
  });
});

describe("db — чаты", () => {
  it("conversations/messages: touch, recent-хвост, усечение истории", () => {
    const conv = stmts.convInsert.run("openai", "Новый чат");
    const id = conv.lastInsertRowid;
    stmts.msgInsert.run(id, "user", "привет");
    stmts.msgInsert.run(id, "assistant", "здравствуйте");
    stmts.msgInsert.run(id, "user", "ещё вопрос");
    expect(stmts.msgFor.all(id).map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(stmts.msgRecent.all(id, 2).map((m: any) => m.text)).toEqual([
      "здравствуйте",
      "ещё вопрос",
    ]);
    const msgs = stmts.msgFor.all(id);
    // «Регенерировать» со среднего сообщения: хвост начиная с него уходит.
    stmts.msgTruncateFrom.run(id, msgs[1].id);
    expect(stmts.msgFor.all(id).map((m: any) => m.text)).toEqual(["привет"]);
    // Удаление чата уносит и его сообщения.
    stmts.convDelete.run(id);
    expect(stmts.convGet.get(id)).toBeUndefined();
    expect(stmts.msgFor.all(id)).toEqual([]);
  });
});
describe("db — фильмы и сериалы", () => {
  it("watchlist: upsert по (kind, tmdb_id) — одна запись на тайтл", () => {
    stmts.mwUpsert.run("movie", 550, { title: "Fight Club", year: 1999, status: "plan" });
    stmts.mwUpsert.run("movie", 550, { status: "watched" });
    const rows = stmts.mwAll.all().filter((r: any) => r.kind === "movie" && r.tmdb_id === 550);
    expect(rows.length).toBe(1);
    // Патч обновляет только переданные поля: title сохранился.
    expect(stmts.mwGet.get("movie", 550).title).toBe("Fight Club");
    expect(stmts.mwGet.get("movie", 550).status).toBe("watched");
    // Другой kind — отдельная запись.
    stmts.mwUpsert.run("tv", 550, { title: "Другой сериал", status: "plan" });
    expect(stmts.mwAll.all().filter((r: any) => r.tmdb_id === 550).length).toBe(2);
    // tmdb_id приводится к числу: строка из query-параметра находит ту же запись.
    expect(stmts.mwGet.get("movie", "550").title).toBe("Fight Club");
    expect(stmts.mwGet.get("movie", 999)).toBeNull();
    stmts.mwDelete.run("movie", 550);
    expect(stmts.mwGet.get("movie", 550)).toBeNull();
  });

  it("оценки: set перезаписывает оценку, но не затирает title", () => {
    stmts.mrSet.run("movie", 13, "Forrest Gump", 9);
    stmts.mrSet.run("movie", 13, "", 10);
    const row = stmts.mrGet.get("movie", 13);
    expect(row.rating).toBe(10);
    expect(row.title).toBe("Forrest Gump");
    expect(stmts.mrAll.all().filter((r: any) => r.tmdb_id === 13).length).toBe(1);
    stmts.mrDelete.run("movie", 13);
    expect(stmts.mrGet.get("movie", 13)).toBeNull();
  });

  it("статистика просмотров: одна запись на тайтл, минуты берутся из runtime", () => {
    stmts.msUpsert.run("movie", 680, { title: "Pulp Fiction", runtime: 154 });
    const first = stmts.msGet.get("movie", 680);
    expect(first.minutes).toBe(154); // без patch.minutes — берём runtime
    expect(first.progress).toBe(1); // без patch.progress — считаем «просмотрено»
    stmts.msUpsert.run("movie", 680, { progress: 0.5, minutes: 77 });
    const again = stmts.msGet.get("movie", 680);
    expect(again.minutes).toBe(77);
    expect(again.progress).toBe(0.5);
    expect(stmts.msAll.all().filter((r: any) => r.tmdb_id === 680).length).toBe(1);
    stmts.msClear.run();
    expect(stmts.msAll.all()).toEqual([]);
  });

  it("кэш метаданных TMDB: set перезаписывает json и cached_at", () => {
    stmts.mmcSet.run("movie:550", '{"title":"Fight Club"}');
    expect(stmts.mmcGet.get("movie:550").json).toBe('{"title":"Fight Club"}');
    stmts.mmcSet.run("movie:550", '{"title":"Fight Club (1999)"}');
    expect(stmts.mmcGet.get("movie:550").json).toBe('{"title":"Fight Club (1999)"}');
    expect(stmts.mmcGet.get("нет-такого")).toBeNull();
    stmts.mmcClear.run();
    expect(stmts.mmcGet.get("movie:550")).toBeNull();
  });
});
describe("db — persist и заметки", () => {
  it("запись отложена, flush() сбрасывает её на диск немедленно", () => {
    // persist — дебаунс 300 мс: сразу после мутации в файле её ещё нет.
    const find = () =>
      onDisk("SELECT id FROM bypass_custom_domains WHERE domain = ?", "persist-check.example");
    stmts.bcdInsert.run("persist-check.example", "domain", 1);
    expect(find()).toEqual([]);
    flush();
    expect(find().length).toBe(1);
    // В файле есть все таблицы схемы.
    const names = onDisk<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(
      (r) => r.name,
    );
    expect(names).toEqual(expect.arrayContaining(["tasks", "proxy_nodes", "_seq"]));
  });

  it("на диск уходят только изменённые строки: правка и удаление видны после flush", () => {
    const t = stmts.taskInsert.run("для диска", 0, "low", "");
    flush();
    expect(onDisk("SELECT text FROM tasks WHERE id = ?", t.lastInsertRowid)).toEqual([
      { text: "для диска" },
    ]);
    stmts.taskUpdate.run("поправлено", "text", t.lastInsertRowid);
    flush();
    expect(onDisk("SELECT text FROM tasks WHERE id = ?", t.lastInsertRowid)[0].text).toBe(
      "поправлено",
    );
    stmts.taskDelete.run(t.lastInsertRowid);
    flush();
    expect(onDisk("SELECT id FROM tasks WHERE id = ?", t.lastInsertRowid)).toEqual([]);
  });

  it("upsert результатов проверки тоже попадает на диск (раньше правка обходила учёт)", () => {
    stmts.bcrUpsert.run("s-disk", { file: "a.bat", ok: true, ok_count: 3 });
    stmts.bcrUpsert.run("s-disk", { file: "a.bat", ok: false, ok_count: 5 });
    flush();
    const rows = onDisk("SELECT ok, ok_count FROM bypass_check_results WHERE strategy_id = 's-disk'");
    expect(rows).toEqual([{ ok: 0, ok_count: 5 }]);
  });

  it("булевы колонки возвращаются булевыми, числа остаются числами, строки — строками", () => {
    stmts.tdUpsert.run({ info_hash: "abc", name: "n", kept: true, length: 7, release_id: "007" });
    flush();
    const row = stmts.tdGet.get("abc");
    expect(row.kept).toBe(true);
    expect(row.length).toBe(7);
    expect(row.release_id).toBe("007"); // не превратилась в число 7
    stmts.tdDelete.run("abc");
  });

  it("exportSnapshot отдаёт задачи, чаты, сообщения и архивные страницы", () => {
    const snap = exportSnapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "archivedPages",
      "conversations",
      "messages",
      "tasks",
    ]);
    // Это копии (Table.all()), а не живые строки: правка снимка не меняет стор.
    snap.tasks.push({ id: -1, text: "ghost" });
    expect(stmts.taskAll.all().some((t: any) => t.id === -1)).toBe(false);
  });

  it("заметки живут в .md-файлах, а id синхронизируется с файлом лекции", () => {
    // noteUpsert пишет заметку с ЗАДАННЫМ id (тот же id — тот же файл),
    // это связка «заметка лекции ↔ .md».
    stmts.noteUpsert.run(42, { title: "Лекция", content: "тезисы", tags: "учёба", folder: "vuz" });
    expect(stmts.noteGet.get(42).title).toBe("Лекция");
    expect(stmts.noteSearch.all("тезисы").length).toBe(1);
    const files = fs.readdirSync(path.join(STORAGE, "notes")).filter((f) => f.endsWith(".md"));
    expect(files.some((f) => f.startsWith("42-"))).toBe(true);
    stmts.noteUpsert.run(42, { content: "обновлённые тезисы" });
    expect(stmts.noteGet.get(42).content).toBe("обновлённые тезисы");
    stmts.noteDelete.run(42);
    expect(stmts.noteGet.get(42)).toBeUndefined();
    expect(fs.readdirSync(path.join(STORAGE, "notes")).filter((f) => f.startsWith("42-"))).toEqual(
      [],
    );
  });
});
