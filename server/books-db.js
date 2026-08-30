"use strict";

/**
 * Локальный каталог книг на нативной SQLite (better-sqlite3).
 *
 * База живёт на диске (storage/books_catalog.db) и читается напрямую —
 * вся БД не загружается в оперативную память (в отличие от прежней
 * реализации на sql.js / WebAssembly). Подключение одно и постоянно.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { DIRS } = require("./config");

const DB_PATH = path.join(DIRS.storage, "books_catalog.db");

let _db = null;

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
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
    );

    CREATE TABLE IF NOT EXISTS book_genres (
      book_id TEXT NOT NULL,
      genre TEXT NOT NULL,
      PRIMARY KEY (book_id, genre)
    );
    CREATE INDEX IF NOT EXISTS idx_bg_genre   ON book_genres(genre);
    CREATE INDEX IF NOT EXISTS idx_bg_book_id ON book_genres(book_id);
    CREATE INDEX IF NOT EXISTS idx_books_title_lower ON books(title_lower);
    CREATE INDEX IF NOT EXISTS idx_books_author_lower ON books(author_lower);
    CREATE INDEX IF NOT EXISTS idx_books_language ON books(language);
    CREATE INDEX IF NOT EXISTS idx_books_year     ON books(year);
    CREATE INDEX IF NOT EXISTS idx_books_bid      ON books(bid);

    /* Расширенная схема: авторы, циклы, рейтинги, переводчики, аннотации, рекомендации. */
    CREATE TABLE IF NOT EXISTS authors (
      id INTEGER PRIMARY KEY,
      name TEXT,
      name_lower TEXT,
      pic TEXT
    );

    CREATE TABLE IF NOT EXISTS book_authors (
      book_id TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      pos INTEGER,
      PRIMARY KEY (book_id, author_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ba_author ON book_authors(author_id);

    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY,
      name TEXT,
      name_lower TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seq_name ON sequences(name_lower);

    CREATE TABLE IF NOT EXISTS book_sequences (
      book_id TEXT NOT NULL,
      seq_id INTEGER NOT NULL,
      number INTEGER,
      PRIMARY KEY (book_id, seq_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bs_seq ON book_sequences(seq_id);

    CREATE TABLE IF NOT EXISTS book_ratings (
      book_id TEXT PRIMARY KEY,
      rating REAL,
      votes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rate_votes ON book_ratings(votes);

    CREATE TABLE IF NOT EXISTS book_translators (
      book_id TEXT NOT NULL,
      translator_id INTEGER NOT NULL,
      pos INTEGER,
      PRIMARY KEY (book_id, translator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bt_trans ON book_translators(translator_id);

    CREATE TABLE IF NOT EXISTS book_recs (
      book_id TEXT NOT NULL,
      related_book_id TEXT NOT NULL,
      PRIMARY KEY (book_id, related_book_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rec_book    ON book_recs(book_id);
    CREATE INDEX IF NOT EXISTS idx_rec_related ON book_recs(related_book_id);
  `);
}

function getDb() {
  if (_db) return Promise.resolve(_db);
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 8000");
  _db.pragma("synchronous = NORMAL");
  _initSchema(_db);
  return Promise.resolve(_db);
}

function persist() {
  // WAL: данные уже записаны на диск на каждом коммите; пассивный checkpoint
  // лишь компактирует wal-файл, не блокируя читателей.
  if (!_db) return;
  try { _db.pragma("wal_checkpoint(PASSIVE)"); } catch { }
}

function ref() { /* не требуется для нативной БД; сохранено для совместимости */ }
function unref() { /* не требуется для нативной БД; сохранено для совместимости */ }

function close() {
  if (!_db) return;
  try { _db.close(); } catch { }
  _db = null;
}

function reset() {
  close();
  try { fs.rmSync(DB_PATH, { force: true }); } catch {}
  try { fs.rmSync(DB_PATH + "-wal", { force: true }); } catch {}
  try { fs.rmSync(DB_PATH + "-shm", { force: true }); } catch {}
  try { fs.rmSync(DB_PATH + ".tmp", { force: true }); } catch {}
}

function queryAll(sql, params = []) {
  return getDb().then((db) => db.prepare(sql).all(...params));
}
function queryOne(sql, params = []) {
  return queryAll(sql, params).then((rows) => rows[0] || null);
}
function queryValue(sql, params = [], def = null) {
  return queryOne(sql, params).then((row) => (row ? Object.values(row)[0] ?? def : def));
}

module.exports = {
  getDb, persist, ref, unref, close,
  reset, queryAll, queryOne, queryValue, DB_PATH,
};