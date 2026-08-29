"use strict";

/**
 * Flibusta OPDS-клиент + локальный каталог книг.
 *
 * Источник данных: OPDS-каталог флибусты (https://opds.flibusta.is/opds).
 * Метаданные (библиографические) берутся из публичного OPDS-фида;
 * сами файлы книг скачиваются по одной по явному действию пользователя.
 *
 * Два режима работы:
 *  1) Живой OPDS-поиск — мгновенный доступ ко всей библиотеке без хранения.
 *  2) Локальный каталог — наполняется новинками и обходом по жанрам
 *     (фоновый джоб с прогрессом и resume). Нужен для широких фильтров
 *     (год / язык / жанр) по закешированному подмножеству.
 */

const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");

const BASE = "https://opds.flibusta.is";
const CATALOG_FILE = path.join(DIRS.storage, "books_catalog.json");

// Соответствие MIME-типа acquisition-ссылки -> расширение формата.
const MIME_TO_FMT = {
  "application/fb2+zip": "fb2",
  "application/epub+zip": "epub",
  "application/x-mobipocket-ebook": "mobi",
  "application/pdf": "pdf",
  "application/html+zip": "html",
  "application/txt+zip": "txt",
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
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Достать первый текст внутри тега (без атрибутов). tag может быть "dc:title".
function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

// Достать id книги из <id> и числовой bid из /b/{bid}
function parseBookId(xml) {
  const id = inner(xml, "id");
  const idStr = id ? id.trim() : "";
  const m = xml.match(/\/b\/(\d+)/);
  return { id: idStr, bid: m ? Number(m[1]) : null };
}

// Собрать все категории (жанры) из <category term="..."/>
function parseGenres(xml) {
  const g = [];
  const re = /<category\s+term="([^"]*)"/gi;
  let m;
  while ((m = re.exec(xml))) g.push(decodeEntities(m[1]));
  return Array.from(new Set(g));
}

// Собрать acquisition-ссылки на форматы. href вида /b/{bid}/{fmt}
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
    const hrefM = attrs.match(/href="([^"]*)"/);
    if (!typeM || !hrefM) continue;
    const fmt = MIME_TO_FMT[typeM[1].toLowerCase()] || null;
    if (!fmt) continue;
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    out.push({ fmt, href: hrefM[1] });
  }
  return out;
}

// Достать обложку (rel="http://opds-spec.org/image") — порядок атрибутов не важен.
function parseCover(xml) {
  const re = /<link\s+([^>]*?)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1] || "";
    if (/rel="http:\/\/opds-spec\.org\/image"/.test(a)) {
      const href = a.match(/href="([^"]*)"/);
      if (href) return href[1];
    }
  }
  return null;
}

// Аннотация и размер из <content type="text/html">…</content>
function parseContentText(xml) {
  const c = inner(xml, "content");
  if (!c) return { description: "", sizeText: "" };
  const text = decodeEntities(c)
    .replace(/<[^>]+>/g, " ")        // снять теги
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sizeM = c.match(/Размер:\s*([^</]+)/i);
  return {
    description: text,
    sizeText: sizeM ? decodeEntities(sizeM[1].trim()) : "",
  };
}

/** Разобрать один <entry> в объект книги. Вернёт null, если это не книга. */
function parseEntry(xml) {
  const { id, bid } = parseBookId(xml);
  if (!/^tag:book:/.test(id) || !bid) return null;
  const title = inner(xml, "title");
  const authorEl = inner(xml, "author");
  const authorMatch = authorEl ? authorEl.match(/<name>([\s\S]*?)<\/name>/i) : null;
  const yearRaw = inner(xml, "dc:issued");
  const year = yearRaw ? parseInt(String(yearRaw).trim(), 10) : null;
  const formats = parseFormats(xml);
  const { description, sizeText } = parseContentText(xml);
  return {
    id,
    bid,
    title: title ? decodeEntities(title.trim()) : "(без названия)",
    author: authorMatch ? decodeEntities(authorMatch[1].trim()) : "",
    genres: parseGenres(xml),
    language: (inner(xml, "dc:language") || "").trim() || null,
    year: Number.isFinite(year) ? year : null,
    formats: formats.map((f) => f.fmt),
    sizeText,
    cover: parseCover(xml),
    description: description.slice(0, 500),
    updatedAt: (inner(xml, "updated") || "").trim(),
  };
}

