"use strict";

/**
 * API загрузки аудио/музыки.
 *
 *  GET    /api/music/search?q=...         — поиск треков (через yt-dlp ytsearch:)
 *  POST   /api/music/download             — { url, format?, quality? } → { id }
 *  GET    /api/music/status/:id           — прогресс/готовность джобы
 *  GET    /api/music/download/:key        — скачать готовый файл (один раз)
 *  GET    /api/music/formats              — список поддерживаемых форматов/качеств
 */

const express = require("express");
const fs = require("fs");
const ytdlp = require("../ytdlp");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /api/music/search?q=...
 * Ищет треки через yt-dlp ytsearch: и возвращает список.
 */
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "missing_query" });
    const result = await ytdlp.searchTracks(q, 15, req.proxyUrl);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/music/download
 * Запускает скачивание аудио в выбранном формате/качестве.
 */
router.post("/download", async (req, res) => {
  try {
    const { url, format, quality } = req.body || {};
    if (!url) return res.status(400).json({ error: "missing_url" });
    const result = ytdlp.startAudioDownload({ url, format: format || "mp3", quality: quality != null ? quality : 0, proxyUrl: req.proxyUrl });
    logger.action("music.download.start", { id: result.id, url, format });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/music/status/:id
 * Статус и прогресс задачи скачивания.
 */
router.get("/status/:id", (req, res) => {
  try {
    res.json(ytdlp.jobStatus(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/music/download/:key
 * Скачивает готовый файл (одноразовый ключ).
 */
router.get("/download/:key", (req, res) => {
  try {
    const entry = ytdlp.getDownloadFile(req.params.key);
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.download(entry.path, entry.name, () => {
      try { fs.rmSync(entry.path, { force: true }); } catch {}
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/music/formats
 * Возвращает список доступных форматов и маппинг качеств.
 */
router.get("/formats", (req, res) => {
  res.json({
    formats: ytdlp.AUDIO_FORMATS,
    qualityMap: ytdlp.FORMAT_QUALITY_MAP,
  });
});

module.exports = router;