"use strict";

/**
 * Библиотека скриншотов и записей экрана (страница «Скриншоты»).
 *
 *  GET    /api/screenshots            — список (новые сверху)
 *  POST   /api/screenshots/image      — multipart file (png/jpg) + width/height
 *  POST   /api/screenshots/video      — multipart file (webm) + width/height/durationSec
 *  GET    /api/screenshots/file/:id   — отдать файл (с Range для видео)
 *  DELETE /api/screenshots/:id        — удалить
 */

const express = require("express");
const fs = require("fs");
const multer = require("multer");
const { DIRS } = require("../config");
const { removePath } = require("../fsUtil");
const screenshots = require("../screenshots");

const router = express.Router();
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({ destination: DIRS.tmp }),
  limits: { fileSize: MAX_BYTES },
});

router.get("/", (req, res) => {
  try {
    res.json(screenshots.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function numOrUndef(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

router.post("/image", upload.single("file"), (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const item = screenshots.saveFromTemp(req.file.path, {
      type: "image",
      ext: "png",
      mime: "image/png",
      width: numOrUndef(req.body?.width),
      height: numOrUndef(req.body?.height),
    });
    res.status(201).json(item);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

router.post("/video", upload.single("file"), (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const item = screenshots.saveFromTemp(req.file.path, {
      type: "video",
      ext: "webm",
      mime: "video/webm",
      width: numOrUndef(req.body?.width),
      height: numOrUndef(req.body?.height),
      durationSec: numOrUndef(req.body?.durationSec),
    });
    res.status(201).json(item);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

router.get("/file/:id", (req, res) => {
  const item = screenshots.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  const p = screenshots.filePath(item);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return res.status(404).json({ error: "file_missing" });
  }
  const total = stat.size;
  res.setHeader("Content-Type", item.mime);
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) return res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(total));
    fs.createReadStream(p).pipe(res);
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = screenshots.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
