/**
 * API OCR — распознавание текста с изображения.
 *
 *  POST /api/ocr/recognize   — multipart file (image) → { text, confidence }
 */

import express from "express";
import multer from "multer";
import __m____config from "../config";
const { DIRS } = __m____config;
import { removePath } from "../fsUtil";
import * as ocr from "../ocr";

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
    const fs = require("fs") as typeof import("fs");
    const buf = fs.readFileSync(req.file.path);
    const result = await ocr.recognize(buf);
    cleanup();
    res.json(result);
  } catch (e: any) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

export = router;
