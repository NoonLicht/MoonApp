"use strict";

/**
 * Книги без локального каталога: OPDS-фиды напрямую + избранное/закладки
 * в маленькой SQLite (books_meta.db, килобайты).
 */

const express = require("express");
const path = require("path");
const flibusta = require("../flibusta");
const { DIRS } = require("../config");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /api/books — список книг.
 * Параметры: list=new|popular|myfav|mybm, genre=<OPDS-путь>,
 *            q, authorQ, page (0-based), size (по умолчанию 80).
 * Если задан q/authorQ — поиск (жанр учитывается, если указан).
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(0, Number(req.query.page) || 0);
    const size = Math.min(120, Math.max(10, Number(req.query.size) || 80));
    const list = String(req.query.list || "new");
    const genre = String(req.query.genre || "");
    const q = String(req.query.q || "");
    const authorQ = String(req.query.authorQ || "");

    if (list === "myfav" || list === "mybm") {
      const items = flibusta.myBooks(list === "myfav" ? "fav" : "bm");
      return res.json({ items, hasMore: false, flags: {} });
    }

    let result;
    if (q.trim() || authorQ.trim()) {
      result = await flibusta.searchBooks({ q, authorQ, genre, page, size });
    } else if (genre) {
      result = await flibusta.genreBooks(genre, page, size);
    } else if (list === "popular") {
      result = await flibusta.popularBooks(page, size);
    } else {
      result = await flibusta.newBooks(page, size);
    }

    const bids = result.books.map((b) => b.bid);
    const flags = flibusta.myFlags(bids);
    res.json({ items: result.books, hasMore: !!result.hasMore, flags, popularFallback: !!result.popularFallback });
  } catch (e) {
    logger.error("books.request_failed", { error: e.message, url: req.originalUrl });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/books/genres — жанры OPDS (кэш 10 минут). */
router.get("/genres", async (req, res) => {
  try { res.json(await flibusta.listGenres()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/books/refresh — сбросить кэш фидов (кнопки «Обновить»). */
router.post("/refresh", (req, res) => {
  flibusta.clearFeedCache();
  logger.action("books.cache_refresh");
  res.json({ ok: true });
});

/** POST /api/books/toggle — избранное/закладка. body: { field: fav|bm, bid, book }. */
router.post("/toggle", (req, res) => {
  try {
    const field = req.body?.field === "bm" ? "bm" : "fav";
    const bid = Number(req.body?.bid);
    if (!Number.isFinite(bid) || !bid) return res.status(400).json({ error: "bid required" });
    const flags = flibusta.toggleMyBook(field, bid, req.body?.book || {});
    res.json(flags);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/books/my-flags?bids=1,2,3 — флаги для подсветки карточек. */
router.get("/my-flags", (req, res) => {
  try {
    const bids = String(req.query.bids || "").split(",").map(Number).filter(Boolean).slice(0, 500);
    res.json(flibusta.myFlags(bids));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/books/download — скачать книгу. body: { bid, fmt }. */
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

/** GET /api/books/file — отдать скачанный файл (безопасный, только имя). */
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

module.exports = router;