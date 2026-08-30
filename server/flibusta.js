"use strict";

/**
 * Flibusta OPDS-клиент + локальный каталог книг (sql.js).
 *
 * Метаданные из OPDS-фида (https://opds.flibusta.is);
 * хранятся в SQLite-БД (books_catalog.db) с async lazy-load и TTL-выгрузкой.
 *
 * parseEntry/parseFeed — синхронные (чистый парсинг XML).
 * addBooks/catalogStats/searchCatalog — async (работа с БД).
 */

const path = require("path");
const { DIRS } = require("./config");
const booksDb = require("./books-db");
const logger = require("./logger");

const BASE = "https://opds.flibusta.is";

const FORMAT_MAP = {
  "application/fb2+zip": "fb2", "application/epub+zip": "epub",
  "application/x-mobipocket-ebook": "mobi", "application/pdf": "pdf",
  "application/html+zip": "html", "application/txt+zip": "txt",
  "application/rtf+zip": "rtf",
};

/* ------------------------------- HTTP -------------------------------- */

async function fetchFeed(pathname, { timeout = 30000 } = {}) {
  const url = BASE + pathname;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`OPDS HTTP ${res.status} for ${pathname}`);
  return res.text();
}

/* ------------------------------- Парсинг ------------------------------ */

function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

function parseBookId(xml) {
  const id = inner(xml, "id");
  const idStr = id ? id.trim() : "";
  const m = xml.match(/\/b\/(\d+)/);
  return { id: idStr, bid: m ? Number(m[1]) : null };
}

function parseGenres(xml) {
  const g = [];
  const re = /<category\s+term="([^"]*)"/gi;
  let m;
  while ((m = re.exec(xml))) g.push(decodeEntities(m[1]));
  return Array.from(new Set(g));
}

function parseFormats(xml) {
  const seen = new Set();
  const out = [];
  const re = /<link\s+([^>]*?(?:rel|href|type)="[^"]*"[^>]*?)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || "";
    const isRel = /rel="http:\/\/opds-spec\.org\/acquisition[^"]*"/.test(attrs);
    if (!isRel) continue;
    const typeM = attrs.match(/type="([^"]*)"/);
    const mime = typeM ? typeM[1].trim() : "";
    const fmt = FORMAT_MAP[mime];
    if (fmt && !seen.has(fmt)) { seen.add(fmt); out.push(fmt); }
  }
  return out;
}

function parseCover(xml) {
  const re1 = /<link\s+[^>]*href="([^"]+)"[^>]*rel="http:\/\/opds-spec\.org\/image"[^>]*\/?>/i;
  const m1 = re1.exec(xml);
  if (m1) return decodeEntities(m1[1]);
  const re2 = /<link\s+[^>]*rel="http:\/\/opds-spec\.org\/image"[^>]*href="([^"]+)"[^>]*\/?>/i;
  const m2 = re2.exec(xml);
  return m2 ? decodeEntities(m2[1]) : null;
}

function parseContentMeta(xml) {
  const c = inner(xml, "content");
  if (!c) return { language: null, year: null, sizeText: null };
  const decoded = decodeEntities(c);
  const langM = decoded.match(/Язык:\s*([^<]+)/i) || decoded.match(/language:\s*([^<]+)/i);
  const yearM = decoded.match(/Год издания:\s*(\d{4})/i) || decoded.match(/год:\s*(\d{4})/i) || decoded.match(/year:\s*(\d{4})/i);
  const sizeM = decoded.match(/Размер:\s*([^<]+)/i) || decoded.match(/size:\s*([^<]+)/i);
  return {
    language: langM ? langM[1].trim() : null,
    year: yearM ? Number(yearM[1]) : null,
    sizeText: sizeM ? sizeM[1].trim() : null,
  };
}

function parseDescription(xml) {
  const c = inner(xml, "content");
  if (!c) return "";
  const clean = decodeEntities(c).replace(/<[^>]*>/g, "").trim();
  const idx = clean.search(/(Формат:|Год издания:|Язык:|Размер:)/);
  return idx > 0 ? clean.slice(0, idx).trim() : clean;
}
/* ------------------------- Парсинг entry / feed ----------------------- */

