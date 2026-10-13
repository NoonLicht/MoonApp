/**
 * Хранилище приложения: SQLite (better-sqlite3), файл storage/data.db.
 *
 * Раньше это был один data.json, который целиком переписывался при каждом
 * изменении (сейчас — сотни КБ на каждую правку), без схемы, версий и индексов.
 * Теперь:
 *  - схема версионируется через PRAGMA user_version, миграции — в MIGRATIONS;
 *  - новые колонки, добавленные в объявления таблиц ниже, досыпаются в БД сами
 *    (ALTER TABLE ... ADD COLUMN), значения при этом ложатся ровно в свои колонки;
 *  - на диск пишутся только изменённые строки (одной транзакцией, дебаунс 300 мс);
 *  - есть индексы на полях, по которым ищут чаще всего;
 *  - старый data.json при первом запуске импортируется и переименовывается в
 *    data.json.migrated (остаётся как резервная копия, ничего не удаляется).
 *
 * API остался прежним (`stmts.*.run/get/all`, `tables`, `exportSnapshot`, `flush`):
 * строки таблиц держатся в памяти, как и раньше, — чтение остаётся мгновенным, а
 * SQLite отвечает за надёжное и быстрое сохранение. Таблицы небольшие (тысячи
 * строк), поэтому держать их целиком в памяти дёшево.
 *
 * TS-исходник: компилируется в server/db.js командой `npm run compile:server`,
 * поэтому `const { stmts } = require("./db")` из роутов и тестов работает как раньше.
 */
import fs from "fs";
import Database from "better-sqlite3";
import config from "./config";
import logger from "./logger";
import { applyPendingDbRestore } from "./backupManifest";
import * as notesFs from "./notes-fs";

const { FILES } = config;

/**
 * Значение колонки. Значения приходят из роутов и UI и валидации не имели никогда
 * (SQLite динамически типизирован, колонки объявлены без типа и хранят то, что
 * положили: число — числом, строка — строкой), поэтому здесь any — сузить до
 * unknown означало бы кастовать в каждом потребителе без всякой пользы.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = any;

/** Строка таблицы: id есть всегда, остальные поля — по объявленным колонкам. */
export interface Row {
  id: number;
  [column: string]: Value;
}

/** Патч строки: подмножество колонок с новыми значениями. */
type Patch = Record<string, Value>;

/** Загрузка строк из старого data.json (только для разового импорта). */
interface LegacyTableJSON {
  cols?: string[];
  rows?: Row[];
  seq?: number;
}

/** Результат мутации в стиле SQLite (роуты смотрят только на changes). */
export interface RunResult {
  changes?: number;
  lastInsertRowid?: number;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/** Значение в то, что умеет принимать better-sqlite3. */
function toSql(v: Value): number | string | bigint | Buffer | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "bigint" || Buffer.isBuffer(v)) return v;
  return JSON.stringify(v);
}

class Table {
  /** Имя таблицы в БД; выставляется после объявления (см. ниже). */
  name = "";
  cols: string[];
  orderBy: string | null;
  rows: Row[];
  seq: number;
  /** Колонки-флаги: в SQLite лежат как 0/1, в памяти — boolean. */
  boolCols: Set<string> = new Set();
  /** id строк, которые нужно записать, и id удалённых — до ближайшего persist. */
  dirty: Set<number> = new Set();
  removed: Set<number> = new Set();
  seqDirty = false;

  constructor(cols: string[], orderBy: string | null) {
    this.cols = cols;
    this.orderBy = orderBy; // "pos" или "-updated_at" (минус — это DESC)
    this.rows = [];
    this.seq = 0;
  }

  insert(values: Value[]): { lastInsertRowid: number } {
    const id = ++this.seq;
    const row: Row = { id };
    this.cols.forEach((c, i) => {
      row[c] = values[i];
    });
    this.rows.push(row);
    this.dirty.add(id);
    this.seqDirty = true;
    return { lastInsertRowid: id };
  }

  all(): Row[] {
    const list = this.rows.slice();
    if (this.orderBy) {
      const desc = this.orderBy.startsWith("-");
      const key = desc ? this.orderBy.slice(1) : this.orderBy;
      list.sort((a, b) => {
        if (a[key] === b[key]) return 0;
        const cmp = a[key] > b[key] ? 1 : -1;
        return desc ? -cmp : cmp;
      });
    }
    return list.map((r) => ({ ...r }));
  }

  get(id: number): Row | undefined {
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : undefined;
  }

  updateWhere(fn: (row: Row) => boolean, patch: Patch): { changes: number } {
    let changes = 0;
    this.rows.forEach((r) => {
      if (fn(r)) {
        Object.assign(r, patch);
        this.dirty.add(r.id);
        changes++;
      }
    });
    return { changes };
  }

  delete(id: number): { changes: number } {
    return this.deleteWhere((r) => r.id === id);
  }

  deleteWhere(fn: (row: Row) => boolean): { changes: number } {
    const keep: Row[] = [];
    let changes = 0;
    for (const r of this.rows) {
      if (fn(r)) {
        this.dirty.delete(r.id);
        this.removed.add(r.id);
        changes++;
      } else {
        keep.push(r);
      }
    }
    if (changes) this.rows = keep;
    return { changes };
  }
}

/**
 * Таблицы стора. Порядок объявления не важен, но важен порядок КОЛОНОК:
 * insert пишет значения позиционно. Новые колонки добавляйте В КОНЕЦ списка —
 * существующая БД получит их автоматически (см. ensureColumns).
 */
