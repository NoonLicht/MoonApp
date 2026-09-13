const fs = require("fs");
const { FILES } = require("./config");
const notesFs = require("./notes-fs");
const logger = require("./logger");

// Лёгкий JS-стор вместо полноценной БД — данные живут в JSON.
// Одинаково работает в Electron, standalone и тестах, т.к. нет нативной сборки
// (в отличие от node:sqlite / better-sqlite3, которые в Electron капризничают).
// API держу как в SQL (run/get/all), чтобы роуты не переписывать.

class Table {
  constructor(cols, orderBy) {
    this.cols = cols;
    this.orderBy = orderBy; // "pos" или "-updated_at" (это DESC)
    this.rows = [];
    this.seq = 0;
  }
  insert(values) {
    const id = ++this.seq;
    const row = { id };
    this.cols.forEach((c, i) => { row[c] = values[i]; });
    this.rows.push(row);
    return { lastInsertRowid: id };
  }
  all() {
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
  get(id) {
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : undefined;
  }
  updateWhere(fn, patch) {
    let changes = 0;
    this.rows.forEach((r) => { if (fn(r)) { Object.assign(r, patch); changes++; } });
    return { changes };
  }
  delete(id) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return { changes: before - this.rows.length };
  }
  deleteWhere(fn) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !fn(r));
    return { changes: before - this.rows.length };
  }
  toJSON() { return { cols: this.cols, rows: this.rows, seq: this.seq }; }
  loadJSON(j) {
    this.cols = j.cols;
    this.rows = j.rows || [];
    this.seq = j.seq || this.rows.length || 0;
  }
}

const tables = {
  tasks: new Table(["text", "done", "priority", "tag", "pos", "created_at"], "pos"),
  conversations: new Table(["provider", "title", "created_at", "updated_at", "pinned"], "-updated_at"),
  messages: new Table(["conversation_id", "role", "text", "created_at"], "id"),
  archived_pages: new Table(["name", "size_text", "saved_at"], "-id"), // устарело (М9), оставлено для совместимости старых data.json
  books: new Table(["title", "author", "year", "fmt", "tone", "description"], "title"),
  catalog: new Table(["name", "url", "source", "category", "wingetId", "favorite", "added_at"], "-id"),
  favorites: new Table(["key"], "key"),
  // Lecture Recorder: сессии лекций и чанки расшифровки.
  lectures: new Table(["title", "started_at", "ended_at", "duration_ms", "sample_rate", "channels", "raw_file", "status", "notes"], "-id"),
  lecture_chunks: new Table(["lecture_id", "idx", "start_ms", "end_ms", "text", "status", "error", "file", "created_at"], "id"),
  // Zapret / DPI bypass: профили запуска и пользовательские домены.
  bypass_profiles: new Table(["name", "batch_file_path", "custom_args", "is_active", "is_service", "created_at"], "-id"),
  bypass_custom_domains: new Table(["domain", "type", "is_enabled"], "domain"),
  // Результаты последней полной проверки конфигов (огоньки на странице Bypass).
  bypass_check_results: new Table(
    ["strategy_id", "file", "ok", "ok_count", "error", "unsup", "ping_ok", "ping_fail", "checked_at", "run_started_at"],
    "strategy_id"
  ),
  // Встроенный прокси (sing-box): подписки, узлы и правила «страница → прокси».
  // config_json хранит нормализованный узел (см. server/proxyCore.js parseUri).
  // is_excluded: узел, который пользователь убрал из списка вручную. Храним его
  // как «скрытый», а не удаляем: иначе авто-обновление подписки вернёт его назад.
  proxy_subscriptions: new Table(["name", "url", "last_updated", "auto_update_enabled"], "-id"),
  proxy_nodes: new Table(["sub_id", "name", "protocol", "config_json", "ping_ms", "country_code", "is_selected", "is_excluded"], "-id"),
  // Прокси-правило страницы: route_path = id страницы приложения ('video', 'music'…),
  // is_proxied: 1 — трафик страницы идёт через прокси, 0 — напрямую (bypass).
  proxy_page_rules: new Table(["route_path", "is_proxied"], "route_path"),
};

