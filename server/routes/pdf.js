"use strict";

/**
 * API PDF-тулкита.
 *
 *  POST /api/pdf/merge         — multipart files[] (2+) → PDF-файл
 *  POST /api/pdf/split         — multipart file + ranges="1-3,5,7-9" → zip
 *  POST /api/pdf/extract-text  — multipart file → { text, pages }
 */

const express = require("express");
const multer = require("multer");
const pdfTools = require("../pdfTools");

const router = express.Router();
const MAX_BYTES = 200 * 1024 * 1024; // 200 МБ на файл — с запасом для PDF
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

router.post("/merge", upload.array("files", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).json({ error: "need_at_least_two_files" });
    const merged = await pdfTools.mergePdfs(files.map((f) => f.buffer));
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="merged.pdf"');
    res.send(merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/split", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const ranges = String((req.body && req.body.ranges) || "").trim();
    if (!ranges) return res.status(400).json({ error: "missing_ranges" });
    const { zip } = await pdfTools.splitPdf(req.file.buffer, ranges);
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", 'attachment; filename="split.zip"');
    res.send(zip);
  } catch (e) {
    const status = e.message === "empty_ranges" || e.message === "no_valid_ranges" ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post("/extract-text", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const result = await pdfTools.extractText(req.file.buffer);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