const tables: Record<string, Table> = {
  tasks: new Table(["text", "done", "priority", "tag", "pos", "created_at"], "pos"),
  conversations: new Table(
    ["provider", "title", "created_at", "updated_at", "pinned"],
    "-updated_at",
  ),
  // gen_ms/tokens — время генерации и оценка токенов ответа (колонки в конце: старая БД дополнится сама)
  messages: new Table(["conversation_id", "role", "text", "created_at", "gen_ms", "tokens"], "id"),
  archived_pages: new Table(["name", "size_text", "saved_at"], "-id"), // устарело (М9), оставлено для совместимости старых data.json
  books: new Table(["title", "author", "year", "fmt", "tone", "description"], "title"),
  catalog: new Table(
    ["name", "url", "source", "category", "wingetId", "favorite", "added_at"],
    "-id",
  ),
  favorites: new Table(["key"], "key"),
  // Документы-JSON по видам (RSS-ленты и статьи, последняя ИИ-сводка): одна строка = один документ.
  app_docs: new Table(["kind", "uid", "json"], null),
  // Lecture Recorder: сессии лекций и чанки расшифровки.
  lectures: new Table(
    [
      "title",
      "started_at",
      "ended_at",
      "duration_ms",
      "sample_rate",
      "channels",
      "raw_file",
      "status",
      "notes",
    ],
    "-id",
  ),
  lecture_chunks: new Table(
    [
      "lecture_id",
      "idx",
      "start_ms",
      "end_ms",
      "text",
      "status",
      "error",
      "file",
      "created_at",
      // Диагностика чанка: почему он пустой/пропущен и с каким уровнем звука
      // (см. server/vad.js — «empty» больше не выдаётся за решение VAD).
      "reason",
      "rms_db",
      "rms_peak_db",
      "speech_ratio",
      "noise_floor_db",
      "threshold_db",
      "zcr",
      // Дорожка записи: mic — микрофон/аудитория, sys — системный звук (эфир лектора).
      "source",
    ],
    "id",
  ),
  // Zapret / DPI bypass: профили запуска и пользовательские домены.
  bypass_profiles: new Table(
    ["name", "batch_file_path", "custom_args", "is_active", "is_service", "created_at"],
    "-id",
  ),
  bypass_custom_domains: new Table(["domain", "type", "is_enabled"], "domain"),
  // Результаты последней полной проверки конфигов (огоньки на странице Bypass).
  bypass_check_results: new Table(
    [
      "strategy_id",
      "file",
      "ok",
      "ok_count",
      "error",
      "unsup",
      "ping_ok",
      "ping_fail",
      "checked_at",
      "run_started_at",
    ],
    "strategy_id",
  ),
  // Встроенный прокси (sing-box): подписки, узлы и правила «страница → прокси».
  // config_json хранит нормализованный узел (см. server/proxyCore.js parseUri).
  // is_excluded: узел, который пользователь убрал из списка вручную. Храним его
  // как «скрытый», а не удаляем: иначе авто-обновление подписки вернёт его назад.
  proxy_subscriptions: new Table(["name", "url", "last_updated", "auto_update_enabled"], "-id"),
  proxy_nodes: new Table(
    [
      "sub_id",
      "name",
      "protocol",
      "config_json",
      "ping_ms",
      "country_code",
      "is_selected",
      "is_excluded",
    ],
    "-id",
  ),
  // Прокси-правило страницы: route_path = id страницы приложения ('video', 'music'…),
  // is_proxied: 1 — трафик страницы идёт через прокси, 0 — напрямую (bypass).
  proxy_page_rules: new Table(["route_path", "is_proxied"], "route_path"),

  // ---- Фильмы и сериалы (страница «movies»): личный список и статистика ----
  // kind: "movie" | "tv", tmdb_id — идентификатор тайтла в TMDB.
  // status: "plan" (в планах) | "watching" (смотрю) | "watched" (просмотрено).
  media_watchlist: new Table(
    [
      "kind",
      "tmdb_id",
      "title",
      "poster",
      "year",
      "status",
      "runtime",
      "genres",
      "added_at",
      "updated_at",
      // Прогресс просмотра сериала (kind="tv"): номер сезона/серии, на которой
      // остановился. 0 — не отмечено (у фильмов всегда 0, поле не используется).
      "watched_season",
      "watched_episode",
    ],
    "-updated_at",
  ),
  // Личная оценка 1–10 (одна запись на тайтл).
  media_ratings: new Table(["kind", "tmdb_id", "title", "rating", "updated_at"], "-updated_at"),
  // Свои закладки (папки) — в отличие от watchlist (один статус на тайтл на
  // ВСЁ приложение), здесь пользователь сам заводит любое число именованных
  // списков ("Пересмотреть", "Посоветовать другу" и т.п.), и один тайтл может
  // быть сразу в нескольких. bookmark_lists — сами папки, bookmark_items —
  // связь папка↔тайтл (list_id ссылается на id из bookmark_lists).
  media_bookmark_lists: new Table(["name", "created_at"], "-created_at"),
  media_bookmark_items: new Table(
    ["list_id", "kind", "tmdb_id", "title", "poster", "year", "added_at"],
    "-added_at",
  ),
  // Статистика просмотров: каждая запись — факт просмотра/прогресс тайтла.
  // genres/cast — JSON-строки массивов (жанры и главные актёры из TMDB),
  // minutes — потраченные минуты (runtime × доля прогресса), для «часов просмотра».
  media_watch_stats: new Table(
    ["kind", "tmdb_id", "title", "genres", "cast", "runtime", "progress", "minutes", "watched_at"],
    "-watched_at",
  ),
  // Кэш ответов TMDB (страницы каталога, детали, жанры), чтобы не дёргать API зря.
  media_meta_cache: new Table(["key", "json", "cached_at"], "-id"),
  // Кэш поиска по форуму-трекеру (страница «Фильмы»): не долбим форум при каждом
  // перерендере страницы. Ключ — адрес форума + строка поиска + лимит.
  tracker_search_cache: new Table(["key", "json", "cached_at"], "-id"),

  // ---- Торрент-плеер: реестр загрузок («Скачанные» на странице «Фильмы») ----
  // Зачем таблица, а не память процесса: пользователь должен видеть загрузки и
  // после перезапуска, а окно плеера — восстанавливаться, если его случайно
  // закрыли. source: "magnet" | "tracker" | "file"; magnet/метафайл нужны для
  // возобновления (resumeDownload); kept — «хранить файлы после просмотра»;
  // position — секунда, на которой остановились (продолжаем с неё).
  torrent_downloads: new Table(
    [
      "info_hash",
      "name",
      "title",
      "release_id",
      "magnet",
      "source",
      "length",
      "state",
      "kept",
      "position",
      "added_at",
      "updated_at",
    ],
    "-updated_at",
  ),
};

for (const [name, t] of Object.entries(tables)) t.name = name;
tables.torrent_downloads.boolCols.add("kept");

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// SQLite: открытие, схема, миграции
// ---------------------------------------------------------------------------

/**
 * Миграции схемы. Номер = значение PRAGMA user_version после применения.
 * Добавили колонку в объявление таблицы выше — миграция НЕ нужна (ensureColumns
 * досыплет её). Миграция нужна для всего остального: индексы, переименования,
 * пересчёт данных. Уже выпущенные миграции не правим — только дописываем новые.
 */
interface Migration {
  version: number;
  name: string;
  up: (sqlite: Database.Database) => void;
}

