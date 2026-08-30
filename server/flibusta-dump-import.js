"use strict";

/**
 * Импорт каталога Flibusta из MySQL-дампов (dump_cache/).
 * Файлы положить в storage/dump_cache/.
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const booksDb = require("./books-db");
const logger = require("./logger");

const DUMP_FILES = {
  book: "lib.libbook.sql.gz",
  avtor: "lib.libavtor.sql.gz",
  avtorname: "lib.libavtorname.sql.gz",
  genre: "lib.libgenre.sql.gz",
  genrelist: "lib.libgenrelist.sql.gz",
  filename: "lib.libfilename.sql.gz",
};

const CACHE_DIR = path.join(DIRS.storage, "dump_cache");
let importState = { running: false, done: 0, total: 0, current: "", added: 0, error: "" };
function status() { return { ...importState }; }
/* ------------------------------------------------------------------ */
/*  Парсинг MySQL INSERT                                             */
/* ------------------------------------------------------------------ */

function parseMySqlRow(rowStr) {
  const vals = [];
  let i = 0;
  let cur = "";
  const len = rowStr.length;
  while (i < len) {
    const c = rowStr[i];
    if (cur === "" && (c === " " || c === "\t")) { i++; continue; }
    if (c === "'") {
      cur = ""; i++;
      while (i < len) {
        const cc = rowStr[i];
        if (cc === "\\") { cur += rowStr[i + 1] || ""; i += 2; continue; }
        if (cc === "'") { i++; break; }
        cur += cc; i++;
      }
      vals.push(cur); cur = "";
      while (i < len && (rowStr[i] === "," || rowStr[i] === " " || rowStr[i] === "\t")) i++;
      continue;
    }
    if (c === "N" && rowStr.slice(i, i + 4).toUpperCase() === "NULL") {
      vals.push(null); i += 4;
      while (i < len && (rowStr[i] === "," || rowStr[i] === " " || rowStr[i] === "\t")) i++;
      continue;
    }
    if (c === ",") { vals.push(null); i++; continue; }
    if (/[\d\-.]/.test(c)) {
      cur = "";
      while (i < len && /[\d\-.]/.test(rowStr[i])) { cur += rowStr[i]; i++; }
      vals.push(Number(cur)); cur = "";
      while (i < len && (rowStr[i] === "," || rowStr[i] === " " || rowStr[i] === "\t")) i++;
      continue;
    }
    while (i < len && rowStr[i] !== ",") i++;
    if (i < len && rowStr[i] === ",") i++;
  }
  if (cur !== "") vals.push(cur);
  return vals;
}

