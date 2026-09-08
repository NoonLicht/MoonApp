"use strict";

/**
 * API видеосжатия (rebuild 2.0).
 *
 *  POST /api/compressor            — multipart { file, ...params } → job
 *  GET  /api/compressor/hardware   — CPU/GPU/методы/рекомендация
 *  GET  /api/compressor/presets    — системные + пользовательские пресеты
 *  POST /api/compressor/presets    — сохранить пользовательский пресет
 *  DELETE /api/compressor/presets/:name — удалить пользовательский пресет
 *  GET  /api/compressor/:id        — статус задания
 *  GET  /api/compressor/:id/command — CLI-строка выполненной команды
 *  GET  /api/compressor/:id/download — скачивание результата
 *  GET  /api/compressor/:id/preview  — стриминг результата (сравнение)
 *  GET  /api/compressor/:id/reveal   — путь для «открыть в проводнике»
 *  DELETE /api/compressor/:id     — удалить задание и файлы
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const engine = require("../compressor");
const encoders = require("../encoders");
const settings = require("../settings");
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

// --- Пресеты: системные из движка + пользовательские из settings.json ---
function customPresets() {
  try {
    const raw = String(settings.get("compressor").customPresets || "");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === "string") : [];
  } catch { return []; }
}

function saveCustomPresets(list) {
  settings.set({ compressor: { customPresets: JSON.stringify(list.slice(0, 30)) } });
}

// --- Железо + матрица методов + рекомендация (кэшируется в encoders.js) ---
router.get("/hardware", async (req, res) => {
  try {
    const hw = await encoders.detectAll({ force: req.query.force === "1" });
    const rec = await encoders.recommend();
    res.json({
      ffmpeg: hw.ffmpeg,
      cpu: hw.cpu,
      gpus: hw.gpus,
      methods: hw.methods,
      recommended: rec,
      optimal: encoders.OPTIMAL,
      speedScales: encoders.SPEED_SCALES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/presets", (req, res) => {
  res.json({ system: engine.SYSTEM_PRESETS, custom: customPresets() });
});

router.post("/presets", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "missing_name" });
  const params = engine.normalizeParams(body);
  const list = customPresets().filter((p) => p.name !== name);
  list.push({ name, params, createdAt: Date.now() });
  saveCustomPresets(list);
  logger.action("compressor.preset.save", { name });
  res.status(201).json({ ok: true, custom: list });
});

router.delete("/presets/:name", (req, res) => {
  const name = String(req.params.name || "");
  const before = customPresets().length;
  saveCustomPresets(customPresets().filter((p) => p.name !== name));
  logger.action("compressor.preset.delete", { name });
  res.json({ ok: true, removed: before - customPresets().length });
});

// --- Быстрый probe выбранного файла: кодек/разрешение/длительность.
// Файл сразу удаляется — задание не создаётся.
router.post("/probe", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const { detectFfmpeg } = require("../convertEngine");
    const ff = await detectFfmpeg();
    if (!ff.found) throw new Error("ffmpeg_missing");
    const info = await engine.probeVideoInfo(ff.ffprobe, req.file.path);
    const duration = await engine.probeDuration(ff.ffprobe, req.file.path);
    res.json({ ...info, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
  }
});

// --- Старт задания ---
router.post("/", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const job = engine.startJob({
      inputPath: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      ...req.body,
    });
    logger.action("compressor.start", { id: job.id, name: job.name, size: job.size, engine: job.engine, codec: job.codec });
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

// CLI-строка выполненной команды (контекстное меню → «копировать команду»).
router.get("/:id/command", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({ command: job.command || "" });
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

// Абсолютный путь результата для «Reveal in File Explorer»
// (открывается через IPC shell.showItemInFolder, см. electron/main.js).
router.get("/:id/reveal", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile) return res.status(404).json({ error: "not_ready" });
  res.json({ path: job.outFile });
});

module.exports = router;

