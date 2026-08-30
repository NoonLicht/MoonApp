"use strict";

const express = require("express");
const path = require("path");
const flibusta = require("../flibusta");
const dumpImport = require("../flibusta-dump-import");
const { DIRS } = require("../config");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /api/books — поиск/фильтры/пагинация по локальному каталогу.
 * Параметры: q, genre, lang, yearFrom, yearTo, page, pageSize.
 */
router.get("/", async (req, res) => {
  try {
    const [stats, searchResult] = await Promise.all([
      flibusta.catalogStats(),
      flibusta.searchCatalog(req.query),
    ]);
    res.json({ ...searchResult, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/books/facets — доступные для фильтров жанры/языки/счётчик. */
router.get("/facets", async (req, res) => {
  try { res.json(await flibusta.catalogStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/books/sync — запустить фоновый сбор каталога (mode: new|genres). */
router.post("/sync", (req, res) => {
  try {
    const mode = req.body?.mode || "new";
    logger.action("flibusta.sync_start", { mode });
    res.json(flibusta.startSync(mode));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/books/sync — статус фонового сбора. */
router.get("/sync", (req, res) => {
  try { res.json(flibusta.syncStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/books/live-search — мгновенный поиск по всей библиотеке через OPDS
 * (без хранения в каталоге). body: { q, page? }.
 */
router.post("/live-search", async (req, res) => {
  const q = String(req.body?.q || "").trim();
  const page = Number(req.body?.page) || 0;
  if (!q) return res.json({ books: [], next: null });
  try {
    const { books, next } = await flibusta.opdsSearchBooks(q, page);
    res.json({ books, next });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/books/download — скачать одну книгу. body: { bid, fmt }.
 * Сохраняет файл в storage/downloads и возвращает путь/имя/размер.
 */
router.post("/download", async (req, res) => {
  const bid = Number(req.body?.bid);
  const fmt = String(req.body?.fmt || "fb2").toLowerCase();
  if (!Number.isFinite(bid) || !bid) return res.status(400).json({ error: "bid required" });
  try {
    logger.action("flibusta.book_download", { bid, fmt });
    const result = await flibusta.downloadBook(bid, fmt, DIRS.downloads);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/books/file — отдать скачанный файл (безопасный, относительный путь). */
router.get("/file", (req, res) => {
  try {
    const rel = String(req.query.path || "").replace(/^[\\/]+/, "");
    if (!rel) return res.status(400).json({ error: "path required" });
    const file = path.join(DIRS.downloads, path.basename(rel));
    const ext = path.extname(file).toLowerCase();
    const types = {
      ".fb2": "application/xml", ".epub": "application/epub+zip",
      ".mobi": "application/x-mobipocket-ebook", ".pdf": "application/pdf",
      ".txt": "text/plain", ".html": "text/html", ".rtf": "application/rtf",
    };
    res.type(types[ext] || "application/octet-stream");
    res.sendFile(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/books/reset-catalog — очистить локальный каталог и удалить БД. */
router.post("/reset-catalog", (req, res) => {
  try {
    flibusta.resetCatalog();
    logger.action("flibusta.catalog_reset");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/books/import-dumps — запустить импорт из MySQL-дампов. */
router.post("/import-dumps", (req, res) => {
  try {
    logger.action("flibusta.dump_import_start");
    res.json(dumpImport.runImport());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/books/import-dumps — статус импорта. */
router.get("/import-dumps", (req, res) => {
  try { res.json(dumpImport.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;