/** Индексы по полям, на которые приходятся выборки и проверки существования. */
const INDEXES: [table: string, columns: string[]][] = [
  ["messages", ["conversation_id"]],
  ["lecture_chunks", ["lecture_id"]],
  ["proxy_nodes", ["sub_id"]],
  ["media_watchlist", ["kind", "tmdb_id"]],
  ["media_ratings", ["kind", "tmdb_id"]],
  ["media_watch_stats", ["kind", "tmdb_id"]],
  ["media_bookmark_items", ["list_id"]],
  ["media_meta_cache", ["key"]],
  ["tracker_search_cache", ["key"]],
  ["torrent_downloads", ["info_hash"]],
  ["bypass_check_results", ["strategy_id"]],
  ["proxy_page_rules", ["route_path"]],
];

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: (sqlite) => {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS _seq (name TEXT PRIMARY KEY, seq INTEGER NOT NULL)`);
      for (const t of Object.values(tables)) {
        // Колонки без типа: SQLite хранит значение как есть (число — числом, строка
        // — строкой), как раньше хранил JSON.
        const cols = t.cols.map(q).join(", ");
        sqlite.exec(`CREATE TABLE IF NOT EXISTS ${q(t.name)} (id INTEGER PRIMARY KEY, ${cols})`);
      }
    },
  },
  {
    version: 2,
    name: "indexes",
    up: (sqlite) => {
      for (const [table, columns] of INDEXES) {
        sqlite.exec(
          `CREATE INDEX IF NOT EXISTS ${q(`idx_${table}_${columns.join("_")}`)} ON ${q(table)} (${columns.map(q).join(", ")})`,
        );
      }
    },
  },
  {
    version: 3,
    name: "app_docs (RSS в БД)",
    up: (sqlite) => {
      // Таблица добавлена после выпуска v1 — у уже созданных БД её нет.
      sqlite.exec(
        `CREATE TABLE IF NOT EXISTS app_docs (id INTEGER PRIMARY KEY, "kind", "uid", "json")`,
      );
      sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_app_docs_kind ON app_docs ("kind")`);
    },
  },
];

/** Актуальная версия схемы (последняя миграция). */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function applyMigrations(sqlite: Database.Database): void {
  const current = Number(sqlite.pragma("user_version", { simple: true })) || 0;
  if (current > SCHEMA_VERSION) {
    // БД создана более новой версией приложения: молча работать с ней нельзя —
    // старый код не знает новых колонок и мог бы испортить данные.
    throw new Error(
      `db.schema_too_new: data.db имеет версию схемы ${current}, приложение знает только ${SCHEMA_VERSION}. Обновите приложение.`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    sqlite.transaction(() => {
      m.up(sqlite);
      sqlite.pragma(`user_version = ${m.version}`);
    })();
    logger.info("db.migrated", { version: m.version, name: m.name });
  }
}

/** Досыпает колонки, добавленные в объявления таблиц после создания БД. */
function ensureColumns(sqlite: Database.Database): void {
  for (const t of Object.values(tables)) {
    const have = new Set(
      (sqlite.prepare(`PRAGMA table_info(${q(t.name)})`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const c of t.cols) {
      if (have.has(c)) continue;
      sqlite.exec(`ALTER TABLE ${q(t.name)} ADD COLUMN ${q(c)}`);
      logger.info("db.column_added", { table: t.name, column: c });
    }
  }
}

function loadTables(sqlite: Database.Database): void {
  const seqs = new Map(
    (sqlite.prepare(`SELECT name, seq FROM _seq`).all() as { name: string; seq: number }[]).map(
      (r) => [r.name, r.seq],
    ),
  );
  for (const t of Object.values(tables)) {
    const rows = sqlite.prepare(`SELECT * FROM ${q(t.name)} ORDER BY id`).all() as Row[];
    if (t.boolCols.size) {
      for (const r of rows) {
        for (const c of t.boolCols) if (r[c] !== null && r[c] !== undefined) r[c] = !!r[c];
      }
    }
    t.rows = rows;
    t.seq = Math.max(seqs.get(t.name) ?? 0, ...rows.map((r) => r.id));
    t.dirty.clear();
    t.removed.clear();
    t.seqDirty = false;
  }
}

/**
 * Разовый импорт старого data.json. Колонки берутся по именам: строки из файла,
 * записанного до добавления новых колонок, просто получают для них NULL.
 */
function importLegacyJson(sqlite: Database.Database, file: string): void {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, LegacyTableJSON>;
  let imported = 0;
  sqlite.transaction(() => {
    for (const t of Object.values(tables)) {
      const src = data[t.name];
      if (!src?.rows?.length) {
        if (src?.seq) sqlite.prepare(`INSERT OR REPLACE INTO _seq VALUES (?, ?)`).run(t.name, src.seq);
        continue;
      }
      const cols = ["id", ...t.cols];
      const ins = sqlite.prepare(
        `INSERT OR REPLACE INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      );
      let maxId = 0;
      for (const row of src.rows) {
        if (!Number.isInteger(row.id)) continue;
        ins.run(...cols.map((c) => toSql(row[c])));
        maxId = Math.max(maxId, row.id);
        imported++;
      }
      sqlite
        .prepare(`INSERT OR REPLACE INTO _seq VALUES (?, ?)`)
        .run(t.name, Math.max(src.seq ?? 0, maxId));
    }
  })();

  // Заметки раньше лежали в data.json, потом переехали в .md (notes-fs).
  const legacyNotes = (data as { notes?: { rows?: Row[] } }).notes?.rows;
  if (legacyNotes?.length) {
    const notesDir = notesFs.NOTES_DIR;
    const hasMd =
      fs.existsSync(notesDir) && fs.readdirSync(notesDir).some((f) => f.endsWith(".md"));
    if (!hasMd) {
      logger.info("notes-fs.migrate.start", { count: legacyNotes.length });
      for (const note of legacyNotes) {
        notesFs.insert(note.title, note.content, note.tags || "", note.folder || "");
      }
      logger.info("notes-fs.migrate.done", { count: legacyNotes.length });
    }
  }
  logger.info("db.legacy_import", { rows: imported });
}

function openDatabase(): Database.Database {
  // Восстановление из бэкапа подменяет файл ДО открытия базы (см. backupManifest.ts).
  applyPendingDbRestore(FILES.db);
  const isNew = !fs.existsSync(FILES.db);
  const sqlite = new Database(FILES.db);
  try {
    // WAL: запись не блокирует чтение, файл не «переписывается» целиком.
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    applyMigrations(sqlite);
    ensureColumns(sqlite);
    if (isNew && fs.existsSync(FILES.data)) {
      importLegacyJson(sqlite, FILES.data);
      // Старый файл не удаляем — это резервная копия на случай отката.
      try {
        fs.renameSync(FILES.data, FILES.data + ".migrated");
      } catch (e) {
        logger.warn("db.legacy_rename_failed", { error: (e as Error).message });
      }
    }
    loadTables(sqlite);
    return sqlite;
  } catch (e) {
    sqlite.close();
    throw e;
  }
}

let sqlite: Database.Database | null = openDatabase();

/** Живое соединение (после close() использовать нельзя). */
function conn(): Database.Database {
  if (!sqlite) throw new Error("db.closed: соединение с БД закрыто");
  return sqlite;
}

/**
 * Прямой доступ к соединению для производных индексов (полнотекстовый поиск).
 * Прикладные данные через него не пишем — для них есть stmts/docStore.
 */
export function connection(): Database.Database {
  return conn();
}

// ---------------------------------------------------------------------------
// Сохранение изменений
// ---------------------------------------------------------------------------

/** Записывает в БД только изменённые строки — одной транзакцией. */
function persistNow(): void {
  if (!sqlite) return;
  const db = sqlite;
  try {
    db.transaction(() => {
      for (const t of Object.values(tables)) {
        if (!t.dirty.size && !t.removed.size && !t.seqDirty) continue;
        if (t.removed.size) {
          const del = db.prepare(`DELETE FROM ${q(t.name)} WHERE id = ?`);
          for (const id of t.removed) del.run(id);
          t.removed.clear();
        }
        if (t.dirty.size) {
          const cols = ["id", ...t.cols];
          const up = db.prepare(
            `INSERT OR REPLACE INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          );
          for (const row of t.rows) {
            if (t.dirty.has(row.id)) up.run(...cols.map((c) => toSql(row[c])));
          }
          t.dirty.clear();
        }
        if (t.seqDirty) {
          db.prepare(`INSERT OR REPLACE INTO _seq VALUES (?, ?)`).run(t.name, t.seq);
          t.seqDirty = false;
        }
      }
    })();
  } catch (e) {
    // Изменения остаются помеченными (dirty) и уйдут при следующей попытке.
    logger.error("persist.error", { error: (e as Error).message });
  }
}

// М8: persist дебаунсится на 300 мс — при серии мутаций (стриминг чата) диск
// дёргается один раз. flush() вызывается на exit, чтобы ничего не терялось.
let persistTimer: NodeJS.Timeout | null = null;

function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 300);
  if (persistTimer.unref) persistTimer.unref();
}