function parseInsertValues(sql) {
  const clean = sql.replace(/`/g, "").replace(/\s+/g, " ");
  const m = clean.match(/VALUES\s*\(/i);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  const rows = [];
  let depth = 0;
  let inStr = false;
  let rowStart = -1;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (c === "'" && !inStr) { inStr = true; continue; }
    if (c === "'" && inStr && clean[i - 1] !== "\\") { inStr = false; continue; }
    if (inStr) continue;
    if (c === "(") {
      if (depth === 0) rowStart = i + 1;
      depth++;
    }
    if (c === ")") {
      depth--;
      if (depth === 0 && rowStart >= 0) {
        rows.push(parseMySqlRow(clean.slice(rowStart, i)));
        rowStart = -1;
      }
    }
  }
  return rows;
}

function parseInsertStatements(text) {
  const rows = [];
  const lines = text.split("\n");
  let buffer = "";
  let inValues = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("--") || t.startsWith("#") || t.startsWith("/*")) continue;
    buffer += t;
    if (!inValues) {
      if (/^\s*INSERT\s+INTO\s+\S+/i.test(buffer)) inValues = true;
      else { buffer = ""; continue; }
    }
    if (buffer.endsWith(";")) {
      rows.push(...parseInsertValues(buffer.slice(0, -1)));
      buffer = ""; inValues = false;
    }
  }
  if (inValues && buffer.length > 0) rows.push(...parseInsertValues(buffer));
  return rows;
}

function readGzippedSqlSync(filePath) {
  return zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
}
/* ------------------------------------------------------------------ */
/*  Импорт — основной процесс                                         */
/* ------------------------------------------------------------------ */

async function runImport() {
  if (importState.running) return { ok: false, reason: "already_running" };
  importState = { running: true, done: 0, total: 6, current: "", added: 0, error: "" };
  booksDb.ref();
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const available = {};
  for (const [key, fname] of Object.entries(DUMP_FILES)) {
    const fp = path.join(CACHE_DIR, fname);
    if (fs.existsSync(fp)) available[key] = fp;
  }
  const required = ["book", "avtorname", "avtor", "genre", "genrelist"];
  const missing = required.filter(k => !available[k]);
  if (missing.length > 0) {
    importState.running = false;
    importState.error = `Отсутствуют: ${missing.map(k => DUMP_FILES[k]).join(", ")}. Положите в ${CACHE_DIR}`;
    booksDb.unref();
    return { ok: false, error: importState.error };
  }
  booksDb.persist();

  const asyncOp = async () => {
    try {
      importState.current = "Загрузка авторов...";
      logger.info("flibusta.dump_import", { step: "avtorname" });
      const avtornameRows = parseInsertStatements(readGzippedSqlSync(available.avtorname));
      const authorMap = new Map();
      for (const r of avtornameRows) authorMap.set(Number(r[0]), (String(r[1]||"")+" "+String(r[2]||"")).trim());
      logger.info("flibusta.dump_import", { step: "avtorname", count: authorMap.size });
      importState.done = 1;

      importState.current = "Загрузка жанров...";
      const genreRows = parseInsertStatements(readGzippedSqlSync(available.genre));
      const genreMap = new Map();
      for (const r of genreRows) genreMap.set(Number(r[0]), String(r[1]||""));
      logger.info("flibusta.dump_import", { step: "genre", count: genreMap.size });
      importState.done = 2;

      importState.current = "Загрузка привязок авторов...";
      const avtorRows = parseInsertStatements(readGzippedSqlSync(available.avtor));
      const bookAuthorMap = new Map();
      for (const r of avtorRows) { const bid=Number(r[1]), aid=Number(r[2]); if(!bookAuthorMap.has(bid)) bookAuthorMap.set(bid, aid); }
      logger.info("flibusta.dump_import", { step: "avtor", count: bookAuthorMap.size });
      importState.done = 3;

      importState.current = "Загрузка привязок жанров...";
      const glRows = parseInsertStatements(readGzippedSqlSync(available.genrelist));
      const bookGenreMap = new Map();
      for (const r of glRows) { const bid=Number(r[1]), gid=Number(r[2]), gn=genreMap.get(gid); if(gn){const a=bookGenreMap.get(bid)||[];a.push(gn);bookGenreMap.set(bid,a);} }
      logger.info("flibusta.dump_import", { step: "genrelist", count: bookGenreMap.size });
      importState.done = 4;

      let bookFormatMap = new Map();
      if (available.filename) {
        importState.current = "Загрузка форматов...";
        for (const r of parseInsertStatements(readGzippedSqlSync(available.filename))) {
          const bid=Number(r[1]), fmt=String(r[3]||"").toLowerCase();
          if(fmt){const a=bookFormatMap.get(bid)||[];if(!a.includes(fmt))a.push(fmt);bookFormatMap.set(bid,a);}
        }
      }
      importState.done = 5;

      importState.current = "Вставка книг в БД...";
      const bookRows = parseInsertStatements(readGzippedSqlSync(available.book));
      importState.total = bookRows.length;
const db = await booksDb.getDb();
      const insBook = db.prepare(`INSERT OR IGNORE INTO books (id,bid,title,title_lower,author,author_lower,language,year,formats,sizeText,cover,description,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insGenre = db.prepare(`INSERT OR IGNORE INTO book_genres (book_id,genre) VALUES (?,?)`);

      const BATCH = 500;
      let totalAdded = 0;
      const startMs = Date.now();

      for (let i = 0; i < bookRows.length; i += BATCH) {
        const batch = bookRows.slice(i, i + BATCH);
        importState.current = `Книги: ${Math.min(i+BATCH, bookRows.length)}/${bookRows.length}`;
        db.run("BEGIN");
        let batchAdded = 0;
        for (const r of batch) {
          const bid = Number(r[0]);
          const title = String(r[1]||"").trim();
          let author = String(r[2]||"").trim();
          const lang = String(r[3]||"").trim().toLowerCase();
          const year = r[4] != null ? Number(r[4]) : null;
          if (!author) { const aid = bookAuthorMap.get(bid); if (aid) author = authorMap.get(aid) || ""; }
          const bookId = `tag:book:${bid}`;
          const genres = bookGenreMap.get(bid) || [];
          const formats = bookFormatMap.get(bid) || [];
          insBook.bind([bookId, bid, title, title.toLowerCase(), author, author.toLowerCase(), lang||null, year||null, JSON.stringify(formats), null, null, null, new Date().toISOString()]);
          insBook.step();
          const changed = db.getRowsModified();
          insBook.reset();
          if (changed > 0) {
            batchAdded++;
            for (const g of genres) { insGenre.bind([bookId, g]); insGenre.step(); insGenre.reset(); }
          }
        }
        db.run("COMMIT");
        totalAdded += batchAdded;
        importState.added = totalAdded;
        if (i % (BATCH * 20) === 0) booksDb.persist();
      }

      insBook.free();
      insGenre.free();
      booksDb.persist();

      const secs = ((Date.now() - startMs)/1000).toFixed(1);
      const cnt = await booksDb.queryValue("SELECT COUNT(*) FROM books", [], 0);
      logger.info("flibusta.dump_import_done", { added: totalAdded, count: cnt, seconds: secs });
      importState.running = false;
      importState.current = "Готово";
    } catch (e) {
      importState.running = false;
      importState.error = e.message;
      logger.error("flibusta.dump_import_error", { error: e.message });
    } finally {
      booksDb.unref();
    }
  };
  asyncOp();
  return { ok: true };
}

module.exports = { runImport, status };