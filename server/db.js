const fs = require("fs");
const { FILES } = require("./config");
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
  conversations: new Table(["provider", "title", "created_at", "updated_at"], "-updated_at"),
  messages: new Table(["conversation_id", "role", "text", "created_at"], "id"),
  archived_pages: new Table(["name", "size_text", "saved_at"], "-id"),
  books: new Table(["title", "author", "year", "fmt", "tone", "description"], "title"),
  catalog: new Table(["name", "url", "source", "category", "wingetId", "favorite", "added_at"], "-id"),
  favorites: new Table(["key"], "key"),
};

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Запись атомарная: временный файл + rename. На Windows rename иногда отдаёт
// EPERM, если файл занят (антивирус/редактор) — тогда запись идёт прямо в основной.
function persist() {
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

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILES.data, "utf8"));
    for (const k of Object.keys(tables)) {
      if (data[k]) tables[k].loadJSON(data[k]);
      tables[k].seq = Math.max(tables[k].seq, ...tables[k].rows.map((r) => r.id || 0));
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
  taskOrder: { run: (pos, id) => run(() => tables.tasks.updateWhere((r) => r.id === id, { pos })) },

  // Conversations
  convInsert: { run: (provider, title) => run(() => tables.conversations.insert([provider, title, now(), now()])) },
  convAll: { all: () => tables.conversations.all() },
  convGet: { get: (id) => tables.conversations.get(id) },
  convTouch: { run: (id) => run(() => tables.conversations.updateWhere((r) => r.id === id, { updated_at: now() })) },
  convDelete: {
    run: (id) => run(() => {
      tables.conversations.delete(id);
      tables.messages.deleteWhere((m) => m.conversation_id === id);
    }),
  },

  // Messages
  msgInsert: { run: (conversation_id, role, text) => run(() => tables.messages.insert([conversation_id, role, text, now()])) },
  msgFor: {
    all: (conversation_id) => tables.messages.all().filter((m) => m.conversation_id === conversation_id),
  },
  msgRecent: {
    all: (conversation_id, limit) => tables.messages.all().filter((m) => m.conversation_id === conversation_id).slice(-limit),
  },

  // Archives
  archInsert: { run: (name, size_text) => run(() => tables.archived_pages.insert([name, size_text, now()])) },
  archAll: { all: () => tables.archived_pages.all() },

  // Books
  bookAll: { all: () => tables.books.all() },
  bookInsert: {
    run: (title, author, year, fmt, tone, description) => run(() => tables.books.insert([title, author, year, fmt, tone, description])),
  },

  // Catalog (пользовательский каталог загрузок)
  catAll: { all: () => tables.catalog.all() },
  catInsert: { run: (name, url, source, category, wingetId) => run(() => tables.catalog.insert([name, url, source, category || "Other", wingetId || null, 0, now()])) },
  catDelete: { run: (id) => run(() => tables.catalog.delete(id)) },
  catSetFavorite: { run: (id, favorite) => run(() => tables.catalog.updateWhere((r) => r.id === id, { favorite: favorite ? 1 : 0 })) },
  catGet: { get: (id) => tables.catalog.get(id) },

  // Favorites (универсальные ключи: winget:<id> или catalog:<id>)
  favAll: { all: () => tables.favorites.all() },
  favHas: (key) => !!tables.favorites.rows.find((r) => r.key === key),
  favAdd: (key) => run(() => {
    if (!tables.favorites.rows.find((r) => r.key === key)) tables.favorites.insert([key]);
  }),
  favRemove: (key) => run(() => tables.favorites.deleteWhere((r) => r.key === key)),
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

module.exports = { db, stmts, tables, exportSnapshot };