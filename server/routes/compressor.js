"use strict";

/**
 * API видеосжатия.
 *
 *  POST /api/compressor          — multipart { file, crf, codec, targetHeight, aiUpscale, aiScale }
 *                                  → запускает 3-ступенчатый пайплайн, возвращает job
 *  GET  /api/compressor/:id      — статус задания (stage, progress, etaSec, aiSkipped...)
 *  GET  /api/compressor/:id/download — скачивание результата (видео)
 *  GET  /api/compressor/:id/preview  — стриминг результата в <video> (сравнение)
 *  DELETE /api/compressor/:id    — удалить задание и файлы (правый клик → Delete File)
 *
 * Превью исходника фронт берёт через blob из File API (файл уже на клиенте).
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const engine = require("../compressor");
const { DIRS } = require("../config");
const logger = require("../logger");

const router = express.Router();
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 ГБ

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.compressorIn,
    filename: (req, file, cb) => {
      const base = path.basename(String(file.originalname || "video").replace(/[\\/:*?"<>|]+/g, "_"));
      const ext = path.extname(base) || ".mp4";
      const stem = path.basename(base, ext).slice(0, 60) || "video";
      cb(null, `${Date.now()}_${stem}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

// Публичное представление задания: без путей к файлам на диске.
function view(job) {
  if (!job) return null;
  const { inputPath, outFile, ...rest } = job;
  return rest;
}

router.post("/", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const job = engine.startJob({
      inputPath: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      crf: Number(req.body?.crf ?? 22),
      codec: String(req.body?.codec || "av1"),
      targetHeight: String(req.body?.targetHeight || "original"),
      aiUpscale: req.body?.aiUpscale !== "false" && req.body?.aiUpscale !== false,
      aiScale: String(req.body?.aiScale || "2x"),
    });
    logger.action("compressor.start", { id: job.id, name: job.name, size: job.size });
    res.status(201).json(view(job));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(view(job));
});

router.get("/:id/download", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile)) return res.status(404).json({ error: "not_ready" });
  const ext = path.extname(job.outFile);
  res.download(job.outFile, (job.name || "video").replace(/\.[^.]+$/, "") + `_compressed${ext}`);
});

// Стриминг для плеера сравнения (Range-запросы Express обработает сам).
router.get("/:id/preview", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile)) return res.status(404).json({ error: "not_ready" });
  res.sendFile(job.outFile);
});

router.delete("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  try { if (job.outFile) fs.rmSync(job.outFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(job.inputPath, { force: true }); } catch { /* ignore */ }
  engine.jobs.delete(req.params.id);
  logger.action("compressor.delete", { id: req.params.id });
  res.json({ ok: true });
});

// М5: абсолютный путь результата для «Reveal in File Explorer»
// (открывается через IPC shell.showItemInFolder, см. electron/main.js).
router.get("/:id/reveal", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile) return res.status(404).json({ error: "not_ready" });
  res.json({ path: job.outFile });
});

module.exports = router;