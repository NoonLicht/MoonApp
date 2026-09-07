"use strict";

/**
 * API F5-TTS студии (аудиокниги).
 *
 *  GET    /api/tts/engine          — доступность F5-TTS + дефолты из настроек
 *  GET    /api/tts/profiles        — список профилей голоса
 *  POST   /api/tts/profiles        — сохранить профиль { name, refPath, language, exaggeration, cfgWeight }
 *  DELETE /api/tts/profiles/:id    — удалить профиль
 *  POST   /api/tts                 — multipart { file (референс), text, language, exaggeration, cfgWeight, format }
 *                                  → запуск пайплайна (чанкинг → инференс → сшивка → нормализация)
 *  GET    /api/tts/:id             — статус (chunkIndex/chunksTotal, stage, progress)
 *  GET    /api/tts/:id/download    — готовый mp3/wav
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const engine = require("../tts");
const { DIRS } = require("../config");
const settings = require("../settings");
const logger = require("../logger");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.tts,
    filename: (req, file, cb) => {
      const base = path.basename(String(file.originalname || "voice").replace(/[\\/:*?"<>|]+/g, "_"));
      const ext = path.extname(base) || ".wav";
      cb(null, `ref_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // референс 5–10 сек, 50 МБ с запасом
});

router.get("/engine", async (req, res) => {
  const d = await engine.detect();
  const v = settings.get("voice") || {};
  res.json({
    ok: d.ok, error: d.error || "", python: !!d.python,
    defaults: {
      language: v.defaultLanguage, exaggeration: v.exaggeration, cfgWeight: v.cfgWeight,
      chunkSize: v.chunkSize, precision: v.precision, loudnessTarget: v.loudnessTarget,
    },
  });
});

router.get("/profiles", (req, res) => res.json(engine.loadProfiles()));

// Профиль: refFile — только имя ref_* файла, ранее загруженного на сервер
// (клиентский путь не принимается — защита от path injection, С1).
router.post("/profiles", (req, res) => {
  try {
    const p = engine.saveProfile({ ...req.body, refFile: req.body?.refFile });
    logger.action("tts.profile.save", { id: p.id, name: p.name });
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/profiles/:id", (req, res) => {
  res.json({ ok: engine.deleteProfile(req.params.id) });
});

// Загрузка референса отдельным шагом: файл попадает в storage/tts как ref_*,
// имя возвращается UI и дальше используется при генерации/сохранении профиля.
router.post("/reference", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_reference" });
  res.status(201).json({ refFile: path.basename(req.file.path), size: req.file.size });
});

router.post("/", (req, res) => {
  try {
    // С5: жёсткий лимит текста — 20k символов (~80-100 чанков) за один запрос.
    const text = String(req.body?.text || "").trim().slice(0, 20000);
    if (!text) return res.status(400).json({ error: "empty_text" });
    const job = engine.startJob({
      refPath: req.body?.refFile,
      text,
      language: req.body?.language,
      exaggeration: req.body?.exaggeration,
      cfgWeight: req.body?.cfgWeight,
      format: req.body?.format,
    });
    logger.action("tts.start", { id: job.id, chars: text.length });
    const { opts, ...rest } = job;
    res.status(201).json({ ...rest, opts: { ...opts, text: undefined } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Импорт книги .epub (М5): epub — это zip; adm-zip распаковывает, текст
// извлекается из (X)HTML-документов с вырезанием тегов.
router.post("/import-epub", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(req.file.path);
    let text = "";
    for (const e of zip.getEntries()) {
      if (!/\.(x?html)$/i.test(e.entryName)) continue;
      const html = e.getData().toString("utf8");
      text += "\n\n" + html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
        .replace(/<[^>]+>/g, "");
    }
    text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
    if (!text) return res.status(422).json({ error: "no_text_in_epub" });
    res.json({ text: text.slice(0, 600000) });
  } catch (e) {
    try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const { opts, ...rest } = job;
  res.json(rest);
});

router.get("/:id/download", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile)) return res.status(404).json({ error: "not_ready" });
  res.download(job.outFile, `audiobook.${job.opts.format}`);
});

module.exports = router;