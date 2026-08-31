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
 *   book_recs                       — похожие книги (librecs; отключено из-за OOM, включить FLIB_IMPORT_RECS=1)
 *   book_annotations                — аннотации книг (b.annotations) → только description в books
 *
 * Режим отладки: importLogs буфер (кольцевой, 500 строк).
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
const OPTIONAL = ["seqname", "seq", "rate", "translator", "apics", "bpics", "bannots", "filename"];

const CACHE_DIR = path.join(DIRS.storage, "dump_cache");
let importState = { running: false, done: 0, total: 0, current: "", added: 0, error: "" };
function status() { return { ...importState }; }
function step() { importState.done = Math.min(importState.total, importState.done + 1); }
// Кольцевой буфер логов импорта (для кнопки "Логи импорта" на фронте)
const MAX_LOG_LINES = 500;
const logBuffer = [];
function pushLog(msg) {
  logBuffer.push({ ts: new Date().toISOString().slice(11,19), msg: String(msg).slice(0,500) });
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
}
function getLogs(n = 200) {
  return logBuffer.slice(-n);
}

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
  pushLog("=== Импорт запущен ===");
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
    // Обёртка для опциональных файлов: сбой одного не роняет весь импорт.
    const safe = async (label, fn) => {
      try { await fn(); }
      catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logger.error("flibusta.dump_import_skip", { step: label, error: msg });
      }
    };
    try {
      // ---- Авторы (avtorname) + фото (apics, опц.) ----
      importState.current = "Загрузка авторов..."; pushLog(importState.current);
      const authorMap = new Map();
      const authorPicMap = new Map();
      await streamInsertRows(available.avtorname, (r) => {
        const id = Number(r[0]);
        if (id && !authorMap.has(id)) authorMap.set(id, buildAuthorName(r));
      });
      if (available.apics) {
        importState.current = "Загрузка фото авторов..."; pushLog(importState.current);
        for (const r of await collectRows(available.apics)) {
          const aid = Number(r[0]);
          if (aid && !authorPicMap.has(aid)) authorPicMap.set(aid, String(r[2] || ""));
        }
      }
      step();

      // ---- Жанры (мастер — genrelist) ----
      importState.current = "Загрузка жанров..."; pushLog(importState.current);
      const genreNameMap = new Map();
      for (const r of await collectRows(available.genrelist)) {
        const gid = Number(r[0]);
        const name = String(r[2] || "").trim();
        if (gid && name) genreNameMap.set(gid, name);
      }
      step();

      // ---- Привязка авторов к книгам (avtor) ----
      importState.current = "Загрузка привязок авторов..."; pushLog(importState.current);
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
      importState.current = "Загрузка привязок жанров..."; pushLog(importState.current);
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
        importState.current = "Загрузка обложек..."; pushLog(importState.current);
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
        importState.current = "Загрузка циклов..."; pushLog(importState.current);
        for (const r of await collectRows(available.seqname)) {
          const sid = Number(r[0]);
          if (sid && !seqNameMap.has(sid)) seqNameMap.set(sid, String(r[1] || "").trim());
        }
      }
      step();
      if (available.seq) {
        importState.current = "Загрузка привязок циклов..."; pushLog(importState.current);
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
        importState.current = "Загрузка переводчиков..."; pushLog(importState.current);
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
        importState.current = "Загрузка рейтингов..."; pushLog(importState.current);
        await streamInsertRows(available.rate, (r) => {
          const bid = Number(r[2]);
          const rate = Number(r[3]);
          if (!bid || !rate) return;
          const agg = bookRatingMap.get(bid) || { sum: 0, count: 0 };
          agg.sum += rate; agg.count++;
          bookRatingMap.set(bid, agg);
        });
      }
      step();

      // ---- Похожие книги (recs, опц.) — со-рекомендации ----
      // Сначала собираем множество bid книг, которые пройдут языковой фильтр
      const validBookIds = new Set();
      await streamInsertRows(available.book, (r) => {
        const bid = Number(r[0]);
        const title = String(r[3] || "").trim();
        const lang = String(r[5] || "").trim().toLowerCase();
        if (bid && title && lang && (lang === "ru" || lang === "en")) validBookIds.add(bid);
      });
      pushLog(`✓ recs: собрано ${validBookIds.size} книг для построения графа`);

      const bookRecsMap = new Map();
      if (available.recs) await safe("recs", async () => {
        importState.current = "Загрузка рекомендаций..."; pushLog("⚙ recs: построение графа со-рекомендаций (только ru/en)...");
        const userBooks = new Map();
        await streamInsertRows(available.recs, (r) => {
          const uid = Number(r[1]), bid = Number(r[2]);
          if (!uid || !bid || !validBookIds.has(bid)) return;
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
        validBookIds.clear();
      });
      pushLog(`✓ recs: граф готов (${bookRecsMap.size} книг с рекомендациями)`);
      step();

// ---- Вставка книг ----
      importState.current = "Вставка книг в БД..."; pushLog(importState.current);
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
        let n = 0;
        db.transaction((batch) => {
          for (const b of batch) {
            const info = insBook.run(b.id, b.bid, b.title, b.titleLow, b.author, b.authorLow, b.lang, b.year,
              JSON.stringify(b.formats.length > 0 ? b.formats : null), null, b.cover, null, new Date().toISOString());
            if (info.changes > 0) {
              n++;
              for (const g of b.genres) insGenre.run(b.id, g);
            }
          }
        })(pendingBookBatch);
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
        const year = r[6] != null && Number(r[6]) > 0 ? Number(r[6]) : null;
        // Пропускаем книги не на русском/английском и с пустым названием
        if (!bid || !title || !lang || (lang !== "ru" && lang !== "en")) return;
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

      // ---- Авторы и привязки ----
      importState.current = "Вставка авторов..."; pushLog(importState.current);
      const insAuthor = db.prepare(`INSERT OR IGNORE INTO authors (id,name,name_lower,pic) VALUES (?,?,?,?)`);
      const insBookAuthor = db.prepare(`INSERT OR IGNORE INTO book_authors (book_id,author_id,pos) VALUES (?,?,?)`);
      db.transaction(() => {
        for (const [aid, name] of authorMap) {
          const picPath = authorPicMap.get(aid);
          insAuthor.run(aid, name, name.toLowerCase(), picPath ? BASE + "/fb2/" + String(picPath).replace(/^\/+/, "") : null);
        }
      })();
      db.transaction(() => {
        for (const [bid, arr] of bookAuthorMap) {
          const bId = tag(bid);
          for (const a of arr) insBookAuthor.run(bId, a.aid, a.pos);
        }
      })();
      step();

      // ---- Циклы ----
      const insSeq = db.prepare(`INSERT OR IGNORE INTO sequences (id,name,name_lower) VALUES (?,?,?)`);
      const insBookSeq = db.prepare(`INSERT OR IGNORE INTO book_sequences (book_id,seq_id,number) VALUES (?,?,?)`);
      db.transaction(() => {
        for (const [sid, name] of seqNameMap) insSeq.run(sid, name, name.toLowerCase());
      })();
      db.transaction(() => {
        for (const [bid, arr] of bookSeqMap) for (const s of arr) insBookSeq.run(tag(bid), s.seqId, s.num);
      })();
      step();

// ---- Рейтинги ----
      const insRate = db.prepare(`INSERT OR REPLACE INTO book_ratings (book_id,rating,votes) VALUES (?,?,?)`);
      db.transaction(() => {
        for (const [bid, agg] of bookRatingMap) {
          insRate.run(tag(bid), +(agg.sum / agg.count).toFixed(2), agg.count);
        }
      })();
      step();

      // ---- Переводчики ----
      const insTr = db.prepare(`INSERT OR IGNORE INTO book_translators (book_id,translator_id,pos) VALUES (?,?,?)`);
      db.transaction(() => {
        for (const [bid, arr] of bookTranslatorMap) for (const t of arr) insTr.run(tag(bid), t.tid, t.pos);
      })();
      step();

      // ---- Похожие книги (топ N на книгу) ----
      const insRec = db.prepare(`INSERT OR IGNORE INTO book_recs (book_id,related_book_id) VALUES (?,?)`);
      if (bookRecsMap) db.transaction(() => {
        for (const [bid, relMap] of bookRecsMap) {
          const tops = Array.from(relMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40);
          for (const [rel] of tops) insRec.run(tag(bid), tag(rel));
        }
      })();
      step();

      // ---- Аннотации книг (опц.) ----
      if (available.bannots) await safe("bannots", async () => {
        importState.current = "Загрузка аннотаций..."; pushLog(importState.current);
        const updDesc = db.prepare(`UPDATE books SET description=? WHERE id=? AND (description IS NULL OR description='')`);
        let annBatch = [];
        let annFlushCount = 0;
        const flushAnn = () => {
          if (annBatch.length === 0) return;
          db.transaction((batch) => {
            for (const a of batch) if (a.desc) updDesc.run(a.desc, a.id);
          })(annBatch);
          annBatch = [];
          annFlushCount++;
          if (annFlushCount % 100 === 0) booksDb.persist();
        };
        await streamInsertRows(available.bannots, (r) => {
          const bid = Number(r[0]);
          if (!bid) return;
          annBatch.push({ id: tag(bid), title: String(r[2] || "").trim() || null, desc: stripHtml(r[3]) && stripHtml(r[3]).trim() || null });
          if (annBatch.length >= 400) flushAnn();
        });
        flushAnn();
      });
      step();

      booksDb.persist();
      const secs = ((Date.now() - startMs) / 1000).toFixed(1);
      const cnt = await booksDb.queryValue("SELECT COUNT(*) FROM books", [], 0);
      logger.info("flibusta.dump_import_done", { added: inserted, count: cnt, seconds: secs });
      importState.running = false;
      importState.current = "Готово"; pushLog("Импорт завершён");
    } catch (e) {
      importState.running = false;
      importState.error = (e && e.message) ? e.message : String(e);
      logger.error("flibusta.dump_import_error", { error: importState.error });
    } finally {
      booksDb.unref();
    }
  };
  asyncOp();
  return { ok: true };
}

module.exports = { runImport, status, getLogs, pushLog };