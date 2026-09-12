"use strict";

/**
 * API загрузки видео.
 *
 *  GET    /api/video/info?url=...          — метаданные + список форматов
 *  POST   /api/video/download              — { url, height, container, subs[], thumb? } → { id }
 *  GET    /api/video/status/:id            — прогресс/готовность джобы
 *  GET    /api/video/download/:key         — скачать готовый файл (один раз)
 *  GET    /api/video/install               — статус yt-dlp
 *  POST   /api/video/install/start         — тихая установка yt-dlp
 */

const express = require("express");
const fs = require("fs");
const ytdlp = require("../ytdlp");
const logger = require("../logger");

const router = express.Router();

router.get("/info", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "invalid_url" });
    const info = await ytdlp.fetchInfo(url);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/download", async (req, res) => {
  try {
    const { url, info, height, container, subs, thumb } = req.body || {};
    if (!url || !info) return res.status(400).json({ error: "missing_url" });
    const result = ytdlp.startDownload({ url, info, height, container, subs, thumb });
    logger.action("video.download.start", { id: result.id, url });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/:id", (req, res) => {
  res.json(ytdlp.jobStatus(req.params.id));
});

router.get("/download/:key", (req, res) => {
  const entry = ytdlp.getDownloadFile(req.params.key);
  if (!entry) return res.status(404).json({ error: "not_found" });
  res.download(entry.path, entry.name, () => {
    try { fs.rmSync(entry.path, { force: true }); } catch {}
  });
});

// Статус yt-dlp
router.get("/install", (req, res) => {
  try { res.json(ytdlp.installStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/install/start", (req, res) => {
  try { res.json(ytdlp.installYtDlp()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;