/** Немедленный сброс отложенной записи (используется бэкапом и exit-хуком). */
export function flush(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}

/** Сбросить запись и закрыть соединение (завершение работы, тесты). */
export function close(): void {
  flush();
  if (sqlite) {
    try {
      sqlite.close();
    } catch {
      /* уже закрыта */
    }
    sqlite = null;
  }
}

/**
 * Консистентный снимок БД одним файлом (для бэкапов): VACUUM INTO не мешает
 * работе приложения и не тащит за собой WAL-файлы.
 */
export function backupTo(file: string): void {
  flush();
  if (fs.existsSync(file)) fs.rmSync(file);
  conn().prepare(`VACUUM INTO ?`).run(file);
}

process.on("exit", () => {
  if (sqlite) {
    if (persistTimer) clearTimeout(persistTimer);
    persistNow();
  }
});

/** Мутация + сохранение на диск. */
function run<T>(mutator: () => T): T {
  const out = mutator();
  persist();
  return out;
}
/**
 * Хранилище JSON-документов по видам (kind). sync() приводит набор документов вида к
 * переданному: меняет только изменившиеся строки, добавляет новые, удаляет исчезнувшие.
 */
export const docStore = {
  all(kind: string): { uid: string; json: string }[] {
    return tables.app_docs.rows
      .filter((r) => r.kind === kind)
      .map((r) => ({ uid: String(r.uid), json: String(r.json) }));
  },
  get(kind: string, uid: string): string | undefined {
    const r = tables.app_docs.rows.find((x) => x.kind === kind && x.uid === uid);
    return r ? String(r.json) : undefined;
  },
  set(kind: string, uid: string, json: string): void {
    const t = tables.app_docs;
    const r = t.rows.find((x) => x.kind === kind && x.uid === uid);
    if (!r) t.insert([kind, uid, json]);
    else if (r.json !== json) t.updateWhere((x) => x.id === r.id, { json });
    else return;
    persist();
  },
  /** Удаляет документы вида, у которых uid подходит под условие. */
  deleteWhere(kind: string, match: (uid: string) => boolean): number {
    const n = tables.app_docs.deleteWhere((r) => r.kind === kind && match(String(r.uid))).changes;
    if (n) persist();
    return n;
  },
  sync(kind: string, next: Map<string, string>): void {
    const t = tables.app_docs;
    const have = new Map<string, Row>();
    for (const r of t.rows) if (r.kind === kind) have.set(String(r.uid), r);
    let changed = false;
    for (const [uid, json] of next) {
      const row = have.get(uid);
      if (!row) {
        t.insert([kind, uid, json]);
        changed = true;
      } else if (row.json !== json) {
        t.updateWhere((r) => r.id === row.id, { json });
        changed = true;
      }
    }
    const gone = new Set<number>();
    for (const [uid, row] of have) if (!next.has(uid)) gone.add(row.id);
    if (gone.size) {
      t.deleteWhere((r) => gone.has(r.id));
      changed = true;
    }
    if (changed) persist();
  },
};

