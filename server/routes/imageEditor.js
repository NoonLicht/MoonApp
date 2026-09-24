"use strict";

/**
 * API редактора изображений (кроп/ресайз/водяной знак) — через ffmpeg.
 *
 *  POST /api/imageedit/crop       — multipart file + x,y,w,h → изображение
 *  POST /api/imageedit/resize     — multipart file + w,h → изображение
 *  POST /api/imageedit/watermark  — multipart file + watermark + position,opacity → изображение
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { DIRS } = require("../config");
const editor = require("../imageEditor");
const { removePath } = require("../fsUtil");

const router = express.Router();
const MAX_BYTES = 100 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.convertIn,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".png";
      cb(null, `imgedit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

function outPathFor(originalName, ext) {
  const base = ext || path.extname(originalName || "") || ".png";
  return path.join(DIRS.convertOut, `imgedit_out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${base}`);
}

function sendAndCleanup(res, outPath, downloadName) {
  res.download(outPath, downloadName, () => {
    try {
      removePath(outPath);
    } catch {
      /* ignore */
    }
  });
}

router.post("/crop", upload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const { x, y, w, h } = req.body || {};
    const outPath = outPathFor(req.file.originalname);
    await editor.crop(req.file.path, outPath, {
      x: parseInt(x, 10) || 0,
      y: parseInt(y, 10) || 0,
      w: parseInt(w, 10) || 0,
      h: parseInt(h, 10) || 0,
    });
    cleanup();
    sendAndCleanup(res, outPath, `cropped${path.extname(outPath)}`);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

router.post("/resize", upload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const { w, h } = req.body || {};
    const outPath = outPathFor(req.file.originalname);
    await editor.resize(req.file.path, outPath, {
      w: parseInt(w, 10) || 0,
      h: parseInt(h, 10) || 0,
    });
    cleanup();
    sendAndCleanup(res, outPath, `resized${path.extname(outPath)}`);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/watermark",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "watermark", maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files || {};
    const cleanup = () => {
      if (files.file?.[0]) removePath(files.file[0].path);
      if (files.watermark?.[0]) removePath(files.watermark[0].path);
    };
    try {
      if (!files.file?.[0] || !files.watermark?.[0]) {
        return res.status(400).json({ error: "missing_file" });
      }
      const { position, opacity } = req.body || {};
      const outPath = outPathFor(files.file[0].originalname);
      await editor.watermark(
        files.file[0].path,
        files.watermark[0].path,
        outPath,
        String(position || "bottom-right"),
        opacity != null ? parseFloat(opacity) : 0.6,
      );
      cleanup();
      sendAndCleanup(res, outPath, `watermarked${path.extname(outPath)}`);
    } catch (e) {
      cleanup();
      res.status(500).json({ error: e.message });
    }
  },
);

module.exports = router;
