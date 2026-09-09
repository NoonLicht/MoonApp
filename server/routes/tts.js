"use strict";

/**
 * API аудиокнижной TTS-студии (F5-TTS + Coqui XTTS v2).
 *
 *  GET    /api/tts/hardware        — GPU/VRAM (nvidia-smi) + «Optimal for Your PC»
 *  GET    /api/tts/presets         — системные + пользовательские пресеты
 *  POST   /api/tts/presets         — сохранить пользовательский пресет
 *  DELETE /api/tts/presets/:id     — удалить пользовательский пресет
 *  GET    /api/tts/profiles        — профили голоса
 *  POST   /api/tts/profiles        — сохранить профиль
 *  DELETE /api/tts/profiles/:id    — удалить профиль
 *  POST   /api/tts/reference       — загрузка референса (→ ref_* в storage/tts)
 *  POST   /api/tts/import-book     — .epub/.fb2/.pdf/.mobi/.rtf/.txt → главы
 *  POST   /api/tts/preview-chunks  — NLP-предпросмотр чанков (Batch Editor)
 *  POST   /api/tts                 — запуск задания { refFile, engine, chunks[], ... }
 *  GET    /api/tts/:id             — статус (stage/progress/chunkIndex/vram)
 *  GET    /api/tts/:id/download    — готовый mp3/wav/m4b
 *  POST   /api/tts/reveal          — показать файл в проводнике
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const engine = require("../tts");
const { DIRS } = require("../config");
const bookParser = require("../bookParser");
const logger = require("../logger");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.tts,
    filename: (req, file, cb) => {
      const base = path.basename(String(file.originalname || "file").replace(/[\\/:*?"<>|]+/g, "_"));
      cb(null, `up_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // книга может быть тяжёлой (pdf)
});

/* ------------------------- Железо ------------------------- */

router.get("/hardware", async (req, res) => {
  try { res.json(await engine.detectHardware()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------- Пресеты ------------------------- */

router.get("/presets", (req, res) => res.json(engine.listPresets()));
router.post("/presets", (req, res) => {
  try {
    const p = engine.saveUserPreset(req.body || {});
    logger.action("tts.preset.save", { id: p.id, name: p.name });
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete("/presets/:id", (req, res) => res.json({ ok: engine.deleteUserPreset(req.params.id) }));

/* ------------------------- Профили ------------------------- */

router.get("/profiles", (req, res) => res.json(engine.loadProfiles()));
router.post("/profiles", (req, res) => {
  try {
    const p = engine.saveProfile({ ...req.body, refFile: req.body?.refFile });
    logger.action("tts.profile.save", { id: p.id, name: p.name });
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete("/profiles/:id", (req, res) => res.json({ ok: engine.deleteProfile(req.params.id) }));

/* ------------------------- Референс ------------------------- */

router.post("/reference", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_reference" });
  // Приводим к формату ref_* (его валидируют профиль и задание).
  const ext = path.extname(req.file.originalname || "") || ".wav";
  const refName = `ref_${Date.now()}${ext}`;
  const finalPath = path.join(DIRS.tts, path.basename(refName));
  try { fs.renameSync(req.file.path, finalPath); } catch { fs.copyFileSync(req.file.path, finalPath); }
  res.status(201).json({ refFile: path.basename(finalPath), size: fs.statSync(finalPath).size });
});

/* ------------------------- Импорт книги ------------------------- */

router.post("/import-book", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const book = await bookParser.parseBook(req.file.path, req.file.originalname);
    try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
    if (!book.chapters.length) return res.status(422).json({ error: "no_text_in_book" });
    logger.action("tts.book.import", { name: req.file.originalname, chapters: book.chapters.length });
    res.json(book);
  } catch (e) {
    try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------- NLP-предпросмотр ------------------------- */

router.post("/preview-chunks", (req, res) => {
  try {
    const chunks = engine.previewChunks(
      String(req.body?.text || ""),
      req.body?.engine,
      {
        expandNumbers: req.body?.expandNumbers !== false,
        yoficate: req.body?.yoficate !== false,
        markStress: !!req.body?.markStress,
      }
    );
    res.json({ chunks });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ------------------------- Задание ------------------------- */

router.post("/", (req, res) => {
  try {
    const job = engine.startJob(req.body || {});
    logger.action("tts.start", { id: job.id, engine: job.engine, chunks: job.chunksTotal });
    const { items, ...rest } = job;
    res.status(201).json({ ...rest, items: undefined, chunksPreview: items.slice(0, 5) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const { items, ...rest } = job;
  res.json(rest);
});

router.get("/:id/download", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile)) return res.status(404).json({ error: "not_ready" });
  const safeName = `${String(job.opts.title || "audiobook").replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 60) || "audiobook"}.${job.opts.format}`;
  res.download(job.outFile, safeName);
});

router.post("/reveal", (req, res) => {
  try { res.json({ ok: engine.revealInExplorer(req.body?.path) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;

