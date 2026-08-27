"use strict";

/**
 * API конвертации файлов.
 *
 *  GET    /api/convert/tools          — статус FFmpeg + каталог форматов
 *  POST   /api/convert               — multipart { file, to } → { key, name, size }
 *  GET    /api/convert/download/:key — скачивание результата (один раз)
 *
 * Всё локально: файл сохраняется во временную папку (storage/convert/in),
 * конвертируется FFmpeg'ом в storage/convert/out и отдаётся по ключу.
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { DIRS } = require("../config");
const engine = require("../convertEngine");
const logger = require("../logger");

const router = express.Router();
// key -> { file, name, size, at }; уезжают после отправки (download).
const results = new Map();

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 ГБ — защита от переполнения диска

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.convertIn,
    filename: (req, file, cb) => {
      const raw = String(file.originalname || "file").replace(/[\\/:*?"<>|]+/g, "_");
      const base = path.basename(raw) || "file";
      const ext = path.extname(base) || ".bin";
      const stem = path.basename(base, ext).slice(0, 60) || "file";
      cb(null, `${Date.now()}_${stem}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

router.get("/tools", async (req, res) => {
  try {
    res.json(await engine.tools());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Тихая установка FFmpeg (состояние + запуск) ---
router.get("/install", (req, res) => {
  try {
    res.json(engine.installStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/install/start", (req, res) => {
  try {
    res.json(engine.installFfmpeg());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", upload.single("file"), async (req, res) => {
  const cleanupInput = () => {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.rmSync(req.file.path, { force: true }); } catch { /* ignore */ }
    }
  };

  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });

    const to = String((req.body && req.body.to) || "").toLowerCase().replace(/^\./, "");
    const cat = engine.categoryOf(req.file.originalname);

    if (!to || !cat) {
      cleanupInput();
      return res.status(400).json({ error: !to ? "missing_target_format" : "unsupported_source" });
    }
    if (!cat.outputs.includes(to)) {
      cleanupInput();
      return res.status(400).json({ error: "unsupported_target" });
    }

    const outFile = path.join(DIRS.convertOut, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${to}`);
    const { size } = await engine.convert({ inputPath: req.file.path, to, outPath: outFile });
    cleanupInput();

    const stem = path.basename(req.file.originalname, path.extname(req.file.originalname)) || "converted";
    const key = crypto.randomBytes(8).toString("hex");
    const name = `${stem}.${to}`;
    results.set(key, { file: outFile, name, size, at: Date.now() });

    logger.info("convert.result", { key, name, size });
    res.status(201).json({ key, name, size, category: cat.id, to });
  } catch (e) {
    cleanupInput();
    logger.error("convert.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Результат отдаётся один раз: после отправки файл удаляется, ключ аннулируется.
router.get("/download/:key", (req, res) => {
  const entry = results.get(req.params.key);
  if (!entry) return res.status(404).json({ error: "not_found" });

  res.download(entry.file, entry.name, () => {
    try { fs.rmSync(entry.file, { force: true }); } catch { /* ignore */ }
    results.delete(req.params.key);
  });
});

module.exports = router;