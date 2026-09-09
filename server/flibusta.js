"use strict";

/**
 * Flibusta OPDS-клиент (без локального каталога).
 *
 * Всё берётся напрямую из OPDS-фида:
 *   - новинки:    /opds/new/{page}/new   (20 книг на страницу OPDS)
 *   - поиск:      /opds/search/{q}?page={N}
 *   - жанры:      /opds/newgenres (+ вложенные фиды /opds/genres/...)
 *   - скачивание: /b/{bid}/{fmt}
 *
 * Популярного по рейтингу в OPDS нет (проверено) — пока честный фолбэк
 * на новинки (см. popularBooks); источник рейтинга подключим позже.
 *
 * Локально хранятся только избранное/закладки (books_meta.db, килобайты).
 */

const path = require("path");
const fs = require("fs");
const { DIRS } = require("./config");
const logger = require("./logger");

const BASE = "https://opds.flibusta.is";

const FORMAT_MAP = {
  "application/fb2+zip": "fb2", "application/epub+zip": "epub",
  "application/x-mobipocket-ebook": "mobi", "application/pdf": "pdf",
  "application/html+zip": "html", "application/txt+zip": "txt",
  "application/rtf+zip": "rtf",
};

/* ------------------------------- HTTP -------------------------------- */

async function fetchFeed(pathname, { timeout = 20000 } = {}) {
  const url = pathname.startsWith("http") ? pathname : BASE + pathname;
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
  const m1 = /<link\s+[^>]*href="([^"]+)"[^>]*rel="http:\/\/opds-spec\.org\/image"[^>]*\/?>/i.exec(xml);
  if (m1) return decodeEntities(m1[1]);
  const m2 = /<link\s+[^>]*rel="http:\/\/opds-spec\.org\/image"[^>]*href="([^"]+)"[^>]*\/?>/i.exec(xml);
  return m2 ? decodeEntities(m2[1]) : null;
}

function parseContentMeta(xml) {
  const c = inner(xml, "content");
  if (!c) return { language: null, year: null, sizeText: null };
  const decoded = decodeEntities(c);
  const langM = decoded.match(/Язык:\s*([^<,]+)/i) || decoded.match(/language:\s*([^<,]+)/i);
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

function parseEntry(xml) {
  const { id, bid } = parseBookId(xml);
  if (!bid) return null;
  const title = decodeEntities((inner(xml, "title") || "").trim());
  const author = inner(xml, "author")
    ? decodeEntities((inner(xml, "author").match(/<name>([\s\S]*?)<\/name>/) || [, ""])[1].trim())
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
  let next = null;
  const nm = /<link\s+[^>]*href="([^"]+)"[^>]*rel="next"[^>]*\/?>/i.exec(xml)
    || /<link\s+[^>]*rel="next"[^>]*href="([^"]+)"[^>]*\/?>/i.exec(xml);
  if (nm) next = nm[1];
  return { books, next };
}

/** Навигационные записи фида (жанры/категории): [{ title, href }]. */
function parseNavEntries(xml) {
  const out = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml))) {
    const e = m[0];
    const title = decodeEntities((inner(e, "title") || "").trim());
    const lm = e.match(/<link\s+[^>]*href="([^"]+)"[^>]*type="application\/atom\+xml[^"]*"[^>]*\/?>/i)
      || e.match(/<link\s+[^>]*type="application\/atom\+xml[^"]*"[^>]*href="([^"]+)"[^>]*\/?>/i)
      || e.match(/<link\s+[^>]*href="([^"]+)"[^>]*rel="subsection"[^>]*\/?>/i)
      || e.match(/<link\s+[^>]*rel="subsection"[^>]*href="([^"]+)"[^>]*\/?>/i);
    if (title && lm) {
      let href = decodeEntities(lm[1]);
      if (!href.startsWith("/")) href = "/" + href;
      out.push({ title, href });
    }
  }
  return out;
}
/* ------------------------- Кэш фидов (TTL, RAM) ----------------------- */

const feedCache = new Map(); // key -> { ts, data }
const TTL = 10 * 60 * 1000;

function cacheGet(key) {
  const hit = feedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL) { feedCache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) { feedCache.set(key, { ts: Date.now(), data }); }
