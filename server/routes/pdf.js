"use strict";

/**
 * API PDF-тулкита.
 *
 *  POST /api/pdf/merge         — multipart files[] (2+) → PDF-файл
 *  POST /api/pdf/split         — multipart file + ranges="1-3,5,7-9" → zip
 *  POST /api/pdf/extract-text  — multipart file → { text, pages }
 *  POST /api/pdf/rotate        — multipart file + angle=90|180|270 → PDF-файл
 *  POST /api/pdf/organize      — multipart file + order="3,1,2" → PDF-файл
 *  POST /api/pdf/watermark     — multipart file + text + opacity? → PDF-файл
 *  POST /api/pdf/page-numbers  — multipart file + startAt? → PDF-файл
 *  POST /api/pdf/images-to-pdf — multipart files[] (JPG/PNG) → PDF-файл
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

router.post("/rotate", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const angle = parseInt((req.body && req.body.angle) || "90", 10);
    const out = await pdfTools.rotatePdf(req.file.buffer, angle);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="rotated.pdf"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/organize", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const order = String((req.body && req.body.order) || "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const out = await pdfTools.organizePdf(req.file.buffer, order);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="organized.pdf"');
    res.send(out);
  } catch (e) {
    const status = e.message === "empty_order" ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post("/watermark", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "missing_text" });
    const opacity = parseFloat((req.body && req.body.opacity) || "0.25");
    const out = await pdfTools.watermarkPdf(req.file.buffer, text, { opacity });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="watermarked.pdf"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/page-numbers", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const startAt = parseInt((req.body && req.body.startAt) || "1", 10);
    const out = await pdfTools.addPageNumbers(req.file.buffer, { startAt });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="numbered.pdf"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/images-to-pdf", upload.array("files", 100), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: "missing_files" });
    const out = await pdfTools.imagesToPdf(files.map((f) => ({ buf: f.buffer, mime: f.mimetype })));
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="images.pdf"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