function parseEntry(xml) {
  const { id, bid } = parseBookId(xml);
  if (!bid) return null;
  const title = decodeEntities((inner(xml, "title") || "").trim());
  const author = inner(xml, "author")
    ? decodeEntities((inner(xml, "author").match(/<name>([\s\S]*?)<\/name>/) || [,""])[1].trim())
    : "";
  const genres = parseGenres(xml);
  const formats = parseFormats(xml);
  if (!formats.length) return null;
  const { language, year, sizeText } = parseContentMeta(xml);
  const cover = parseCover(xml);
  const description = parseDescription(xml);
  const updated = (inner(xml, "updated") || "").trim();

  return {
    id: id || `book:${bid}`, bid, title, author, genres,
    language: language || "", year, formats, sizeText: sizeText || "",
    cover: cover || "", description, updatedAt: updated,
  };
}

function parseFeed(xml) {
  const books = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml))) {
    const book = parseEntry(m[0]);
    if (book) books.push(book);
  }
  // rel="next" может быть до и после href
  let next = null;
  const nextRe = /<link\s+[^>]*href="([^"]+)"[^>]*rel="next"[^>]*\/?>/i;
  const nextMatch = nextRe.exec(xml);
  if (nextMatch) {
    next = nextMatch[1];
  } else {
    const nextRe2 = /<link\s+[^>]*rel="next"[^>]*href="([^"]+)"[^>]*\/?>/i;
    const nextMatch2 = nextRe2.exec(xml);
    if (nextMatch2) next = nextMatch2[1];
  }
  return { books, next };
}

/* ------------------------- Локальный каталог (SQLite) ----------------- */

