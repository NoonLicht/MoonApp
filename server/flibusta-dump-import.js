"use strict";

/**
 * Импорт каталога Flibusta из MySQL-дампов (dump_cache/) в единую SQLite-БД.
 * Файлы положить в storage/dump_cache/.
 *
 * Создаваемые таблицы и связи:
 *   books, book_genres              — книги и жанры (базово)
 *   authors, book_authors           — авторы и их привязки к книгам
 *   sequences, book_sequences       — циклы/серии (libseqname, libseq)
 *   book_ratings                    — рейтинги книг (librate)
 *   book_translators                — переводчики (libtranslator)
 *   book_annotations                — аннотации книг (b.annotations)
 *   book_recs                       — похожие книги по со-рекомендациям (librecs)
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const booksDb = require("./books-db");
const logger = require("./logger");

const BASE = "https://opds.flibusta.is";

const DUMP_FILES = {
  book: "lib.libbook.sql.gz",
  avtor: "lib.libavtor.sql.gz",
  avtorname: "lib.libavtorname.sql.gz",
  genre: "lib.libgenre.sql.gz",
  genrelist: "lib.libgenrelist.sql.gz",
  filename: "lib.libfilename.sql.gz",
  seqname: "lib.libseqname.sql.gz",
  seq: "lib.libseq.sql.gz",
  rate: "lib.librate.sql.gz",
  translator: "lib.libtranslator.sql.gz",
  recs: "lib.librecs.sql.gz",
  apics: "lib.a.annotations_pics.sql.gz",
  bpics: "lib.b.annotations_pics.sql.gz",
  bannots: "lib.b.annotations.sql.gz",
};

const REQUIRED = ["book", "avtorname", "avtor", "genre", "genrelist"];
const OPTIONAL = ["seqname", "seq", "rate", "translator", "recs", "apics", "bpics", "bannots"];

const CACHE_DIR = path.join(DIRS.storage, "dump_cache");
let importState = { running: false, done: 0, total: 0, current: "", added: 0, error: "" };
function status() { return { ...importState }; }
function step() { importState.done = Math.min(importState.total, importState.done + 1); }

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
/*  Потоковое чтение .sql.gz (без выгрузки всего файла в память)      */
/* ------------------------------------------------------------------ */

function streamInsertRows(filePath, onRow) {
  return new Promise((resolve, reject) => {
    let pending = "";
    let inValues = false;
    let leftover = "";
    const gunzip = zlib.createGunzip();
    const stream = fs.createReadStream(filePath);
    function processLine(line) {
      const t = line.trim();
      if (!t || t.startsWith("--") || t.startsWith("#") || t.startsWith("/*")) return;
      pending += t;
      if (!inValues) {
        if (/^INSERT\s+INTO\s+\S+/i.test(pending)) inValues = true;
        else { pending = ""; return; }
      }
      if (pending.endsWith(";")) {
        const rows = parseInsertValues(pending.slice(0, -1));
        pending = ""; inValues = false;
        for (const r of rows) onRow(r);
      }
    }
    gunzip.on("data", (chunk) => {
      leftover += chunk.toString("utf8");
      let nl;
      while ((nl = leftover.indexOf("\n")) >= 0) {
        processLine(leftover.slice(0, nl));
        leftover = leftover.slice(nl + 1);
      }
    });
    gunzip.on("end", () => {
      if (leftover.trim()) { processLine(leftover.trim()); leftover = ""; }
      if (inValues && pending.length) { for (const r of parseInsertValues(pending)) onRow(r); }
      resolve();
    });
    gunzip.on("error", reject);
    stream.on("error", reject);
    stream.pipe(gunzip);
  });
}

function collectRows(filePath) {
  return new Promise((resolve, reject) => {
    const out = [];
    streamInsertRows(filePath, (r) => out.push(r)).then(() => resolve(out)).catch(reject);
  });
}

function buildAuthorName(r) {
  const parts = [String(r[1] || ""), String(r[2] || ""), String(r[3] || "")].map((s) => s.trim()).filter(Boolean);
  const nick = String(r[4] || "").trim();
  if (parts.length === 0 && nick) return nick;
  let name = parts.join(" ");
  if (nick && !name.includes(nick)) name = name ? name + " (" + nick + ")" : nick;
  return name;
}

