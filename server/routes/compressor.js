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

// --- Real-ESRGAN: статус и скачивание модели (ИИ-апскейл) ---
// realesrgan-ncnn-vulkan умеет только картинки, пайплайн сам разбирает видео
// на кадры. Бинарь не входит в поставку — пользователь качает одной кнопкой.
const REALESRGAN_URL =
  "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";
const REALESRGAN_MAX = 200 * 1024 * 1024;

let aiState = { downloading: false, progress: 0, error: "" };

router.get("/ai/status", (req, res) => {
  res.json({
    installed: !!engine.findRealesrgan(),
    downloading: aiState.downloading,
    progress: aiState.progress,
    error: aiState.error,
  });
});

router.post("/ai/download", (req, res) => {
  if (aiState.downloading) return res.status(409).json({ error: "already_downloading" });
  if (engine.findRealesrgan()) return res.json({ ok: true, installed: true });
  aiState = { downloading: true, progress: 0, error: "" };
  logger.action("compressor.ai.download");
  res.status(202).json({ ok: true, downloading: true });

  (async () => {
    try {
      fs.mkdirSync(path.join(DIRS.storage, "bin"), { recursive: true });
      const zipPath = path.join(DIRS.storage, "bin", "realesrgan.zip");
      const r = await fetch(REALESRGAN_URL, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const declared = Number(r.headers.get("content-length") || 0);
      if (declared > REALESRGAN_MAX) throw new Error("too_large");
      let received = 0;
      const ws = fs.createWriteStream(zipPath);
      for await (const chunk of r.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        aiState.progress = declared ? Math.min(99, Math.round((100 * received) / declared)) : 0;
        if (!ws.write(buf)) await new Promise((res2) => ws.once("drain", res2));
      }
      await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
      aiState.progress = 99;
      // Zip распаковывается adm-zip: exe + папка models кладутся в storage/bin.
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(path.join(DIRS.storage, "bin"), true);
      fs.rmSync(zipPath, { force: true });
      if (!engine.findRealesrgan()) throw new Error("exe_not_found_after_extract");
      aiState = { downloading: false, progress: 100, error: "" };
      logger.info("compressor.ai.installed", {});
    } catch (e) {
      aiState = { downloading: false, progress: 0, error: String(e.message || e) };
      logger.error("compressor.ai.download_failed", { error: aiState.error });
    }
  })();
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
      upHeight: String(req.body?.upHeight || "none"),
      aiModel: String(req.body?.aiModel || "realesr-animevideov3-x4"),
      gpuFirst: req.body?.gpuFirst === "true" || req.body?.gpuFirst === true,
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