async function addBooks(list) {
  const db = await booksDb.getDb();
  let added = 0;
  const insBook = db.prepare(
    `INSERT OR IGNORE INTO books (id,bid,title,title_lower,author,author_lower,language,year,formats,sizeText,cover,description,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insGenre = db.prepare(
    `INSERT OR IGNORE INTO book_genres (book_id,genre) VALUES (?,?)`
  );
  db.run("BEGIN");
  for (const raw of list) {
    const book = {
      id: "", bid: 0, title: "", author: "", genres: [], language: "",
      year: null, formats: [], sizeText: "", cover: "", description: "",
      updatedAt: new Date().toISOString(),
      ...(raw || {}),
    };
    if (!book.id) continue;
    insBook.bind([
      book.id, book.bid, book.title, (book.title || "").toLowerCase(),
      book.author, (book.author || "").toLowerCase(),
      book.language || null, book.year || null,
      JSON.stringify(book.formats || []),
      book.sizeText || null, book.cover || null,
      book.description || null, book.updatedAt || null,
    ]);
    insBook.step();
    const changes = db.getRowsModified();
    insBook.reset();
    if (changes > 0) {
      added++;
      if (book.genres && Array.isArray(book.genres)) {
        for (const g of book.genres) {
          insGenre.bind([book.id, g]);
          insGenre.step();
          insGenre.reset();
        }
      }
    }
  }
  db.run("COMMIT");
  insBook.free();
  insGenre.free();
  return added;
}

async function catalogStats() {
  await booksDb.getDb();
  const count = await booksDb.queryValue("SELECT COUNT(*) FROM books", [], 0);
  const genreRows = await booksDb.queryAll("SELECT DISTINCT genre FROM book_genres ORDER BY genre");
  const genres = genreRows.map(r => r.genre).filter(Boolean);
  const langRows = await booksDb.queryAll(
    "SELECT DISTINCT language FROM books WHERE language IS NOT NULL AND language != '' ORDER BY language"
  );
  const langs = langRows.map(r => r.language).filter(Boolean);
  return { count, genres, langs };
}

async function searchCatalog({ q, genre, lang, yearFrom, yearTo, page = 1, pageSize = 40 } = {}) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(200, Math.max(1, Number(pageSize) || 40));

  const clauses = [];
  const params = [];

  if (q && String(q).trim()) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    clauses.push("(b.title_lower LIKE ? OR b.author_lower LIKE ?)");
    params.push(like, like);
  }
  if (genre && String(genre).trim()) {
    clauses.push("b.id IN (SELECT book_id FROM book_genres WHERE genre = ?)");
    params.push(String(genre).trim());
  }
  if (lang && String(lang).trim()) {
    clauses.push("b.language = ?");
    params.push(String(lang).trim());
  }
  if (yearFrom) {
    clauses.push("b.year >= ?");
    params.push(Number(yearFrom));
  }
  if (yearTo) {
    clauses.push("b.year <= ?");
    params.push(Number(yearTo));
  }

  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const offset = (page - 1) * pageSize;
  const total = await booksDb.queryValue(
    `SELECT COUNT(*) FROM books b ${where}`, params, 0
  );

  const sql = `SELECT b.*, GROUP_CONCAT(bg.genre, '||') AS genres_concat FROM books b
    LEFT JOIN book_genres bg ON b.id = bg.book_id
    ${where} GROUP BY b.id ORDER BY b.title COLLATE NOCASE LIMIT ? OFFSET ?`;
  const dataParams = [...params, pageSize, offset];
  const rows = await booksDb.queryAll(sql, dataParams);

  const items = rows.map(r => ({
    id: r.id || "",
    bid: r.bid || 0,
    title: r.title || "",
    author: r.author || "",
    genres: r.genres_concat ? r.genres_concat.split("||").filter(Boolean) : [],
    language: r.language || "",
    year: r.year || null,
    formats: r.formats ? JSON.parse(r.formats) : [],
    sizeText: r.sizeText || "",
    cover: r.cover || "",
    description: r.description || "",
    updatedAt: r.updatedAt || "",
  }));

  return { items, total, hasMore: offset + pageSize < total };
}
/* ------------------------- Живой OPDS-поиск --------------------------- */

async function opdsSearchBooks(q, page = 0) {
  const p = Number(page) || 0;
  const xml = await fetchFeed(`/opds/search/${encodeURIComponent(String(q).trim())}?page=${p}`, { timeout: 20000 });
  return parseFeed(xml);
}

/* ------------------------- Фоновый сбор (sync) ------------------------ */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let job = null;
let jobState = { running: false, mode: "", done: 0, total: 0, current: "", added: 0, error: "" };

function syncStatus() { return { ...jobState }; }

async function crawlNewPages() {
  jobState = { running: true, mode: "new", done: 0, total: 0, current: "получение списка", added: 0, error: "" };
  booksDb.ref();
  job = (async () => {
    try {
      let next = "/opds/new/0/new";
      let guard = 0;
      let persistCounter = 0;
      while (next && guard++ < 200) {
        const xml = await fetchFeed(next, { timeout: 40000 });
        const { books, next: n } = parseFeed(xml);
        const added = await addBooks(books);
        jobState.added += added;
        jobState.done = guard;
        persistCounter += added;
        if (persistCounter >= 50) { booksDb.persist(); persistCounter = 0; }
        await sleep(250);
        next = n;
      }
      booksDb.persist();
      jobState.running = false;
      logger.info("flibusta.sync_new_done", { added: jobState.added });
    } catch (e) {
      jobState.running = false;
      jobState.error = e.message;
      logger.error("flibusta.sync_new_error", { error: e.message });
    } finally {
      job = null;
      booksDb.unref();
    }
  })();
  return job;
}

/**
 * Извлечь ссылки на подкатегории из фида (ссылки вида /opds/genres/... с type="application/atom+xml").
 */
function extractSubCategoryLinks(xml) {
  const links = new Set();
  // <link> может иметь атрибуты в любом порядке, кавычки " или '
  const linkRe = /<link\s+([^>]*?)>/gi;
  let m;
  while ((m = linkRe.exec(xml))) {
    const attrs = m[1];
    const hrefM = attrs.match(/href\s*=\s*["'](\/opds\/genres\/[^"']*)["']/i);
    const typeM = attrs.match(/type\s*=\s*["'](application\/atom\+xml[^"']*)["']/i);
    if (hrefM && typeM) {
      let href = hrefM[1];
      if (!href.startsWith("/")) href = "/" + href;
      links.add(href);
    }
  }
  return Array.from(links);
}

/**
 * Рекурсивный обход жанрового дерева Flibusta.
 * Один уровень: парсит книги из фида, потом ищет подкатегории и заходит в них рекурсивно.
 */
async function crawlGenreRecursive(pathname, depth = 0) {
  if (depth > 5) return; // защита от бесконечной вложенности
  const feedXml = await fetchFeed(pathname, { timeout: 40000 });
  // Парсим книги из этого фида
  const { books, next } = parseFeed(feedXml);
  if (books.length > 0) {
    const added = await addBooks(books);
    jobState.added += added;
    // Пагинация по страницам книг внутри этой категории
    if (next) {
      let nextUrl = BASE + next;
      let guard = 0;
      while (nextUrl && guard++ < 200) {
        await sleep(250);
        const pageXml = await fetchFeed(nextUrl.replace(BASE, ""), { timeout: 40000 });
        const pageResult = parseFeed(pageXml);
        const pageAdded = await addBooks(pageResult.books);
        jobState.added += pageAdded;
        nextUrl = pageResult.next ? BASE + pageResult.next : null;
      }
    }
  }
  // Рекурсивно обходим подкатегории (если книг не было — значит это категория-контейнер)
  const subCategories = extractSubCategoryLinks(feedXml);
  for (const sub of subCategories) {
    if (jobState.error) break;
    await sleep(250);
    await crawlGenreRecursive(sub.replace(BASE, ""), depth + 1);
  }
}

async function crawlByGenres() {
  jobState = { running: true, mode: "genres", done: 0, total: 0, current: "получение списка жанров", added: 0, error: "" };
  booksDb.ref();
  job = (async () => {
    try {
      const rootXml = await fetchFeed("/opds/genres", { timeout: 40000 });
      logger.info("flibusta.genres_root_len", { len: rootXml.length });
      const genreLinks = [];
      const re = /<entry>([\s\S]*?)<\/entry>/gi;
      let m;
      while ((m = re.exec(rootXml))) {
        const linkM =
          m[1].match(/<link\s+[^>]*href="(\/opds\/genres\/[^"]*)"/i) ||
          m[1].match(/<link\s+[^>]*href='(\/opds\/genres\/[^']*)'/i);
        if (linkM) {
          let href = linkM[1];
          if (!href.startsWith("/")) href = "/" + href;
          genreLinks.push(href);
        }
      }
      logger.info("flibusta.genres_found", { count: genreLinks.length, sample: genreLinks.slice(0, 5) });
      jobState.total = genreLinks.length;
      for (const link of genreLinks) {
        if (jobState.error) break;
        jobState.current = decodeURIComponent(link.split("/").pop() || "");
        jobState.done++;
        try {
          await crawlGenreRecursive(link.replace(BASE, ""), 0);
        } catch (e) {
          const genreError = `жанр «${jobState.current}»: ${e.message}`;
          logger.warn("flibusta.genre_error", { genre: jobState.current, error: e.message });
          jobState.error = jobState.error
            ? jobState.error + "; " + genreError
            : genreError;
        }
        booksDb.persist();
      }
      jobState.running = false;
      const cnt = await booksDb.queryValue("SELECT COUNT(*) FROM books", [], 0);
      logger.info("flibusta.sync_genres_done", { added: jobState.added, count: cnt, errors: jobState.error || "none" });
    } catch (e) {
      jobState.running = false;
      jobState.error = e.message;
      logger.error("flibusta.sync_genres_error", { error: e.message });
    } finally {
      job = null;
      booksDb.unref();
    }
  })();
  return job;
}

function startSync(mode) {
  const m = mode === "genres" ? "genres" : "new";
  if (job) return { ok: false, reason: "already_running", status: syncStatus() };
  const p = m === "genres" ? crawlByGenres() : crawlNewPages();
  return { ok: true, status: syncStatus(), promise: p };
}

/* ------------------------- Скачивание книги --------------------------- */

async function downloadBook(bid, fmt, destDir = DIRS.downloads) {
  const fs = require("fs");
  const fmtNorm = String(fmt || "").trim().toLowerCase();
  if (!/^(fb2|epub|mobi|pdf|html|txt|rtf)$/.test(fmtNorm)) {
    throw new Error(`Неподдерживаемый формат: ${fmt || ""}`);
  }
  const url = `${BASE}/b/${Number(bid)}/${fmtNorm}`;
  const res = await fetch(url, {
    redirect: "follow", signal: AbortSignal.timeout(120000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Accept: "*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании книги`);

  const ext = fmtNorm === "fb2" ? "fb2" : fmtNorm;
  const name = `book_${bid}.${ext}`;
  const file = path.join(destDir, name);
  let received = 0;
  const ws = fs.createWriteStream(file);
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
    }
    ws.end();
  } catch (e) {
    try { ws.destroy(); fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  await new Promise((ok, bad) => ws.on("finish", ok).on("error", bad));
  logger.info("flibusta.book_downloaded", { bid, fmt: fmtNorm, size: received });
  return { file, name, size: received, fmt: fmtNorm, bid: Number(bid) };
}

function resetCatalog() { booksDb.reset(); }

module.exports = {
  BASE, parseFeed, parseEntry, addBooks, catalogStats, searchCatalog,
  opdsSearchBooks, startSync, syncStatus, downloadBook, resetCatalog,
};