function stripHtml(html) {
  return String(html == null ? "" : html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/*  Импорт — основной процесс                                         */
/* ------------------------------------------------------------------ */

async function runImport() {
  if (importState.running) return { ok: false, reason: "already_running" };
  importState = { running: true, done: 0, total: 0, current: "", added: 0, error: "" };
  booksDb.ref();
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const available = {};
  for (const [key, fname] of Object.entries(DUMP_FILES)) {
    const fp = path.join(CACHE_DIR, fname);
    if (fs.existsSync(fp)) available[key] = fp;
  }
  const missing = REQUIRED.filter((k) => !available[k]);
  if (missing.length > 0) {
    importState.running = false;
    importState.error = `Отсутствуют: ${missing.map((k) => DUMP_FILES[k]).join(", ")}. Положите в ${CACHE_DIR}`;
    booksDb.unref();
    return { ok: false, error: importState.error };
  }
  importState.total = 6 + OPTIONAL.filter((k) => available[k]).length;
  booksDb.persist();

  const asyncOp = async () => {
    const startMs = Date.now();
    const db = await booksDb.getDb();
    const tag = (bid) => `tag:book:${bid}`;
    try {
      // ---- Авторы (avtorname) + фото (apics, опц.) ----
      importState.current = "Загрузка авторов...";
      const authorMap = new Map();
      const authorPicMap = new Map();
      await streamInsertRows(available.avtorname, (r) => {
        const id = Number(r[0]);
        if (id && !authorMap.has(id)) authorMap.set(id, buildAuthorName(r));
      });
      if (available.apics) {
        importState.current = "Загрузка фото авторов...";
        for (const r of await collectRows(available.apics)) {
          const aid = Number(r[0]);
          if (aid && !authorPicMap.has(aid)) authorPicMap.set(aid, String(r[2] || ""));
        }
      }
      step();

      // ---- Жанры (мастер — genrelist) ----
      importState.current = "Загрузка жанров...";
      const genreNameMap = new Map();
      for (const r of await collectRows(available.genrelist)) {
        const gid = Number(r[0]);
        const name = String(r[2] || "").trim();
        if (gid && name) genreNameMap.set(gid, name);
      }
      step();

      // ---- Привязка авторов к книгам (avtor) ----
      importState.current = "Загрузка привязок авторов...";
      const bookAuthorMap = new Map();
      await streamInsertRows(available.avtor, (r) => {
        const bid = Number(r[0]), aid = Number(r[1]);
        if (!bid || !aid) return;
        const arr = bookAuthorMap.get(bid) || [];
        arr.push({ aid, pos: Number(r[2] || 0) });
        bookAuthorMap.set(bid, arr);
      });
      step();

      // ---- Привязка жанров к книгам (libgenre link) ----
      importState.current = "Загрузка привязок жанров...";
      const bookGenreMap = new Map();
      await streamInsertRows(available.genre, (r) => {
        const bid = Number(r[1]), gid = Number(r[2]);
        const gn = genreNameMap.get(gid);
        if (bid && gn) {
          const arr = bookGenreMap.get(bid) || [];
          if (!arr.includes(gn)) arr.push(gn);
          bookGenreMap.set(bid, arr);
        }
      });
      step();

      // ---- Форматы (filename) + обложки (bpics, опц.) ----
      const bookFormatMap = new Map();
      const bookCoverMap = new Map();
      await streamInsertRows(available.filename, (r) => {
        const bid = Number(r[0]);
        const file = String(r[1] || "");
        const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
        if (bid && /^(fb2|epub|mobi|pdf|html|txt|rtf)$/.test(ext)) {
          const arr = bookFormatMap.get(bid) || [];
          if (!arr.includes(ext)) arr.push(ext);
          bookFormatMap.set(bid, arr);
        }
      });
      if (available.bpics) {
        importState.current = "Загрузка обложек...";
        await streamInsertRows(available.bpics, (r) => {
          const bid = Number(r[0]);
          if (bid && !bookCoverMap.has(bid)) bookCoverMap.set(bid, String(r[2] || ""));
        });
      }
      step();

// ---- Циклы/серии (seqname + seq, опц.) ----
      const seqNameMap = new Map();
      const bookSeqMap = new Map();
      if (available.seqname) {
        importState.current = "Загрузка циклов...";
        for (const r of await collectRows(available.seqname)) {
          const sid = Number(r[0]);
          if (sid && !seqNameMap.has(sid)) seqNameMap.set(sid, String(r[1] || "").trim());
        }
      }
      step();
      if (available.seq) {
        importState.current = "Загрузка привязок циклов...";
        await streamInsertRows(available.seq, (r) => {
          const bid = Number(r[0]), sid = Number(r[1]);
          if (!bid || !sid) return;
          const arr = bookSeqMap.get(bid) || [];
          arr.push({ seqId: sid, num: Number(r[2] || 0) });
          bookSeqMap.set(bid, arr);
        });
      }
      step();

      // ---- Переводчики (translator, опц.) ----
      const bookTranslatorMap = new Map();
      if (available.translator) {
        importState.current = "Загрузка переводчиков...";
        await streamInsertRows(available.translator, (r) => {
          const bid = Number(r[0]), tid = Number(r[1]);
          if (!bid || !tid) return;
          const arr = bookTranslatorMap.get(bid) || [];
          arr.push({ tid, pos: Number(r[2] || 0) });
          bookTranslatorMap.set(bid, arr);
        });
      }
      step();

      // ---- Рейтинги (rate, опц.) — агрегация по книгам ----
      const bookRatingMap = new Map();
      if (available.rate) {
        importState.current = "Загрузка рейтингов...";
        await streamInsertRows(available.rate, (r) => {
          const bid = Number(r[1]);
          const rate = Number(r[3]);
          if (!bid || !rate) return;
          const agg = bookRatingMap.get(bid) || { sum: 0, count: 0 };
          agg.sum += rate; agg.count++;
          bookRatingMap.set(bid, agg);
        });
      }
      step();

      // ---- Похожие книги (recs, опц.) — со-рекомендации ----
      const bookRecsMap = new Map();
      if (available.recs) {
        importState.current = "Загрузка рекомендаций...";
        const userBooks = new Map();
        await streamInsertRows(available.recs, (r) => {
          const uid = Number(r[1]), bid = Number(r[2]);
          if (!uid || !bid) return;
          const set = userBooks.get(uid) || new Set();
          set.add(bid);
          userBooks.set(uid, set);
        });
        for (const set of userBooks.values()) {
          const arr = Array.from(set);
          if (arr.length < 2) continue;
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              const a = arr[i], b = arr[j];
              let ma = bookRecsMap.get(a); if (!ma) { ma = new Map(); bookRecsMap.set(a, ma); }
              ma.set(b, (ma.get(b) || 0) + 1);
              let mb = bookRecsMap.get(b); if (!mb) { mb = new Map(); bookRecsMap.set(b, mb); }
              mb.set(a, (mb.get(a) || 0) + 1);
            }
          }
        }
        userBooks.clear();
      }
      step();

// ---- Вставка книг ----
      importState.current = "Вставка книг в БД...";
      const insBook = db.prepare(
        `INSERT OR IGNORE INTO books (id,bid,title,title_lower,author,author_lower,language,year,formats,sizeText,cover,description,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const insGenre = db.prepare(`INSERT OR IGNORE INTO book_genres (book_id,genre) VALUES (?,?)`);

      let inserted = 0;
      let pendingBookBatch = [];
      let bookFlushCount = 0;
      const BATCH = 800;
      const flushBooks = () => {
        if (pendingBookBatch.length === 0) return;
        db.run("BEGIN");
        let n = 0;
        for (const b of pendingBookBatch) {
          insBook.bind([b.id, b.bid, b.title, b.titleLow, b.author, b.authorLow, b.lang, b.year,
            JSON.stringify(b.formats), null, b.cover, null, new Date().toISOString()]);
          insBook.step();
          if (db.getRowsModified() > 0) {
            n++;
            for (const g of b.genres) { insGenre.bind([b.id, g]); insGenre.step(); insGenre.reset(); }
          }
          insBook.reset();
        }
        db.run("COMMIT");
        inserted += n;
        importState.added = inserted;
        pendingBookBatch = [];
        bookFlushCount++;
        if (bookFlushCount % 25 === 0) booksDb.persist();
      };

      await streamInsertRows(available.book, (r) => {
        const bid = Number(r[0]);
        const title = String(r[3] || "").trim();
        const lang = String(r[5] || "").trim().toLowerCase();
        const year = r[10] != null ? Number(r[10]) : null;
        const authors = bookAuthorMap.get(bid) || [];
        const author = authors.length ? (authorMap.get(authors[0].aid) || "") : "";
        const coverPath = bookCoverMap.get(bid);
        pendingBookBatch.push({
          id: tag(bid), bid, title,
          titleLow: title.toLowerCase(),
          author, authorLow: author.toLowerCase(),
          lang: lang || null, year: year || null,
          formats: bookFormatMap.get(bid) || [],
          cover: coverPath ? BASE + "/fb2/" + String(coverPath).replace(/^\/+/, "") : null,
          genres: bookGenreMap.get(bid) || [],
        });
        if (pendingBookBatch.length >= BATCH) flushBooks();
      });
      flushBooks();
      insBook.free();
      insGenre.free();

      // ---- Авторы и привязки ----
      importState.current = "Вставка авторов...";
      const insAuthor = db.prepare(`INSERT OR IGNORE INTO authors (id,name,name_lower,pic) VALUES (?,?,?,?)`);
      const insBookAuthor = db.prepare(`INSERT OR IGNORE INTO book_authors (book_id,author_id,pos) VALUES (?,?,?)`);
      db.run("BEGIN");
      for (const [aid, name] of authorMap) {
        const picPath = authorPicMap.get(aid);
        insAuthor.bind([aid, name, name.toLowerCase(), picPath ? BASE + "/fb2/" + String(picPath).replace(/^\/+/, "") : null]);
        insAuthor.step(); insAuthor.reset();
      }
      db.run("COMMIT");
      insAuthor.free();
      db.run("BEGIN");
      for (const [bid, arr] of bookAuthorMap) {
        const bId = tag(bid);
        for (const a of arr) { insBookAuthor.bind([bId, a.aid, a.pos]); insBookAuthor.step(); insBookAuthor.reset(); }
      }
      db.run("COMMIT");
      insBookAuthor.free();
      step();

      // ---- Циклы ----
      const insSeq = db.prepare(`INSERT OR IGNORE INTO sequences (id,name,name_lower) VALUES (?,?,?)`);
      const insBookSeq = db.prepare(`INSERT OR IGNORE INTO book_sequences (book_id,seq_id,number) VALUES (?,?,?)`);
      db.run("BEGIN");
      for (const [sid, name] of seqNameMap) { insSeq.bind([sid, name, name.toLowerCase()]); insSeq.step(); insSeq.reset(); }
      db.run("COMMIT");
      insSeq.free();
      db.run("BEGIN");
      for (const [bid, arr] of bookSeqMap) for (const s of arr) { insBookSeq.bind([tag(bid), s.seqId, s.num]); insBookSeq.step(); insBookSeq.reset(); }
      db.run("COMMIT");
      insBookSeq.free();
      step();

// ---- Рейтинги ----
      const insRate = db.prepare(`INSERT OR REPLACE INTO book_ratings (book_id,rating,votes) VALUES (?,?,?)`);
      db.run("BEGIN");
      for (const [bid, agg] of bookRatingMap) {
        insRate.bind([tag(bid), +(agg.sum / agg.count).toFixed(2), agg.count]);
        insRate.step(); insRate.reset();
      }
      db.run("COMMIT");
      insRate.free();
      step();

      // ---- Переводчики ----
      const insTr = db.prepare(`INSERT OR IGNORE INTO book_translators (book_id,translator_id,pos) VALUES (?,?,?)`);
      db.run("BEGIN");
      for (const [bid, arr] of bookTranslatorMap) for (const t of arr) { insTr.bind([tag(bid), t.tid, t.pos]); insTr.step(); insTr.reset(); }
      db.run("COMMIT");
      insTr.free();
      step();

      // ---- Похожие книги (топ N на книгу) ----
      const insRec = db.prepare(`INSERT OR IGNORE INTO book_recs (book_id,related_book_id) VALUES (?,?)`);
      db.run("BEGIN");
      for (const [bid, relMap] of bookRecsMap) {
        const tops = Array.from(relMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40);
        for (const [rel] of tops) { insRec.bind([tag(bid), tag(rel)]); insRec.step(); insRec.reset(); }
      }
      db.run("COMMIT");
      insRec.free();
      step();

      // ---- Аннотации книг (опц.) ----
      if (available.bannots) {
        importState.current = "Загрузка аннотаций...";
        const insAnn = db.prepare(`INSERT OR IGNORE INTO book_annotations (book_id,title,body) VALUES (?,?,?)`);
        const updDesc = db.prepare(`UPDATE books SET description=? WHERE id=? AND (description IS NULL OR description='')`);
        let annBatch = [];
        let annFlushCount = 0;
        const flushAnn = () => {
          if (annBatch.length === 0) return;
          db.run("BEGIN");
          for (const a of annBatch) {
            insAnn.bind([a.id, a.title, a.body]); insAnn.step(); insAnn.reset();
            if (a.desc) { updDesc.bind([a.desc, a.id]); updDesc.step(); updDesc.reset(); }
          }
          db.run("COMMIT");
          annBatch = [];
          annFlushCount++;
          if (annFlushCount % 100 === 0) booksDb.persist();
        };
        await streamInsertRows(available.bannots, (r) => {
          const bid = Number(r[0]);
          if (!bid) return;
          annBatch.push({ id: tag(bid), title: String(r[2] || "").trim() || null, body: String(r[3] || ""), desc: stripHtml(r[3]) || null });
          if (annBatch.length >= 400) flushAnn();
        });
        flushAnn();
        insAnn.free();
        updDesc.free();
        step();
      }

      booksDb.persist();
      const secs = ((Date.now() - startMs) / 1000).toFixed(1);
      const cnt = await booksDb.queryValue("SELECT COUNT(*) FROM books", [], 0);
      logger.info("flibusta.dump_import_done", { added: inserted, count: cnt, seconds: secs });
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