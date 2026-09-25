"use strict";

/**
 * API загрузки аудио/музыки.
 *
 *  GET    /api/music/search?q=...                  — поиск треков (через yt-dlp ytsearch:)
 *  POST   /api/music/download                      — { url, format?, quality? } → { id }
 *  GET    /api/music/status/:id                    — прогресс/готовность джобы
 *  GET    /api/music/download/:key                 — скачать готовый файл (один раз)
 *  GET    /api/music/formats                       — список поддерживаемых форматов/качеств
 *  GET    /api/music/playlists                     — список плейлистов
 *  POST   /api/music/playlists                     — { name } → создать плейлист
 *  DELETE /api/music/playlists/:id                  — удалить плейлист
 *  POST   /api/music/playlists/:id/tracks           — { track } → добавить трек
 *  DELETE /api/music/playlists/:id/tracks/:trackId   — убрать трек из плейлиста
 */

const express = require("express");
const ytdlp = require("../ytdlp");
const logger = require("../logger");
const playlists = require("../musicPlaylists");
// yt-dlp переименовывает скачанное в название трека (часто кириллица), а fs.rmSync
// такие пути на Windows молча не удаляет — файлы оставались бы в storage.
const { removePath } = require("../fsUtil");

const router = express.Router();

/**
 * Плейлисты — списки конкретных треков (метаданные + webpageUrl для повторного
 * скачивания), см. server/ts/musicPlaylists.ts.
 */
router.get("/playlists", (req, res) => {
  try {
    res.json(playlists.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/playlists", (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "missing_name" });
    res.status(201).json(playlists.create(name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/playlists/:id", (req, res) => {
  try {
    const ok = playlists.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/playlists/:id/tracks", (req, res) => {
  try {
    const pl = playlists.addTrack(req.params.id, req.body || {});
    if (!pl) return res.status(404).json({ error: "not_found" });
    res.status(201).json(pl);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/playlists/:id/tracks/:trackId", (req, res) => {
  try {
    const pl = playlists.removeTrack(req.params.id, req.params.trackId);
    if (!pl) return res.status(404).json({ error: "not_found" });
    res.json(pl);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const result = ytdlp.startAudioDownload({
      url,
      format: format || "mp3",
      quality: quality != null ? quality : 0,
      proxyUrl: req.proxyUrl,
    });
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
      try {
        removePath(entry.path);
      } catch {}
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
