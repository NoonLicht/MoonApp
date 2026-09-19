/**
 * Лёгкий JS-стор вместо полноценной БД — данные живут в JSON.
 * Одинаково работает в Electron, standalone и тестах, т.к. нет нативной сборки
 * (в отличие от node:sqlite / better-sqlite3, которые в Electron капризничают).
 * API держу как в SQL (run/get/all), чтобы роуты не переписывать.
 *
 * TS-исходник, как server/ts/notes-fs.ts: компилируется в server/db.js командой
 * `npm run compile:server`, поэтому `const { stmts } = require("./db")` из роутов,
 * proxyCore.js, lecture.js, zapret.js, tmdb.js и тестов работает без изменений.
 * Форма экспорта та же, что была в .js: db, stmts, tables, exportSnapshot, flush.
 */
import fs from "fs";
import config from "./config";
import logger from "./logger";
import * as notesFs from "./notes-fs";

const { FILES } = config;

/**
 * Значение колонки. В .js-версии валидации не было никакой (значения приходят из
 * JSON и из роутов как есть), поэтому здесь any — сузить до unknown означало бы
 * кастовать в каждом потребителе без всякой пользы.
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

/** Загрузка/сохранение строк: ровно те поля, что попадают в data.json. */
interface TableJSON {
  cols?: string[];
  rows?: Row[];
  seq?: number;
}

/** Результат мутации в стиле SQLite (роуты смотрят только на changes). */
export interface RunResult {
  changes?: number;
  lastInsertRowid?: number;
}

class Table {
  cols: string[];
  orderBy: string | null;
  rows: Row[];
  seq: number;

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
        changes++;
      }
    });
    return { changes };
  }

  delete(id: number): { changes: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return { changes: before - this.rows.length };
  }

  deleteWhere(fn: (row: Row) => boolean): { changes: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !fn(r));
    return { changes: before - this.rows.length };
  }

  toJSON(): { cols: string[]; rows: Row[]; seq: number } {
    return { cols: this.cols, rows: this.rows, seq: this.seq };
  }

  loadJSON(j: TableJSON): void {
    // В .js здесь было `this.cols = j.cols` без проверки: если в data.json нет
    // поля cols, таблица оставалась без колонок и insert() молча терял значения.
    // Фолбэк на текущие колонки ничего не меняет для нормальных файлов (там cols
    // есть всегда) и убирает эту ловушку.
    this.cols = j.cols || this.cols;
    this.rows = j.rows || [];
    this.seq = j.seq || this.rows.length || 0;
  }
}
/**
 * Таблицы стора. Порядок объявления не важен, но важен порядок КОЛОНОК: insert
 * пишет значения позиционно, а старые data.json содержат порезанный список
 * колонок (миграцию досыпает load()).
 */
const tables: Record<string, Table> = {
  tasks: new Table(["text", "done", "priority", "tag", "pos", "created_at"], "pos"),
  conversations: new Table(
    ["provider", "title", "created_at", "updated_at", "pinned"],
    "-updated_at",
  ),
  messages: new Table(["conversation_id", "role", "text", "created_at"], "id"),
  archived_pages: new Table(["name", "size_text", "saved_at"], "-id"), // устарело (М9), оставлено для совместимости старых data.json
  books: new Table(["title", "author", "year", "fmt", "tone", "description"], "title"),
  catalog: new Table(
    ["name", "url", "source", "category", "wingetId", "favorite", "added_at"],
    "-id",
  ),
  favorites: new Table(["key"], "key"),
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
    ],
    "-updated_at",
  ),
  // Личная оценка 1–10 (одна запись на тайтл).
  media_ratings: new Table(["kind", "tmdb_id", "title", "rating", "updated_at"], "-updated_at"),
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

