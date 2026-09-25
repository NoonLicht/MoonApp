"use strict";

/**
 * API OCR — распознавание текста с изображения.
 *
 *  POST /api/ocr/recognize   — multipart file (image) → { text, confidence }
 */

const express = require("express");
const multer = require("multer");
const { DIRS } = require("../config");
const { removePath } = require("../fsUtil");
const ocr = require("../ocr");

const router = express.Router();
const MAX_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({ destination: DIRS.tmp }),
  limits: { fileSize: MAX_BYTES },
});

router.post("/recognize", upload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const fs = require("fs");
    const buf = fs.readFileSync(req.file.path);
    const result = await ocr.recognize(buf);
    cleanup();
    res.json(result);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
