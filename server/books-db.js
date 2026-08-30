"use strict";

const path = require("path");
const fs = require("fs");
const { DIRS } = require("./config");

const DB_PATH = path.join(DIRS.storage, "books_catalog.db");

let _sqlReady = null;
let SQL = null;
let _db = null;
let _timer = null;
let _lastAccess = 0;
let _refCount = 0;
const TTL_MS = 15 * 60 * 1000;

async function _ensureSql() {
  if (!_sqlReady) {
    _sqlReady = (async () => {
      const initSqlJs = require("sql.js");
      const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
      SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    })().catch(e => { _sqlReady = null; throw e; });
  }
  return _sqlReady;
}
function _initSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    bid INTEGER UNIQUE,
    title TEXT,
    title_lower TEXT,
    author TEXT,
    author_lower TEXT,
    language TEXT,
    year INTEGER,
    formats TEXT,
    sizeText TEXT,
    cover TEXT,
    description TEXT,
    updatedAt TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS book_genres (
    book_id TEXT NOT NULL,
    genre TEXT NOT NULL,
    PRIMARY KEY (book_id, genre)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_bg_genre   ON book_genres(genre)");
  db.run("CREATE INDEX IF NOT EXISTS idx_bg_book_id ON book_genres(book_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_books_title_lower ON books(title_lower)");
  db.run("CREATE INDEX IF NOT EXISTS idx_books_author_lower ON books(author_lower)");
  db.run("CREATE INDEX IF NOT EXISTS idx_books_language ON books(language)");
  db.run("CREATE INDEX IF NOT EXISTS idx_books_year     ON books(year)");
  db.run("CREATE INDEX IF NOT EXISTS idx_books_bid      ON books(bid)");
}

function _persist() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH + ".tmp", Buffer.from(data));
    fs.renameSync(DB_PATH + ".tmp", DB_PATH);
  } catch (e) {
    try { fs.writeFileSync(DB_PATH, Buffer.from(_db.export())); } catch { }
  }
}

function _scheduleUnload() {
  if (_timer) clearTimeout(_timer);
  if (_refCount > 0) return;
  _timer = setTimeout(() => {
    _timer = null;
    if (_refCount > 0) return;
    const idle = Date.now() - _lastAccess;
    if (idle >= TTL_MS && _db) {
      _persist();
      _db.close();
      _db = null;
    } else if (_db) {
      _scheduleUnload();
    }
  }, TTL_MS);
}

function _migrateFromJson() {
  const oldPath = path.join(DIRS.storage, "books_catalog.json");
  if (!fs.existsSync(oldPath)) return;
  const row = _db.exec("SELECT COUNT(*) AS c FROM books");
  if (row[0]?.values[0][0] > 0) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldPath, "utf8"));
    if (!data.books || !Array.isArray(data.books)) return;
    const insBook = _db.prepare(
      `INSERT OR IGNORE INTO books (id,bid,title,title_lower,author,author_lower,language,year,formats,sizeText,cover,description,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insGenre = _db.prepare(
      `INSERT OR IGNORE INTO book_genres (book_id,genre) VALUES (?,?)`
    );
    _db.run("BEGIN");
    for (const book of data.books) {
      insBook.bind([
        book.id||"", book.bid||0, book.title||"", (book.title||"").toLowerCase(),
        book.author||"", (book.author||"").toLowerCase(),
        book.language||null, book.year||null,
        JSON.stringify(book.formats||[]),
        book.sizeText||null, book.cover||null,
        book.description||null, book.updatedAt||null,
      ]);
      insBook.step(); insBook.reset();
      if (book.genres && Array.isArray(book.genres)) {
        for (const g of book.genres) { insGenre.bind([book.id,g]); insGenre.step(); insGenre.reset(); }
      }
    }
    _db.run("COMMIT");
    insBook.free(); insGenre.free();
    _persist();
    fs.renameSync(oldPath, oldPath + ".migrated");
  } catch (e) { console.error("Migration:", e.message); }
}

async function getDb() {
  await _ensureSql();
  _lastAccess = Date.now();
  if (_db) { _scheduleUnload(); return _db; }
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  _initSchema(_db);
  _migrateFromJson();
  _scheduleUnload();
  return _db;
}

function persist() { if (_db) _persist(); }
function ref() { _refCount++; }
function unref() { if (_refCount > 0) _refCount--; _scheduleUnload(); }
function close() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_db) { _persist(); _db.close(); _db = null; }
}
function reset() {
  close();
  try { fs.rmSync(DB_PATH, { force: true }); } catch {}
  try { fs.rmSync(DB_PATH + ".tmp", { force: true }); } catch {}
}

async function queryAll(sql, params = []) {
  const db = await getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows[0] || null;
}
async function queryValue(sql, params = [], def = null) {
  const row = await queryOne(sql, params);
  return row ? Object.values(row)[0] ?? def : def;
}

module.exports = {
  getDb, persist, ref, unref, close,
  reset, queryAll, queryOne, queryValue, DB_PATH,
};