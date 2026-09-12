"use strict";

/**
 * API Lecture Recorder (whisper.cpp + VAD).
 *
 *  GET    /api/lecture/engine              — статус whisper.cpp (Vulkan/CPU, модель)
 *  GET    /api/lecture/sessions            — список лекций
 *  POST   /api/lecture/sessions            — создать сессию { title, sampleRate, channels }
 *  GET    /api/lecture/:id                 — статус: чанки, очередь, VAD-статистика
 *  POST   /api/lecture/:id/ingest          — PCM Int16 (octet-stream) → raw.wav + VAD
 *  PATCH  /api/lecture/chunks/:chunkId     — click-to-edit текста чанка { text }
 *  POST   /api/lecture/:id/markers         — маркер важного { atMs, label } (Ctrl+B/F2)
 *  POST   /api/lecture/:id/stop            — финализация сессии
 *  DELETE /api/lecture/:id                 — удалить сессию и файлы
 *  GET    /api/lecture/:id/export?format=  — md | srt | vtt
 *  GET    /api/lecture/:id/audio           — fail-safe raw WAV
 *  GET    /api/lecture/chunks/:chunkId/audio — WAV чанка
 *  POST   /api/lecture/:id/conspectus      — AI-конспект через локальный Ollama
 */

const express = require("express");
const fs = require("fs");
const lecture = require("../lecture");
const logger = require("../logger");

const router = express.Router();

// express.raw для PCM-потока: льём кусочками по ~0.5 c (16 КБ), лимит с запасом.
function rawParser(limitMb = 8) {
  return express.raw({ type: () => true, limit: `${limitMb}mb` });
}

router.get("/engine", (req, res) => res.json(lecture.engineStatus()));

router.get("/sessions", (req, res) => res.json(require("../db").stmts.lectureAll.all()));

router.post("/sessions", (req, res) => {
  try {
    const s = lecture.createSession(req.body?.title, Number(req.body?.sampleRate) || 16000, req.body?.channels);
    logger.action("lecture.api.create", { id: s.id });
    res.status(201).json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/ingest", rawParser(), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "empty_pcm" });
    res.json(lecture.ingest(Number(req.params.id), req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/:id", (req, res) => {
  const st = lecture.getStatus(Number(req.params.id));
  if (!st) return res.status(404).json({ error: "not_found" });
  res.json(st);
});

router.patch("/chunks/:chunkId", (req, res) => {
  try { res.json(lecture.updateChunkText(Number(req.params.chunkId), req.body?.text)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/:id/markers", (req, res) => {
  try { res.status(201).json(lecture.addMarker(Number(req.params.id), Number(req.body?.atMs) || 0, req.body?.label)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/:id/stop", (req, res) => {
  try { res.json(lecture.stopSession(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/:id", (req, res) => {
  try { res.json({ ok: lecture.deleteSession(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/:id/export", (req, res) => {
  try {
    const out = lecture.exportContent(Number(req.params.id), String(req.query.format || "md"));
    res.setHeader("Content-Type", `${out.mime}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="${out.name}"`);
    res.send(out.body);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/:id/audio", (req, res) => {
  const p = lecture.rawAudioPath(Number(req.params.id));
  if (!p) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

router.get("/chunks/:chunkId/audio", (req, res) => {
  const p = lecture.chunkAudioPath(Number(req.params.chunkId));
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

router.post("/:id/conspectus", async (req, res) => {
  try {
    res.json(await lecture.generateConspectus(Number(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