// ---- stmts: единая точка доступа (API как у SQL-версии) ----
// Параметры объявлены Value (= any): значения приходят из роутов и UI и раньше
// никак не проверялись. Так типы не мешают читать код, но и не врут про
// строгость, которой в .js-версии не было.
export const stmts = {
  // Tasks
  taskInsert: {
    run: (text: Value, done: Value, priority: Value, tag: Value) =>
      run(() => {
        const maxPos = tables.tasks.rows.reduce((m, r) => Math.max(m, r.pos || 0), 0);
        return tables.tasks.insert([text, done, priority, tag, maxPos + 1, now()]);
      }),
  },
  taskAll: { all: () => tables.tasks.all() },
  taskToggle: {
    run: (done: Value, id: Value) =>
      run(() => tables.tasks.updateWhere((r) => r.id === id, { done })),
  },
  taskDelete: { run: (id: Value) => run(() => tables.tasks.delete(id)) },
  taskUpdate: {
    run: (value: Value, field: Value, id: Value) =>
      run(() => tables.tasks.updateWhere((r) => r.id === id, { [field]: value })),
  },
  taskOrder: {
    run: (pos: Value, id: Value) =>
      run(() => tables.tasks.updateWhere((r) => r.id === id, { pos })),
  },

  // Conversations
  convInsert: {
    run: (provider: Value, title: Value) =>
      run(() => tables.conversations.insert([provider, title, now(), now(), 0])),
  },
  convAll: { all: () => tables.conversations.all() },
  convGet: { get: (id: Value) => tables.conversations.get(id) },
  convTouch: {
    run: (id: Value) =>
      run(() => tables.conversations.updateWhere((r) => r.id === id, { updated_at: now() })),
  },
  convDelete: {
    run: (id: Value) =>
      run(() => {
        tables.conversations.delete(id);
        tables.messages.deleteWhere((m) => m.conversation_id === id);
      }),
  },
  convUpdate: {
    run: (id: Value, patch: Value) =>
      run(() =>
        tables.conversations.updateWhere((r) => r.id === id, { ...patch, updated_at: now() }),
      ),
  },
  // Messages
  msgInsert: {
    run: (
      conversation_id: Value,
      role: Value,
      text: Value,
      gen_ms: Value = null,
      tokens: Value = null,
    ) => run(() => tables.messages.insert([conversation_id, role, text, now(), gen_ms, tokens])),
  },
  msgFor: {
    all: (conversation_id: Value) =>
      tables.messages.all().filter((m) => m.conversation_id === conversation_id),
  },
  msgRecent: {
    all: (conversation_id: Value, limit: Value) =>
      tables.messages
        .all()
        .filter((m) => m.conversation_id === conversation_id)
        .slice(-limit),
  },
  // Усечь историю начиная с message id (для «Регенерировать» / «Редактировать»)
  msgTruncateFrom: {
    run: (conversation_id: Value, fromId: Value) =>
      run(() =>
        tables.messages.deleteWhere((m) => m.conversation_id === conversation_id && m.id >= fromId),
      ),
  },

  // Archives
  archInsert: {
    run: (name: Value, size_text: Value) =>
      run(() => tables.archived_pages.insert([name, size_text, now()])),
  },
  archAll: { all: () => tables.archived_pages.all() },

  // Notes — файловое хранение (каждая заметка = .md файл в storage/notes/)
  noteAll: { all: () => notesFs.all() },
  noteGet: { get: (id: Value) => notesFs.get(id) },
  noteInsert: {
    run: (title: Value, content: Value, tags: Value, folder: Value) =>
      notesFs.insert(title, content, tags, folder),
  },
  noteUpdate: {
    run: (title: Value, content: Value, tags: Value, folder: Value, id: Value) =>
      notesFs.update(title, content, tags, folder, id),
  },
  // Запись заметки с заданным id (синхронизация заметок лекций с .md файлом):
  // тот же id — тот же файл, а удалённый с диска файл создаётся заново.
  noteUpsert: { run: (id: Value, fields: Value) => notesFs.upsert(id, fields) },
  noteDelete: { run: (id: Value) => notesFs.delete(id) },
  noteDeleteAll: { run: () => notesFs.deleteAll() },
  noteSearch: { all: (q: Value) => notesFs.search(q) },

  // Books
  bookAll: { all: () => tables.books.all() },
  bookInsert: {
    run: (title: Value, author: Value, year: Value, fmt: Value, tone: Value, description: Value) =>
      run(() => tables.books.insert([title, author, year, fmt, tone, description])),
  },
  // Catalog
  catAll: { all: () => tables.catalog.all() },
  catInsert: {
    run: (name: Value, url: Value, source: Value, category: Value, wingetId: Value) =>
      run(() =>
        tables.catalog.insert([name, url, source, category || "Other", wingetId || null, 0, now()]),
      ),
  },
  catDelete: { run: (id: Value) => run(() => tables.catalog.delete(id)) },
  catSetFavorite: {
    run: (id: Value, favorite: Value) =>
      run(() => tables.catalog.updateWhere((r) => r.id === id, { favorite: favorite ? 1 : 0 })),
  },
  catGet: { get: (id: Value) => tables.catalog.get(id) },

  // Favorites
  favAll: { all: () => tables.favorites.all() },
  favHas: (key: Value) => !!tables.favorites.rows.find((r) => r.key === key),
  favAdd: (key: Value) =>
    run(() => {
      if (!tables.favorites.rows.find((r) => r.key === key)) tables.favorites.insert([key]);
    }),
  favRemove: (key: Value) => run(() => tables.favorites.deleteWhere((r) => r.key === key)),

  // Lectures
  lectureInsert: {
    run: (title: Value, sample_rate: Value, channels: Value) =>
      run(() =>
        tables.lectures.insert([title, now(), null, 0, sample_rate, channels, "", "recording", ""]),
      ),
  },
  lectureAll: { all: () => tables.lectures.all() },
  lectureGet: { get: (id: Value) => tables.lectures.get(id) },
  lectureUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.lectures.updateWhere((r) => r.id === id, patch)),
  },
  lectureDelete: {
    run: (id: Value) =>
      run(() => {
        tables.lectures.delete(id);
        tables.lecture_chunks.deleteWhere((c) => c.lecture_id === id);
      }),
  },
  // Lecture chunks
  // extra = { status, source, reason, rmsDb, ... } — диагностика пишется сразу,
  // чтобы UI показал причину («шум», «тихий сигнал») в той же строке, что и чанк.
  chunkInsert: {
    run: (
      lecture_id: Value,
      idx: Value,
      start_ms: Value,
      end_ms: Value,
      file: Value,
      extra: Value = null,
    ) =>
      run(() => {
        const info = tables.lecture_chunks.insert([
          lecture_id,
          idx,
          start_ms,
          end_ms,
          "",
          "pending",
          "",
          file,
          now(),
        ]);
        if (extra && Object.keys(extra).length)
          tables.lecture_chunks.updateWhere((r) => r.id === info.lastInsertRowid, extra);
        return info;
      }),
  },
  /** Строка-объяснение пропуска VAD: без WAV, без Whisper — только причина и уровень. */
  chunkInsertSkipped: {
    run: (lecture_id: Value, idx: Value, start_ms: Value, end_ms: Value, skip: Value) =>
      run(() =>
        tables.lecture_chunks.insert([
          lecture_id,
          idx,
          start_ms,
          end_ms,
          "",
          "vad_skip",
          "",
          "",
          now(),
          String(skip.reason || "noise"),
          Number(skip.rmsDb ?? -100),
          Number(skip.rmsPeakDb ?? -100),
          Number(skip.speechRatio ?? 0),
          Number(skip.noiseDb ?? -100),
          Number(skip.thresholdDb ?? -100),
          Number(skip.zcr ?? 0),
          String(skip.source || "mic"),
        ]),
      ),
  },
  chunkFor: {
    all: (lecture_id: Value) =>
      tables.lecture_chunks.all().filter((c) => c.lecture_id === lecture_id),
  },
  chunkGet: { get: (id: Value) => tables.lecture_chunks.get(id) },
  chunkUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.lecture_chunks.updateWhere((r) => r.id === id, patch)),
  },
  chunkDeleteFor: {
    run: (lecture_id: Value) =>
      run(() => tables.lecture_chunks.deleteWhere((c) => c.lecture_id === lecture_id)),
  },
  // Bypass profiles
  bpAll: { all: () => tables.bypass_profiles.all() },
  bpInsert: {
    run: (
      name: Value,
      batch_file_path: Value,
      custom_args: Value,
      is_active: Value,
      is_service: Value,
    ) =>
      run(() =>
        tables.bypass_profiles.insert([
          name,
          batch_file_path || "",
          custom_args || "",
          is_active ? 1 : 0,
          is_service ? 1 : 0,
          now(),
        ]),
      ),
  },
  bpGet: { get: (id: Value) => tables.bypass_profiles.get(id) },
  bpUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.bypass_profiles.updateWhere((r) => r.id === id, patch)),
  },
  bpDelete: { run: (id: Value) => run(() => tables.bypass_profiles.delete(id)) },
  bpClearActive: {
    run: () => run(() => tables.bypass_profiles.updateWhere(() => true, { is_active: 0 })),
  },

  // Bypass custom domains
  bcdAll: { all: () => tables.bypass_custom_domains.all() },
  bcdInsert: {
    run: (domain: Value, type: Value, is_enabled: Value) =>
      run(() => {
        if (!tables.bypass_custom_domains.rows.find((r) => r.domain === domain && r.type === type))
          tables.bypass_custom_domains.insert([domain, type, is_enabled ? 1 : 0]);
      }),
  },
  bcdUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.bypass_custom_domains.updateWhere((r) => r.id === id, patch)),
  },
  bcdDelete: { run: (id: Value) => run(() => tables.bypass_custom_domains.delete(id)) },
  // Bypass check results (огоньки конфигов: живут до следующей полной проверки)
  bcrAll: { all: () => tables.bypass_check_results.all() },
  bcrUpsert: {
    run: (strategy_id: Value, row: Value) =>
      run(() => {
        const patch: Patch = {
          file: row.file || "",
          ok: row.ok ? 1 : 0,
          ok_count: Number(row.ok_count) || 0,
          error: Number(row.error) || 0,
          unsup: Number(row.unsup) || 0,
          ping_ok: Number(row.ping_ok) || 0,
          ping_fail: Number(row.ping_fail) || 0,
          checked_at: row.checked_at || now(),
          run_started_at: row.run_started_at || now(),
        };
        const existing = tables.bypass_check_results.rows.find(
          (r) => r.strategy_id === strategy_id,
        );
        if (existing) {
          return tables.bypass_check_results.updateWhere((r) => r.id === existing.id, patch);
        }
        return tables.bypass_check_results.insert([
          strategy_id,
          patch.file,
          patch.ok,
          patch.ok_count,
          patch.error,
          patch.unsup,
          patch.ping_ok,
          patch.ping_fail,
          patch.checked_at,
          patch.run_started_at,
        ]);
      }),
  },
  bcrClear: { run: () => run(() => tables.bypass_check_results.deleteWhere(() => true)) },
  bcrSetOk: {
    run: (ok: Value, id: Value) =>
      run(() => tables.bypass_check_results.updateWhere((r) => r.id === id, { ok: ok ? 1 : 0 })),
  },
  // ---- Встроенный прокси: подписки ----
  psubAll: { all: () => tables.proxy_subscriptions.all() },
  psubGet: { get: (id: Value) => tables.proxy_subscriptions.get(id) },
  psubInsert: {
    run: (name: Value, url: Value, auto_update_enabled: Value) =>
      run(() =>
        tables.proxy_subscriptions.insert([
          name || "",
          url || "",
          now(),
          auto_update_enabled ? 1 : 0,
        ]),
      ),
  },
  psubUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.proxy_subscriptions.updateWhere((r) => r.id === id, patch)),
  },
  psubTouch: {
    run: (id: Value) =>
      run(() =>
        tables.proxy_subscriptions.updateWhere((r) => r.id === id, { last_updated: now() }),
      ),
  },
  psubDelete: {
    run: (id: Value) =>
      run(() => {
        tables.proxy_subscriptions.delete(id);
        tables.proxy_nodes.deleteWhere((n) => n.sub_id === id);
      }),
  },

  // ---- Встроенный прокси: узлы ----
  pnodeAll: { all: () => tables.proxy_nodes.all() },
  pnodeGet: { get: (id: Value) => tables.proxy_nodes.get(id) },
  pnodeForSub: {
    all: (sub_id: Value) => tables.proxy_nodes.all().filter((n) => n.sub_id === sub_id),
  },
  pnodeInsert: {
    run: (sub_id: Value, name: Value, protocol: Value, config_json: Value) =>
      run(() =>
        tables.proxy_nodes.insert([
          sub_id,
          name || "",
          protocol || "",
          config_json || "",
          null,
          "",
          0,
          0,
        ]),
      ),
  },
  pnodeUpdate: {
    run: (id: Value, patch: Value) =>
      run(() => tables.proxy_nodes.updateWhere((r) => r.id === id, patch)),
  },
  pnodeDelete: { run: (id: Value) => run(() => tables.proxy_nodes.delete(id)) },
  pnodeDeleteForSub: {
    run: (sub_id: Value) => run(() => tables.proxy_nodes.deleteWhere((n) => n.sub_id === sub_id)),
  },
  pnodeClearSelected: {
    run: () => run(() => tables.proxy_nodes.updateWhere(() => true, { is_selected: 0 })),
  },
  pnodeGetSelected: { get: () => tables.proxy_nodes.all().find((n) => n.is_selected) || null },
  // «Удаление» узла = скрытие (иначе обновление подписки вернёт узел обратно)
  // и снятие выбора, чтобы ядро не осталось на скрытом узле.
  pnodeExclude: {
    run: (id: Value) =>
      run(() =>
        tables.proxy_nodes.updateWhere((r) => r.id === id, { is_excluded: 1, is_selected: 0 }),
      ),
  },
  pnodeRestore: {
    run: (id: Value) =>
      run(() => tables.proxy_nodes.updateWhere((r) => r.id === id, { is_excluded: 0 })),
  },
  pnodeExcludedForSub: {
    all: (sub_id: Value) =>
      tables.proxy_nodes.all().filter((n) => n.sub_id === sub_id && !!n.is_excluded),
  },
  // ---- Встроенный прокси: правила страниц (page → proxied/direct) ----
  pprAll: { all: () => tables.proxy_page_rules.all() },
  pprGet: { get: (id: Value) => tables.proxy_page_rules.get(id) },
  pprSet: {
    run: (route_path: Value, is_proxied: Value) =>
      run(() => {
        const existing = tables.proxy_page_rules.rows.find((r) => r.route_path === route_path);
        const flag = is_proxied ? 1 : 0;
        if (existing)
          return tables.proxy_page_rules.updateWhere((r) => r.route_path === route_path, {
            is_proxied: flag,
          });
        return tables.proxy_page_rules.insert([route_path, flag]);
      }),
  },
  pprDelete: { run: (id: Value) => run(() => tables.proxy_page_rules.delete(id)) },
  pprDeleteByPath: {
    run: (route_path: Value) =>
      run(() => tables.proxy_page_rules.deleteWhere((r) => r.route_path === route_path)),
  },
  /** null — правила нет (по умолчанию страница проксируется). */
  pprIsProxied: {
    get: (route_path: Value) => {
      const r = tables.proxy_page_rules.rows.find((x) => x.route_path === route_path);
      return r ? !!r.is_proxied : null;
    },
  },
  // ---- Фильмы и сериалы: список просмотра ----
  // Ключ строки — пара (kind, tmdb_id): один тайтл = одна запись.
  mwAll: { all: () => tables.media_watchlist.all() },
  mwGet: {
    get: (kind: Value, tmdb_id: Value) =>
      tables.media_watchlist.rows.find((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id)) ||
      null,
  },
  /** Добавить/обновить запись списка (upsert по kind+tmdb_id). */
  mwUpsert: {
    run: (kind: Value, tmdb_id: Value, patch: Value) =>
      run(() => {
        const id = Number(tmdb_id);
        const existing = tables.media_watchlist.rows.find(
          (r) => r.kind === kind && r.tmdb_id === id,
        );
        if (existing)
          return tables.media_watchlist.updateWhere((r) => r.id === existing.id, {
            ...patch,
            updated_at: now(),
          });
        return tables.media_watchlist.insert([
          kind,
          id,
          patch.title || "",
          patch.poster || "",
          patch.year || null,
          patch.status || "plan",
          patch.runtime || null,
          patch.genres || "[]",
          now(),
          now(),
          patch.watched_season || 0,
          patch.watched_episode || 0,
        ]);
      }),
  },
  mwDelete: {
    run: (kind: Value, tmdb_id: Value) =>
      run(() =>
        tables.media_watchlist.deleteWhere((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id)),
      ),
  },
  // ---- Фильмы и сериалы: личные оценки 1–10 ----
  mrAll: { all: () => tables.media_ratings.all() },
  mrGet: {
    get: (kind: Value, tmdb_id: Value) =>
      tables.media_ratings.rows.find((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id)) ||
      null,
  },
  mrSet: {
    run: (kind: Value, tmdb_id: Value, title: Value, rating: Value) =>
      run(() => {
        const id = Number(tmdb_id);
        const existing = tables.media_ratings.rows.find((r) => r.kind === kind && r.tmdb_id === id);
        if (existing)
          return tables.media_ratings.updateWhere((r) => r.id === existing.id, {
            rating,
            title: title || existing.title,
            updated_at: now(),
          });
        return tables.media_ratings.insert([kind, id, title || "", rating, now()]);
      }),
  },
  mrDelete: {
    run: (kind: Value, tmdb_id: Value) =>
      run(() =>
        tables.media_ratings.deleteWhere((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id)),
      ),
  },
  // ---- Фильмы и сериалы: свои закладки (папки) ----
  mbListAll: { all: () => tables.media_bookmark_lists.all() },
  mbListCreate: {
    run: (name: Value) => run(() => tables.media_bookmark_lists.insert([name, now()])),
  },
  mbListRename: {
    run: (id: Value, name: Value) =>
      run(() => tables.media_bookmark_lists.updateWhere((r) => r.id === Number(id), { name })),
  },
  mbListDelete: {
    run: (id: Value) =>
      run(() => {
        tables.media_bookmark_lists.delete(Number(id));
        tables.media_bookmark_items.deleteWhere((r) => r.list_id === Number(id));
      }),
  },
  /** Все элементы всех папок сразу — страница сама группирует по list_id
   *  (папок обычно немного, отдельный запрос на каждую не нужен). */
  mbItemAll: { all: () => tables.media_bookmark_items.all() },
  mbItemAllFor: {
    all: (list_id: Value) =>
      tables.media_bookmark_items.rows.filter((r) => r.list_id === Number(list_id)),
  },
  mbItemHas: {
    get: (list_id: Value, kind: Value, tmdb_id: Value) =>
      tables.media_bookmark_items.rows.find(
        (r) => r.list_id === Number(list_id) && r.kind === kind && r.tmdb_id === Number(tmdb_id),
      ) || null,
  },
  mbItemAdd: {
    run: (list_id: Value, kind: Value, tmdb_id: Value, patch: Value) =>
      run(() => {
        const lid = Number(list_id);
        const tid = Number(tmdb_id);
        const existing = tables.media_bookmark_items.rows.find(
          (r) => r.list_id === lid && r.kind === kind && r.tmdb_id === tid,
        );
        if (existing) return { changes: 0 };
        return tables.media_bookmark_items.insert([
          lid,
          kind,
          tid,
          patch.title || "",
          patch.poster || "",
          patch.year || null,
          now(),
        ]);
      }),
  },
  mbItemRemove: {
    run: (list_id: Value, kind: Value, tmdb_id: Value) =>
      run(() =>
        tables.media_bookmark_items.deleteWhere(
          (r) => r.list_id === Number(list_id) && r.kind === kind && r.tmdb_id === Number(tmdb_id),
        ),
      ),
  },
  /** В каких папках лежит тайтл (для модалки — список id папок с галочками). */
  mbListsFor: {
    all: (kind: Value, tmdb_id: Value) =>
      tables.media_bookmark_items.rows
        .filter((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id))
        .map((r) => r.list_id),
  },
  // ---- Фильмы и сериалы: статистика просмотров ----
  msAll: { all: () => tables.media_watch_stats.all() },
  msGet: {
    get: (kind: Value, tmdb_id: Value) =>
      tables.media_watch_stats.rows.find((r) => r.kind === kind && r.tmdb_id === Number(tmdb_id)) ||
      null,
  },
  /** Отметить просмотр/прогресс: одна запись на тайтл (перезаписывается). */
  msUpsert: {
    run: (kind: Value, tmdb_id: Value, patch: Value) =>
      run(() => {
        const id = Number(tmdb_id);
        const existing = tables.media_watch_stats.rows.find(
          (r) => r.kind === kind && r.tmdb_id === id,
        );
        const row: Value[] = [
          kind,
          id,
          patch.title || "",
          patch.genres || "[]",
          patch.cast || "[]",
          patch.runtime || null,
          patch.progress != null ? patch.progress : 1,
          patch.minutes != null ? patch.minutes : patch.runtime || 0,
          now(),
        ];
        if (existing) {
          const cols = tables.media_watch_stats.cols;
          return tables.media_watch_stats.updateWhere((r) => r.id === existing.id, {
            [cols[2]]: row[2],
            [cols[3]]: row[3],
            [cols[4]]: row[4],
            [cols[5]]: row[5],
            [cols[6]]: row[6],
            [cols[7]]: row[7],
            [cols[8]]: row[8],
          });
        }
        return tables.media_watch_stats.insert(row);
      }),
  },
  msDelete: {
    run: (kind: Value, tmdb_id: Value) =>
      run(() =>
        tables.media_watch_stats.deleteWhere(
          (r) => r.kind === kind && r.tmdb_id === Number(tmdb_id),
        ),
      ),
  },
  msClear: { run: () => run(() => tables.media_watch_stats.deleteWhere(() => true)) },

  // ---- Фильмы и сериалы: кэш метаданных TMDB ----
  mmcGet: {
    get: (key: Value) => {
      const r = tables.media_meta_cache.rows.find((x) => x.key === key);
      return r ? { json: r.json, cached_at: r.cached_at } : null;
    },
  },
  mmcSet: {
    run: (key: Value, json: Value) =>
      run(() => {
        const existing = tables.media_meta_cache.rows.find((r) => r.key === key);
        const stamp = now();
        if (existing)
          return tables.media_meta_cache.updateWhere((r) => r.id === existing.id, {
            json,
            cached_at: stamp,
          });
        return tables.media_meta_cache.insert([key, json, stamp]);
      }),
  },
  mmcClear: { run: () => run(() => tables.media_meta_cache.deleteWhere(() => true)) },

  // ---- Форум-трекер: кэш результатов поиска ----
  tscGet: {
    get: (key: Value) => {
      const r = tables.tracker_search_cache.rows.find((x) => x.key === key);
      return r ? { json: r.json, cached_at: r.cached_at } : null;
    },
  },
  tscSet: {
    run: (key: Value, json: Value) =>
      run(() => {
        const existing = tables.tracker_search_cache.rows.find((r) => r.key === key);
        const stamp = now();
        if (existing)
          return tables.tracker_search_cache.updateWhere((r) => r.id === existing.id, {
            json,
            cached_at: stamp,
          });
        return tables.tracker_search_cache.insert([key, json, stamp]);
      }),
  },
  tscClear: { run: () => run(() => tables.tracker_search_cache.deleteWhere(() => true)) },

  // ---- Торрент-плеер: реестр загрузок (вкладка «Скачанные») ----
  // Строки читаются по info_hash (он же идентификатор раздачи в webtorrent).
  tdAll: { all: () => tables.torrent_downloads.all() },
  tdGet: {
    get: (infoHash: Value) => {
      const r = tables.torrent_downloads.rows.find((x) => x.info_hash === String(infoHash));
      return r ? { ...r } : null;
    },
  },
  tdUpsert: {
    run: (row: Record<string, Value>) =>
      run(() => {
        const existing = tables.torrent_downloads.rows.find((r) => r.info_hash === row.info_hash);
        const stamp = now();
        if (existing)
          return tables.torrent_downloads.updateWhere((r) => r.id === existing.id, {
            ...row,
            updated_at: stamp,
          });
        // insert пишет колонки позиционно: собираем значения в порядке объявления,
        // подставляя время для added_at/updated_at, если его не передали.
        return tables.torrent_downloads.insert(
          tables.torrent_downloads.cols.map((c) => {
            if (c === "added_at" || c === "updated_at") return row[c] || stamp;
            return row[c];
          }),
        );
      }),
  },
  tdPatch: {
    run: (infoHash: Value, fields: Patch) =>
      run(() =>
        tables.torrent_downloads.updateWhere((r) => r.info_hash === String(infoHash), {
          ...fields,
          updated_at: now(),
        }),
      ),
  },
  tdDelete: {
    run: (infoHash: Value) =>
      run(() => tables.torrent_downloads.deleteWhere((r) => r.info_hash === String(infoHash))),
  },
};
export function exportSnapshot(): {
  tasks: Row[];
  conversations: Row[];
  messages: Row[];
  archivedPages: Row[];
} {
  return {
    tasks: tables.tasks.all(),
    conversations: tables.conversations.all(),
    messages: tables.messages.all(),
    archivedPages: tables.archived_pages.all(),
  };
}

// db.exec/db.prepare оставлены как no-op для совместимости со старым кодом, который
// писал в SQLite-заглушку. Настоящее соединение наружу не отдаётся: работать с
// данными нужно через stmts/tables, иначе in-memory кэш разойдётся с файлом.
export const db = {
  exec: () => {},
  prepare: () => ({ run: () => ({}), all: () => [], get: () => null }),
};

// Форма экспорта — как была: require("./db") отдаёт объект с этими ключами
// (плюс служебные close/backupTo/SCHEMA_VERSION), поэтому .js-потребители и
// тесты работают без правок.
export { tables };