function clearFeedCache() { feedCache.clear(); genresDeepCache = null; }

function slicePage(all, page, size) {
  const start = page * size;
  return { books: all.slice(start, start + size), hasMore: start + size < all.length };
}

/**
 * Агрегатор: собирает книги из OPDS-фида (по 20 на страницу OPDS),
 * пока не наберётся size*(page+1) штук. Возвращает { books, hasMore }.
 */
async function aggregateFeed(basePath, page, size = 80) {
  const p = Math.max(0, Number(page) || 0);
  const key = `agg:${basePath}:${p}:${size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const want = size * (p + 1);
  const acc = [];
  const seen = new Set();
  let cursor = basePath;
  let guard = 0;
  while (cursor && guard++ < 40) {
    const xml = await fetchFeed(cursor);
    const { books, next } = parseFeed(xml);
    for (const b of books) if (!seen.has(b.bid)) { seen.add(b.bid); acc.push(b); }
    if (acc.length >= want) break;
    cursor = next || null;
  }
  const out = slicePage(acc, p, size);
  cacheSet(key, out);
  return out;
}

/** Новинки. */
async function newBooks(page = 0, size = 80) {
  return aggregateFeed("/opds/new/0/new", page, size);
}

/**
 * Популярное по рейтингу: в OPDS такого фида нет, берём HTML-страницу
 * «Популярные книги» (/stat/b) с зеркал Flibusta. Автор и название есть
 * в разметке; язык не указан (badge не показываем). При недоступности
 * всех зеркал — честный фолбэк на новинки (флаг popularFallback).
 */
const MIRRORS = ["https://r.flibusta.is", "https://flibusta.is", "https://flibusta.site"];

async function fetchWithTimeout(url, timeout) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Разбор страницы /stat/b: <li><a href="/a/N">Автор</a> - <a href="/b/N">Название</a></li> */
function parseStatBooks(html) {
  const out = [];
  const re = /<li>\s*<a[^>]*href="\/a\/\d+"[^>]*>([\s\S]*?)<\/a>\s*-\s*<a[^>]*href="\/b\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const author = decodeEntities(m[1].replace(/<[^>]*>/g, "").trim());
    const bid = Number(m[2]);
    const title = decodeEntities(m[3].replace(/<[^>]*>/g, "").trim());
    if (bid && title) out.push({
      id: `book:${bid}`, bid, title, author, genres: [],
      language: "", year: null, formats: ["fb2", "epub", "mobi"],
      sizeText: "", cover: "", description: "", updatedAt: "",
    });
  }
  return out;
}

async function popularBooks(page = 0, size = 80) {
  const p = Math.max(0, Number(page) || 0);
  const key = `pop:${p}:${size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const want = size * (p + 1);
  const acc = [];
  const seen = new Set();
  let lastError = null;

  outer:
  for (const mirror of MIRRORS) {
    try {
      // проверяем доступность зеркала первой страницей
      let opdsPage = p;
      let guard = 0;
      while (acc.length < want && guard++ < 4) {
        const qs = opdsPage > 0 ? `?page=${opdsPage}` : "";
        const html = await fetchWithTimeout(`${mirror}/stat/b${qs}`, 12000);
        const pageBooks = parseStatBooks(html);
        for (const b of pageBooks) {
          if (!seen.has(b.bid)) { seen.add(b.bid); acc.push(b); }
        }
        if (acc.length >= want || pageBooks.length === 0) break;
        opdsPage++;
      }
      if (acc.length > 0) break outer;
    } catch (e) {
      lastError = e;
    }
  }

  if (acc.length > 0) {
    const out = slicePage(acc, p, size);
    cacheSet(key, out);
    return out;
  }

  logger.warn("flibusta.popular_fallback", { error: lastError && lastError.message });
  const fb = await newBooks(p, size);
  return { ...fb, popularFallback: true };
}

/** Список жанров из /opds/newgenres: [{ title, href }]. */
async function listGenresFlat() {
  const key = "genres";
  const cached = cacheGet(key);
  if (cached) return cached;
  const xml = await fetchFeed("/opds/newgenres");
  const genres = parseNavEntries(xml);
  const out = { genres };
  cacheSet(key, out);
  return out;
}

/**
 * Все жанры Flibusta: рекурсивный обход дерева /opds/genres.
 * Лист = ссылка вида /opds/genres/<...>/<число> (фид с книгами).
 * title собирается как "Категория / Подкатегория / Жанр".
 * Кэш на 24 часа (обход — сотни запросов).
 */
const GENRES_TTL = 24 * 60 * 60 * 1000;
let genresDeepCache = null;

async function pool(jobs, size = 4) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < jobs.length) {
      const idx = i++;
      try { results[idx] = await jobs[idx](); } catch { results[idx] = null; }
    }
  }));
  return results;
}

