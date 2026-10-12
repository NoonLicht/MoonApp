/**
 * Локальная база почты (storage/mail.db, отдельный SQLite-файл).
 *
 * Письма не живут в общем data.db: их тысячи, а общий стор держит строки в памяти.
 * Здесь — обычные SQL-таблицы через better-sqlite3 с индексами и FTS-поиском по LIKE.
 */
import path from "path";
import Database from "better-sqlite3";
import config from "../config";

const { DIRS } = config;

let db: Database.Database | null = null;

export function mailDb(): Database.Database {
  if (db) return db;
  db = new Database(path.join(DIRS.storage, "mail.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_secure INTEGER NOT NULL DEFAULT 1,
      smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_secure INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL,
      pass_enc TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      last_sync INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS folders (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      special TEXT NOT NULL DEFAULT '',
      uid_validity TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account, path)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      msgid TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT NOT NULL DEFAULT '',
      refs TEXT NOT NULL DEFAULT '',
      thread TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      date INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      att_json TEXT NOT NULL DEFAULT '[]',
      snooze_until INTEGER NOT NULL DEFAULT 0,
      remind_at INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ix_msg_folder ON messages(account, folder, date DESC);
    CREATE INDEX IF NOT EXISTS ix_msg_thread ON messages(thread);
    CREATE INDEX IF NOT EXISTS ix_msg_snooze ON messages(snooze_until);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      payload TEXT NOT NULL,
      send_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    );
  `);
  return db;
}

export function closeMailDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* уже закрыта */
    }
    db = null;
  }
}