// Снимок объявленных колонок ДО load(): loadJSON перезаписывает cols данными из
// data.json, поэтому колонки, добавленные в код позже (у старых файлов их нет),
// нужно досыпать вручную — иначе insert() молча не запишет их значения.
// Досыпаем В КОНЕЦ, чтобы позиционное соответствие старых колонок не сломалось.
const DECLARED_COLS = {};
for (const k of Object.keys(tables)) DECLARED_COLS[k] = tables[k].cols.slice();

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Запись атомарная: временный файл + rename. На Windows rename иногда отдаёт
// EPERM, если файл занят (антивирус/редактор) — тогда запись идёт прямо в основной.
// М8: persist дебаунсится на 300 мс — при серии мутаций (стриминг чата)
// диск дёргается один раз. flush() вызывается на exit, чтобы ничего не терялось.
let persistTimer = null;
function persistNow() {
  const payload = {};
  for (const k of Object.keys(tables)) payload[k] = tables[k].toJSON();
  const json = JSON.stringify(payload);
  try {
    fs.writeFileSync(FILES.data + ".tmp", json, "utf8");
    fs.renameSync(FILES.data + ".tmp", FILES.data);
  } catch (e) {
    try {
      fs.writeFileSync(FILES.data, json, "utf8");
      logger.warn("persist.rename_fallback", { error: e.message });
    } catch (e2) {
      logger.error("persist.error", { error: e2.message });
    }
  }
}
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 300);
  if (persistTimer.unref) persistTimer.unref();
}
// Немедленный сброс отложенной записи (используется бэкапом и exit-хуком).
function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistNow();
}
process.on("exit", () => { if (persistTimer) { clearTimeout(persistTimer); persistNow(); } });

function load() {
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
        const existing = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
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
  } catch { /* первый запуск — файла ещё нет */ }
}
load();

/** Мутация + сохранение на диск. */
function run(mutator) {
  const out = mutator();
  persist();
  return out;
}