async function listGenres() {
  if (genresDeepCache && Date.now() - genresDeepCache.ts < GENRES_TTL) {
    return { genres: genresDeepCache.genres };
  }
  const root = await fetchFeed("/opds/genres");
  const out = [];
  const seen = new Set();

  async function walk(href, prefix, depth) {
    if (depth > 3 || seen.size > 1500) return;
    const xml = await fetchFeed(href, { timeout: 25000 });
    const nav = parseNavEntries(xml);
    const jobs = [];
    for (const n of nav) {
      if (seen.has(n.href)) continue;
      seen.add(n.href);
      if (/\/\d+$/.test(n.href)) {
        // Листовой жанр
        out.push({ title: prefix ? `${prefix} / ${n.title}` : n.title, href: n.href });
      } else {
        // Контейнер — рекурсия
        const p = prefix ? `${prefix} / ${n.title}` : n.title;
        jobs.push(() => walk(n.href, p, depth + 1));
      }
    }
    await pool(jobs, 4);
  }

  const roots = parseNavEntries(root);
  const jobs = roots.map((r) => () => walk(r.href, r.title, 1));
  await pool(jobs, 4);

  genresDeepCache = { ts: Date.now(), genres: out };
  return { genres: out };
}

/** Книги жанра по пути фида (/opds/genres/... или /opds/genrenew/...). */
async function genreBooks(genrePath, page = 0, size = 80) {
  const p = decodeURIComponent(String(genrePath || ""));
  if (!p.startsWith("/opds/")) throw new Error("bad genre path");
  return aggregateFeed(p, page, size);
}

/**
 * Поиск: если задан жанр — ищем внутри жанрового фида (агрегируем и фильтруем
 * по подстрокам), иначе — /opds/search/{q} с агрегацией страниц.
 */