/** Разобрать весь фид: вернуть { books, next } где next — href rel=next (полный путь) или null. */
function parseFeed(xml) {
  const books = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml))) {
    const b = parseEntry(m[1]);
    if (b) books.push(b);
  }
  // Порядок атрибутов не важен: ищем link с rel="next"
  let next = null;
  const linkRe = /<link\s+([^>]*?)>/gi;
  let lm;
  while ((lm = linkRe.exec(xml))) {
    const a = lm[1] || "";
    if (/rel="next"/.test(a)) {
      const href = a.match(/href="([^"]*)"/);
      if (href) { next = href[1]; break; }
    }
  }
  if (next && !/^https?:/.test(next)) next = BASE + next;
  return { books, next };
}
/* --------------------------- Локальный каталог ------------------------ */

let cache = null; // { books: [], byId: Map<id,index>, lastSync: string }

function loadCatalog() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    const books = Array.isArray(raw.books) ? raw.books : [];
    const byId = new Map();
    for (let i = 0; i < books.length; i++) byId.set(books[i].id, i);
    cache = { books, byId, lastSync: raw.lastSync || null };
  } catch {
    cache = { books: [], byId: new Map(), lastSync: null };
  }
  return cache;
}

function saveCatalog() {
  const c = loadCatalog();
  const tmp = CATALOG_FILE + ".tmp";
  const payload = JSON.stringify({ lastSync: c.lastSync, books: c.books });
  try {
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, CATALOG_FILE);
  } catch (e) {
    try { fs.writeFileSync(CATALOG_FILE, payload, "utf8"); } catch { /* ignore */ }
    logger.warn("flibusta.catalog_save_fallback", { error: e.message });
  }
}

/** Добавить книги в каталог с дедупликацией по id. Возвращает число добавленных. */
function addBooks(list) {
  const c = loadCatalog();
  let added = 0;
  for (const b of list) {
    if (!b.id) continue;
    if (c.byId.has(b.id)) continue;
    c.byId.set(b.id, c.books.length);
    c.books.push(b);
    added++;
  }
  return added;
}

function catalogStats() {
  const c = loadCatalog();
  const genres = Array.from(new Set(c.books.flatMap((b) => b.genres || []))).sort();
  const langs = Array.from(new Set(c.books.map((b) => b.language).filter(Boolean))).sort();
  return {
    count: c.books.length,
    lastSync: c.lastSync,
    genres,
    langs,
  };
}

/* ------------------------- Серверный поиск ---------------------------- */

/**
 * Поиск/фильтры/пагинация по локальному каталогу.
 * Параметры: { q, genre, lang, yearFrom, yearTo, page, pageSize }
 */
function searchCatalog(params = {}) {
  const c = loadCatalog();
  const {
    q = "", genre = "", lang = "", yearFrom = "", yearTo = "",
    page = 1, pageSize = 40,
  } = params;
  const needle = String(q).trim().toLowerCase();
  const g = String(genre).trim().toLowerCase();
  const l = String(lang).trim().toLowerCase();
  const yF = String(yearFrom).trim() ? Number(yearFrom) : null;
  const yT = String(yearTo).trim() ? Number(yearTo) : null;

  let rows = c.books;
  if (needle) {
    rows = rows.filter((b) =>
      b.title.toLowerCase().includes(needle) ||
      (b.author || "").toLowerCase().includes(needle)
    );
  }
  if (g) rows = rows.filter((b) => (b.genres || []).some((x) => String(x).toLowerCase().includes(g)));
  if (l) rows = rows.filter((b) => (b.language || "").toLowerCase() === l);
  if (yF != null) rows = rows.filter((b) => b.year == null || b.year >= yF);
  if (yT != null) rows = rows.filter((b) => b.year == null || b.year <= yT);

  const total = rows.length;
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(200, Math.max(1, Number(pageSize) || 40));
  const start = (p - 1) * ps;
  const items = rows.slice(start, start + ps).map((b) => ({ ...b }));
  return { total, page: p, pageSize: ps, hasMore: start + ps < total, items };
}

/* --------------------------- Живой OPDS-поиск ------------------------- */

/**
 * Поиск по всей библиотеке через OPDS API (без хранения).
 * Возвращает страницу книг + инфо о доступности следующих страниц.
 */
async function opdsSearchBooks(query, page = 0) {
  const q = encodeURIComponent(String(query).trim());
  const suffix = page > 0 ? `&page=${page}` : "";
  const xml = await fetchFeed(`/opds/search?searchType=books&searchTerm=${q}${suffix}`);
  return parseFeed(xml);
}