// ---- stmts: единая точка доступа (API как у SQL-версии) ----
const stmts = {
  // Tasks
  taskInsert: {
    run: (text, done, priority, tag) => run(() => {
      const maxPos = tables.tasks.rows.reduce((m, r) => Math.max(m, r.pos || 0), 0);
      return tables.tasks.insert([text, done, priority, tag, maxPos + 1, now()]);
    }),
  },
  taskAll: { all: () => tables.tasks.all() },
  taskToggle: { run: (done, id) => run(() => tables.tasks.updateWhere((r) => r.id === id, { done })) },
  taskDelete: { run: (id) => run(() => tables.tasks.delete(id)) },
  taskUpdate: { run: (value, field, id) => run(() => tables.tasks.updateWhere((r) => r.id === id, { [field]: value })) },
  taskOrder: { run: (pos, id) => run(() => tables.tasks.updateWhere((r) => r.id === id, { pos })) },

  // Conversations
  convInsert: { run: (provider, title) => run(() => tables.conversations.insert([provider, title, now(), now(), 0])) },
  convAll: { all: () => tables.conversations.all() },
  convGet: { get: (id) => tables.conversations.get(id) },
  convTouch: { run: (id) => run(() => tables.conversations.updateWhere((r) => r.id === id, { updated_at: now() })) },
  convDelete: {
    run: (id) => run(() => {
      tables.conversations.delete(id);
      tables.messages.deleteWhere((m) => m.conversation_id === id);
    }),
  },
  convUpdate: { run: (id, patch) => run(() => tables.conversations.updateWhere((r) => r.id === id, { ...patch, updated_at: now() })) },

  // Messages
  msgInsert: { run: (conversation_id, role, text) => run(() => tables.messages.insert([conversation_id, role, text, now()])) },
  msgFor: { all: (conversation_id) => tables.messages.all().filter((m) => m.conversation_id === conversation_id) },
  msgRecent: { all: (conversation_id, limit) => tables.messages.all().filter((m) => m.conversation_id === conversation_id).slice(-limit) },
  // Усечь историю начиная с message id (для «Регенерировать» / «Редактировать»)
  msgTruncateFrom: { run: (conversation_id, fromId) => run(() => tables.messages.deleteWhere((m) => m.conversation_id === conversation_id && m.id >= fromId)) },

  // Archives
  archInsert: { run: (name, size_text) => run(() => tables.archived_pages.insert([name, size_text, now()])) },
  archAll: { all: () => tables.archived_pages.all() },

  // Notes — файловое хранение (каждая заметка = .md файл в storage/notes/)
  noteAll: { all: () => notesFs.all() },
  noteGet: { get: (id) => notesFs.get(id) },
  noteInsert: { run: (title, content, tags, folder) => notesFs.insert(title, content, tags, folder) },
  noteUpdate: { run: (title, content, tags, folder, id) => notesFs.update(title, content, tags, folder, id) },
  noteDelete: { run: (id) => notesFs.delete(id) },
  noteDeleteAll: { run: () => notesFs.deleteAll() },
  noteSearch: { all: (q) => notesFs.search(q) },

  // Books
  bookAll: { all: () => tables.books.all() },
  bookInsert: { run: (title, author, year, fmt, tone, description) => run(() => tables.books.insert([title, author, year, fmt, tone, description])) },

  // Catalog
  catAll: { all: () => tables.catalog.all() },
  catInsert: { run: (name, url, source, category, wingetId) => run(() => tables.catalog.insert([name, url, source, category || "Other", wingetId || null, 0, now()])) },
  catDelete: { run: (id) => run(() => tables.catalog.delete(id)) },
  catSetFavorite: { run: (id, favorite) => run(() => tables.catalog.updateWhere((r) => r.id === id, { favorite: favorite ? 1 : 0 })) },
  catGet: { get: (id) => tables.catalog.get(id) },

  // Favorites
  favAll: { all: () => tables.favorites.all() },
  favHas: (key) => !!tables.favorites.rows.find((r) => r.key === key),
  favAdd: (key) => run(() => { if (!tables.favorites.rows.find((r) => r.key === key)) tables.favorites.insert([key]); }),
  favRemove: (key) => run(() => tables.favorites.deleteWhere((r) => r.key === key)),

  // Lectures
  lectureInsert: { run: (title, sample_rate, channels) => run(() => tables.lectures.insert([title, now(), null, 0, sample_rate, channels, "", "recording", ""])) },
  lectureAll: { all: () => tables.lectures.all() },
  lectureGet: { get: (id) => tables.lectures.get(id) },
  lectureUpdate: { run: (id, patch) => run(() => tables.lectures.updateWhere((r) => r.id === id, patch)) },
  lectureDelete: { run: (id) => run(() => { tables.lectures.delete(id); tables.lecture_chunks.deleteWhere((c) => c.lecture_id === id); }) },

  // Lecture chunks
  chunkInsert: { run: (lecture_id, idx, start_ms, end_ms, file) => run(() => tables.lecture_chunks.insert([lecture_id, idx, start_ms, end_ms, "", "pending", "", file, now()])) },
  chunkFor: { all: (lecture_id) => tables.lecture_chunks.all().filter((c) => c.lecture_id === lecture_id) },
  chunkGet: { get: (id) => tables.lecture_chunks.get(id) },
  chunkUpdate: { run: (id, patch) => run(() => tables.lecture_chunks.updateWhere((r) => r.id === id, patch)) },
  chunkDeleteFor: { run: (lecture_id) => run(() => tables.lecture_chunks.deleteWhere((c) => c.lecture_id === lecture_id)) },

  // Bypass profiles
  bpAll: { all: () => tables.bypass_profiles.all() },
  bpInsert: { run: (name, batch_file_path, custom_args, is_active, is_service) => run(() => tables.bypass_profiles.insert([name, batch_file_path || "", custom_args || "", is_active ? 1 : 0, is_service ? 1 : 0, now()])) },
  bpGet: { get: (id) => tables.bypass_profiles.get(id) },
  bpUpdate: { run: (id, patch) => run(() => tables.bypass_profiles.updateWhere((r) => r.id === id, patch)) },
  bpDelete: { run: (id) => run(() => tables.bypass_profiles.delete(id)) },
  bpClearActive: { run: () => run(() => tables.bypass_profiles.updateWhere(() => true, { is_active: 0 })) },

  // Bypass custom domains
  bcdAll: { all: () => tables.bypass_custom_domains.all() },
  bcdInsert: { run: (domain, type, is_enabled) => run(() => { if (!tables.bypass_custom_domains.rows.find((r) => r.domain === domain && r.type === type)) tables.bypass_custom_domains.insert([domain, type, is_enabled ? 1 : 0]); }) },
  bcdUpdate: { run: (id, patch) => run(() => tables.bypass_custom_domains.updateWhere((r) => r.id === id, patch)) },
  bcdDelete: { run: (id) => run(() => tables.bypass_custom_domains.delete(id)) },

  // Bypass check results (огоньки конфигов: живут до следующей полной проверки)
  bcrAll: { all: () => tables.bypass_check_results.all() },
  bcrUpsert: {
    run: (strategy_id, row) => run(() => {
      const patch = {
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
      const existing = tables.bypass_check_results.rows.find((r) => r.strategy_id === strategy_id);
      if (existing) { Object.assign(existing, patch); return { changes: 1 }; }
      return tables.bypass_check_results.insert([
        strategy_id, patch.file, patch.ok, patch.ok_count, patch.error,
        patch.unsup, patch.ping_ok, patch.ping_fail, patch.checked_at, patch.run_started_at,
      ]);
    }),
  },
  bcrClear: { run: () => run(() => tables.bypass_check_results.deleteWhere(() => true)) },
  bcrSetOk: { run: (ok, id) => run(() => tables.bypass_check_results.updateWhere((r) => r.id === id, { ok: ok ? 1 : 0 })) },

  // ---- Встроенный прокси: подписки ----
  psubAll: { all: () => tables.proxy_subscriptions.all() },
  psubGet: { get: (id) => tables.proxy_subscriptions.get(id) },
  psubInsert: { run: (name, url, auto_update_enabled) => run(() => tables.proxy_subscriptions.insert([name || "", url || "", now(), auto_update_enabled ? 1 : 0])) },
  psubUpdate: { run: (id, patch) => run(() => tables.proxy_subscriptions.updateWhere((r) => r.id === id, patch)) },
  psubTouch: { run: (id) => run(() => tables.proxy_subscriptions.updateWhere((r) => r.id === id, { last_updated: now() })) },
  psubDelete: {
    run: (id) => run(() => {
      tables.proxy_subscriptions.delete(id);
      tables.proxy_nodes.deleteWhere((n) => n.sub_id === id);
    }),
  },

  // ---- Встроенный прокси: узлы ----
  pnodeAll: { all: () => tables.proxy_nodes.all() },
  pnodeGet: { get: (id) => tables.proxy_nodes.get(id) },
  pnodeForSub: { all: (sub_id) => tables.proxy_nodes.all().filter((n) => n.sub_id === sub_id) },
  pnodeInsert: { run: (sub_id, name, protocol, config_json) => run(() => tables.proxy_nodes.insert([sub_id, name || "", protocol || "", config_json || "", null, "", 0, 0])) },
  pnodeUpdate: { run: (id, patch) => run(() => tables.proxy_nodes.updateWhere((r) => r.id === id, patch)) },
  pnodeDelete: { run: (id) => run(() => tables.proxy_nodes.delete(id)) },
  pnodeDeleteForSub: { run: (sub_id) => run(() => tables.proxy_nodes.deleteWhere((n) => n.sub_id === sub_id)) },
  pnodeClearSelected: { run: () => run(() => tables.proxy_nodes.updateWhere(() => true, { is_selected: 0 })) },
  pnodeGetSelected: { get: () => tables.proxy_nodes.all().find((n) => n.is_selected) || null },
  // «Удаление» узла = скрытие (иначе обновление подписки вернёт узел обратно)
  // и снятие выбора, чтобы ядро не осталось на скрытом узле.
  pnodeExclude: { run: (id) => run(() => tables.proxy_nodes.updateWhere((r) => r.id === id, { is_excluded: 1, is_selected: 0 })) },
  pnodeRestore: { run: (id) => run(() => tables.proxy_nodes.updateWhere((r) => r.id === id, { is_excluded: 0 })) },
  pnodeExcludedForSub: { all: (sub_id) => tables.proxy_nodes.all().filter((n) => n.sub_id === sub_id && !!n.is_excluded) },

  // ---- Встроенный прокси: правила страниц (page → proxied/direct) ----
  pprAll: { all: () => tables.proxy_page_rules.all() },
  pprGet: { get: (id) => tables.proxy_page_rules.get(id) },
  pprSet: {
    run: (route_path, is_proxied) => run(() => {
      const existing = tables.proxy_page_rules.rows.find((r) => r.route_path === route_path);
      const flag = is_proxied ? 1 : 0;
      if (existing) return tables.proxy_page_rules.updateWhere((r) => r.route_path === route_path, { is_proxied: flag });
      return tables.proxy_page_rules.insert([route_path, flag]);
    }),
  },
  pprDelete: { run: (id) => run(() => tables.proxy_page_rules.delete(id)) },
  pprDeleteByPath: { run: (route_path) => run(() => tables.proxy_page_rules.deleteWhere((r) => r.route_path === route_path)) },
  /** null — правила нет (по умолчанию страница проксируется). */
  pprIsProxied: { get: (route_path) => { const r = tables.proxy_page_rules.rows.find((x) => x.route_path === route_path); return r ? !!r.is_proxied : null; } },
};

function exportSnapshot() {
  return {
    tasks: tables.tasks.all(),
    conversations: tables.conversations.all(),
    messages: tables.messages.all(),
    archivedPages: tables.archived_pages.all(),
  };
}

// db.exec/db.prepare оставлены как no-op для совместимости.
const db = {
  exec: () => {},
  prepare: () => ({ run: () => ({}), all: () => [], get: () => null }),
};

module.exports = { db, stmts, tables, exportSnapshot, flush };