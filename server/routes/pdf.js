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
 *  POST /api/pdf/sign          — multipart file + signature (image) + page?/x?/y?/width? → PDF-файл
 *  POST /api/pdf/protect       — multipart file + password → PDF-файл (qpdf, 404 если не найден)
 *  POST /api/pdf/unlock        — multipart file + password → PDF-файл (qpdf)
 *  GET  /api/pdf/protect/status — { found, path } — есть ли qpdf
 *  POST /api/pdf/to-jpg        — multipart file + dpi? → zip PNG-страниц (PyMuPDF)
 *  GET  /api/pdf/ocr/status    — { python, fitz, paddleocr, gpu }
 *  POST /api/pdf/ocr/install   — { withOcr, device } → запуск тихой установки
 *  GET  /api/pdf/ocr/install   — прогресс установки
 *  POST /api/pdf/ocr           — multipart file + dpi?/lang?/device? → { text, pages }
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const pdfTools = require("../pdfTools");
const ocrEngine = require("../ocrEngine");
const pdfProtect = require("../pdfProtect");

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

router.post("/sign", upload.fields([{ name: "file", maxCount: 1 }, { name: "signature", maxCount: 1 }]), async (req, res) => {
  try {
    const file = req.files && req.files.file && req.files.file[0];
    const sig = req.files && req.files.signature && req.files.signature[0];
    if (!file || !sig) return res.status(400).json({ error: "missing_file_or_signature" });
    const b = req.body || {};
    const out = await pdfTools.signPdf(file.buffer, { buf: sig.buffer, mime: sig.mimetype }, {
      page: b.page ? parseInt(b.page, 10) : undefined,
      x: b.x ? parseFloat(b.x) : undefined,
      y: b.y ? parseFloat(b.y) : undefined,
      width: b.width ? parseFloat(b.width) : undefined,
    });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="signed.pdf"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/protect/status", async (_req, res) => {
  try {
    res.json(await pdfProtect.detectQpdf());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/protect", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const password = String((req.body && req.body.password) || "");
    const out = await pdfProtect.protectPdf(req.file.buffer, password);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="protected.pdf"');
    res.send(out);
  } catch (e) {
    const status = e.message === "qpdf_missing" ? 404 : e.message === "missing_password" ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post("/unlock", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const password = String((req.body && req.body.password) || "");
    const out = await pdfProtect.unlockPdf(req.file.buffer, password);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="unlocked.pdf"');
    res.send(out);
  } catch (e) {
    const status = e.message === "qpdf_missing" ? 404 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post("/to-jpg", upload.single("file"), async (req, res) => {
  let tmpPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const dpi = parseInt((req.body && req.body.dpi) || "200", 10);
    tmpPath = path.join(os.tmpdir(), `pdf2jpg-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmpPath, req.file.buffer);
    const pages = await ocrEngine.rasterizePdf(tmpPath, dpi);
    const zip = new AdmZip();
    pages.forEach((p, i) => zip.addLocalFile(p, "", `page_${i + 1}.png`));
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", 'attachment; filename="pages.zip"');
    res.send(zip.toBuffer());
    for (const p of pages) fs.rm(path.dirname(p), { recursive: true, force: true }, () => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => {});
  }
});

router.get("/ocr/status", async (_req, res) => {
  try {
    res.json(await ocrEngine.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/ocr/install", async (_req, res) => {
  try {
    res.json(await ocrEngine.installStatusFull());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/ocr/install", (req, res) => {
  try {
    const b = req.body || {};
    const st = ocrEngine.install(!!b.withOcr, b.device || "auto");
    res.json(st);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/ocr", upload.single("file"), async (req, res) => {
  let tmpPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const b = req.body || {};
    tmpPath = path.join(os.tmpdir(), `pdfocr-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmpPath, req.file.buffer);
    const result = await ocrEngine.ocrPdf(tmpPath, {
      dpi: b.dpi ? parseInt(b.dpi, 10) : undefined,
      lang: b.lang || undefined,
      device: b.device || undefined,
    });
    const text = result.pages.map((p) => p.text).join("\n\n").trim();
    res.json({ text, pages: result.pages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => {});
  }
});

module.exports = router;