/* ---------------------------- Фоновый джоб ---------------------------- */
/* Паттерн как winget.startIndexing: один запуск, прогресс, resume. */

let job = null;      // активный запущенный джоб (Promise) или null
let jobState = null; // { running, mode, done, total, current, added, error }

function syncStatus() {
  return { ...(jobState || { running: false, mode: "", done: 0, total: 0, current: "", added: 0, error: "" }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Обход новинок с пагинацией: наполняет каталог свежими поступлениями. */
function crawlNewPages() {
  if (job) return job;
  jobState = { running: true, mode: "new", done: 0, total: 0, current: "новинки", added: 0, error: "" };
  job = (async () => {
    try {
      let next = BASE + "/opds/new/0/new";
      let guard = 0;
      while (next && guard++ < 200) {
        const xml = await fetchFeed(next.replace(BASE, ""), { timeout: 40000 });
        const { books, next: n } = parseFeed(xml);
        jobState.added += addBooks(books);
        jobState.done++;
        const m = n && n.match(/\/opds\/new\/(\d+)/);
        jobState.total = m ? Number(m[1]) + 1 : jobState.done;
        saveCatalog();                        // инкрементальный кэш
        await sleep(350);                     // вежливый интервал
        next = n;
      }
      cache.lastSync = new Date().toISOString();
      saveCatalog();
      jobState.running = false;
      logger.info("flibusta.sync_new_done", { added: jobState.added, count: loadCatalog().books.length });
    } catch (e) {
      jobState.running = false;
      jobState.error = e.message;
      logger.error("flibusta.sync_new_error", { error: e.message });
    } finally {
      job = null;
    }
  })();
  return job;
}

/** Обход по жанрам: для каждого жанра проходим страницы его фида. */
function crawlByGenres() {
  if (job) return job;
  jobState = { running: true, mode: "genres", done: 0, total: 0, current: "получение списка жанров", added: 0, error: "" };
  job = (async () => {
    try {
      const rootXml = await fetchFeed("/opds/genres", { timeout: 40000 });
      const genreLinks = [];
      const re = /<entry>([\s\S]*?)<\/entry>/gi;
      let m;
      while ((m = re.exec(rootXml))) {
        const linkM = m[1].match(/<link\s+[^>]*href="(\/opds\/genres\/[^"]*)"/i);
        if (linkM) genreLinks.push(linkM[1]);
      }
      jobState.total = genreLinks.length;
      for (const link of genreLinks) {
        jobState.current = decodeURIComponent(link.split("/").pop() || "");
        let next = BASE + link;
        let guard = 0;
        while (next && guard++ < 400) {
          const feedXml = await fetchFeed(next.replace(BASE, ""), { timeout: 40000 });
          const { books, next: n } = parseFeed(feedXml);
          jobState.added += addBooks(books);
          await sleep(250);
          next = n;
        }
        jobState.done++;
        saveCatalog();
      }
      cache.lastSync = new Date().toISOString();
      saveCatalog();
      jobState.running = false;
      logger.info("flibusta.sync_genres_done", { added: jobState.added, count: loadCatalog().books.length });
    } catch (e) {
      jobState.running = false;
      jobState.error = e.message;
      logger.error("flibusta.sync_genres_error", { error: e.message });
    } finally {
      job = null;
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

/**
 * Скачивает файл книги с OPDS в storage/downloads.
 * bid — числовой id книги, fmt — формат (fb2|epub|mobi|pdf|...).
 */
async function downloadBook(bid, fmt, destDir = DIRS.downloads) {
  const fmtNorm = String(fmt || "").trim().toLowerCase();
  if (!/^(fb2|epub|mobi|pdf|html|txt|rtf)$/.test(fmtNorm)) {
    throw new Error(`Не поддерживаемый формат: ${fmt || ""}`);
  }
  const url = `${BASE}/b/${Number(bid)}/${fmtNorm}`;
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
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

/** Очистить каталог и кэш (полезно в тестах/при смене storage). */
function resetCatalog() {
  cache = { books: [], byId: new Map(), lastSync: null };
}

module.exports = {
  BASE,
  parseFeed,
  parseEntry,
  addBooks,
  loadCatalog,
  catalogStats,
  searchCatalog,
  opdsSearchBooks,
  startSync,
  syncStatus,
  downloadBook,
  resetCatalog,
};