// Снимок объявленных колонок ДО load(): loadJSON перезаписывает cols данными из
// data.json, поэтому колонки, добавленные в код позже (у старых файлов их нет),
// нужно досыпать вручную — иначе insert() молча не запишет их значения.
// Досыпаем В КОНЕЦ, чтобы позиционное соответствие старых колонок не сломалось.
const DECLARED_COLS: Record<string, string[]> = {};
for (const k of Object.keys(tables)) DECLARED_COLS[k] = tables[k].cols.slice();
function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Запись атомарная: временный файл + rename. На Windows rename иногда отдаёт
// EPERM, если файл занят (антивирус/редактор) — тогда запись идёт прямо в основной.
// М8: persist дебаунсится на 300 мс — при серии мутаций (стриминг чата)
// диск дёргается один раз. flush() вызывается на exit, чтобы ничего не терялось.
let persistTimer: NodeJS.Timeout | null = null;
function persistNow(): void {
  const payload: Record<string, { cols: string[]; rows: Row[]; seq: number }> = {};
  for (const k of Object.keys(tables)) payload[k] = tables[k].toJSON();
  const json = JSON.stringify(payload);
  try {
    fs.writeFileSync(FILES.data + ".tmp", json, "utf8");
    fs.renameSync(FILES.data + ".tmp", FILES.data);
  } catch (e) {
    try {
      fs.writeFileSync(FILES.data, json, "utf8");
      logger.warn("persist.rename_fallback", { error: (e as Error).message });
    } catch (e2) {
      logger.error("persist.error", { error: (e2 as Error).message });
    }
  }
}

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

process.on("exit", () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistNow();
  }
});
function load(): void {
  try {
    const data = JSON.parse(fs.readFileSync(FILES.data, "utf8"));
    for (const k of Object.keys(tables)) {
      if (data[k]) tables[k].loadJSON(data[k]);
      // Миграция схемы: возвращаем колонки, которых не было в файле.
      for (const c of DECLARED_COLS[k]) {
        if (!tables[k].cols.includes(c)) tables[k].cols.push(c);
      }
      tables[k].seq = Math.max(tables[k].seq, ...tables[k].rows.map((r) => r.id || 0));
    }
    // Миграция: заметки из data.json -> .md файлы (только если в storage/notes/ пусто)
    if (data.notes && Array.isArray(data.notes.rows) && data.notes.rows.length > 0) {
      const notesDir = notesFs.NOTES_DIR;
      if (fs.existsSync(notesDir)) {
        const existing = fs.readdirSync(notesDir).filter((f) => f.endsWith(".md"));
        if (existing.length === 0) {
          logger.info("notes-fs.migrate.start", { count: data.notes.rows.length });
          for (const note of data.notes.rows) {
            notesFs.insert(note.title, note.content, note.tags || "", note.folder || "");
          }
          logger.info("notes-fs.migrate.done", { count: data.notes.rows.length });
        }
      } else {
        for (const note of data.notes.rows) {
          notesFs.insert(note.title, note.content, note.tags || "", note.folder || "");
        }
      }
    }
  } catch {
    /* первый запуск — файла ещё нет */
  }
}
load();

/** Мутация + сохранение на диск. */
function run<T>(mutator: () => T): T {
  const out = mutator();
  persist();
  return out;
}
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
    run: (conversation_id: Value, role: Value, text: Value) =>
      run(() => tables.messages.insert([conversation_id, role, text, now()])),
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
          Object.assign(existing, patch);
          return { changes: 1 };
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
        const existing = tables.torrent_downloads.rows.find(
          (r) => r.info_hash === row.info_hash,
        );
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

// db.exec/db.prepare оставлены как no-op для совместимости.
export const db = {
  exec: () => {},
  prepare: () => ({ run: () => ({}), all: () => [], get: () => null }),
};

// Форма экспорта — как в .js-версии: require("./db") отдаёт объект с теми же
// ключами (stmts/tables/db/exportSnapshot/flush), поэтому .js-потребители и
// тесты работают без правок.
export { tables };