async function searchBooks({ q, authorQ, genre, page = 0, size = 80 } = {}) {
  const p = Math.max(0, Number(page) || 0);
  const title = String(q || "").trim().toLowerCase();
  const author = String(authorQ || "").trim().toLowerCase();

  if (genre) {
    const acc = [];
    const seen = new Set();
    let cursor = genre;
    let guard = 0;
    const want = size * (p + 1) * 2; // с запасом — фильтр режет список
    while (cursor && guard++ < 60 && acc.length < want) {
      const xml = await fetchFeed(cursor);
      const { books, next } = parseFeed(xml);
      for (const b of books) {
        if (seen.has(b.bid)) continue;
        seen.add(b.bid);
        const okT = !title || (b.title || "").toLowerCase().includes(title);
        const okA = !author || (b.author || "").toLowerCase().includes(author);
        if (okT && okA) acc.push(b);
      }
      cursor = next || null;
    }
    return slicePage(acc, p, size);
  }

  const term = [title, author].filter(Boolean).join(" ");
  if (!term) return { books: [], hasMore: false };
  const key = `srch:${term.toLowerCase()}:${p}:${size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const acc = [];
  const seen = new Set();
  let cursor = `/opds/search?searchType=books&searchTerm=${encodeURIComponent(term)}`;
  let guard = 0;
  // Поиск у Flibusta медленный (страница может готовиться 10-25 с): длинный
  // таймаут на страницу, минимум страниц, частичный результат при сбое.
  while (cursor && guard++ < 5) {
    try {
      const xml = await fetchFeed(cursor, { timeout: 30000 });
      const { books, next } = parseFeed(xml);
      for (const b of books) if (!seen.has(b.bid)) { seen.add(b.bid); acc.push(b); }
      if (acc.length >= size * (p + 1)) break;
      cursor = next || null;
    } catch (e) {
      logger.warn("flibusta.search_page_error", { error: e.message, page: guard });
      break; // отдаём что успели собрать
    }
  }
  const out = slicePage(acc, p, size);
  cacheSet(key, out);
  return out;
}
/* ------------------------- Скачивание книги --------------------------- */

async function downloadBook(bid, fmt, destDir = DIRS.downloads) {
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

  const name = `book_${Number(bid)}.${fmtNorm}`;
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

/* --------------------- Избранное / закладки (SQLite) ------------------ */

const Database = require("better-sqlite3");
const META_PATH = path.join(DIRS.storage, "books_meta.db");
let _meta = null;

function metaDb() {
  if (_meta) return _meta;
  _meta = new Database(META_PATH);
  _meta.pragma("journal_mode = WAL");
  _meta.exec(`
    CREATE TABLE IF NOT EXISTS my_books (
      bid INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      fav INTEGER NOT NULL DEFAULT 0,
      bm INTEGER NOT NULL DEFAULT 0,
      addedAt TEXT NOT NULL
    );
  `);
  return _meta;
}

/** Переключить флаг (fav — избранное, bm — закладка). Возвращает актуальные флаги. */
function toggleMyBook(field, bid, book) {
  const db = metaDb();
  const row = db.prepare("SELECT fav, bm FROM my_books WHERE bid = ?").get(Number(bid));
  const cur = row ? (field === "fav" ? row.fav : row.bm) : 0;
  const val = cur ? 0 : 1;
  if (row) {
    db.prepare(`UPDATE my_books SET ${field} = ?, data = ? WHERE bid = ?`)
      .run(val, JSON.stringify(book || {}), Number(bid));
  } else {
    db.prepare("INSERT INTO my_books (bid, data, fav, bm, addedAt) VALUES (?,?,?,?,?)")
      .run(Number(bid), JSON.stringify(book || {}), field === "fav" ? 1 : 0, field === "bm" ? 1 : 0,
        new Date().toISOString());
  }
  db.prepare("DELETE FROM my_books WHERE fav = 0 AND bm = 0").run();
  const after = db.prepare("SELECT fav, bm FROM my_books WHERE bid = ?").get(Number(bid)) || { fav: 0, bm: 0 };
  return { fav: !!after.fav, bm: !!after.bm };
}

/** Список отмеченных книг (filter: all | fav | bm), полные данные из JSON. */
function myBooks(filter = "all") {
  const db = metaDb();
  const where = filter === "fav" ? "WHERE fav = 1" : filter === "bm" ? "WHERE bm = 1" : "";
  const rows = db.prepare(`SELECT bid, data, fav, bm, addedAt FROM my_books ${where} ORDER BY addedAt DESC`).all();
  return rows.map((r) => ({
    ...(JSON.parse(r.data || "{}")),
    bid: r.bid,
    fav: !!r.fav,
    bm: !!r.bm,
    addedAt: r.addedAt,
  }));
}

/** Флаги для списка bid (для подсветки карточек). */
function myFlags(bids) {
  const db = metaDb();
  const out = {};
  const st = db.prepare("SELECT fav, bm FROM my_books WHERE bid = ?");
  for (const bid of bids) {
    const r = st.get(Number(bid));
    if (r) out[bid] = { fav: !!r.fav, bm: !!r.bm };
  }
  return out;
}

/** Одноразовая чистка легаси-каталога: books_catalog.db больше не нужен. */
function legacyCleanup() {
  const old = path.join(DIRS.storage, "books_catalog.db");
  for (const f of [old, old + "-wal", old + "-shm", old + ".tmp"]) {
    try {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); logger.info("flibusta.legacy_removed", { file: f }); }
    } catch { }
  }
}
legacyCleanup();

module.exports = {
  BASE, parseFeed, parseEntry, parseNavEntries,
  newBooks, popularBooks, listGenres, genreBooks, searchBooks,
  downloadBook, toggleMyBook, myBooks, myFlags, clearFeedCache,
};
