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
const os = require("os");
const path = require("path");
const multer = require("multer");
const { DIRS } = require("../config");
const { removePath } = require("../fsUtil");
const screenshots = require("../screenshots");

/**
 * Путь к резервному WAV системного звука на Linux (см. audioCaptureLinux.ts +
 * ScreenshotsPage.tsx) — сервер и Electron-рендерер работают в одном
 * приложении на одной машине, поэтому путь просто передаётся строкой, а не
 * загружается файлом. Ограничиваем именем/каталогом, которые сама же
 * audioCaptureLinux.ts и генерирует, чтобы поле из тела запроса не превратилось
 * в чтение произвольного файла с диска.
 */
function safeExtraAudioPath(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const resolved = path.resolve(raw);
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) return null;
  if (!/^moonapp-sysaudio-\d+\.wav$/i.test(path.basename(resolved))) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

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

router.post("/video", upload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    // Перегоняем webm из MediaRecorder в mp4 (H.264+AAC, правильная длина в
    // контейнере) — см. screenshots.finalizeRecording. Без ffmpeg отдаст файл
    // как есть (webm), честно, без притворного расширения.
    const bitrateMbps = numOrUndef(req.body?.bitrateMbps) || 8;
    const extraAudioPath = safeExtraAudioPath(req.body?.extraAudioPath);
    const final = await screenshots.finalizeRecording(req.file.path, bitrateMbps, extraAudioPath);
    const item = screenshots.saveFromTemp(final.path, {
      type: "video",
      ext: final.ext,
      mime: final.mime,
      width: numOrUndef(req.body?.width),
      height: numOrUndef(req.body?.height),
      // ffprobe (реальный duration mp4) важнее клиентского таймера страницы —
      // тот считался в JS и мог разойтись с фактом (см. finalizeRecording).
      durationSec: final.durationSec || numOrUndef(req.body?.durationSec),
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
