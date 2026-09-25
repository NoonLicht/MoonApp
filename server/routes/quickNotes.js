"use strict";

/**
 * API быстрых голосовых заметок.
 *
 *  GET    /api/quicknotes                — список заметок
 *  POST   /api/quicknotes                — multipart file (audio) + keepAudio → расшифровка
 *  DELETE /api/quicknotes/:id             — удалить заметку (+ аудио, если хранилось)
 *  GET    /api/quicknotes/:id/audio       — скачать сохранённое аудио заметки
 *  POST   /api/quicknotes/:id/structure   — оформить расшифровку в Markdown через ИИ
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { DIRS } = require("../config");
const quickNotes = require("../quickNotes");
const notesAi = require("../notesAi");
const { removePath } = require("../fsUtil");

const router = express.Router();
const MAX_BYTES = 30 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.quickNotesTmp,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".webm";
      cb(null, `qn_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

router.get("/", (req, res) => {
  try {
    res.json(quickNotes.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", upload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const keepAudio = String((req.body || {}).keepAudio) === "true";
    const note = await quickNotes.transcribeAndSave({
      audioPath: req.file.path,
      originalExt: path.extname(req.file.originalname || "") || ".webm",
      keepAudio,
    });
    cleanup();
    res.status(201).json(note);
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = quickNotes.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/structure", async (req, res) => {
  try {
    const note = quickNotes.list().find((n) => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: "not_found" });
    if (!note.text.trim()) return res.status(400).json({ error: "empty_text" });
    const result = await notesAi.structureQuickNote(note.text, req.appPage);
    const updated = quickNotes.setStructuredText(note.id, result.content);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/audio", (req, res) => {
  try {
    const note = quickNotes.list().find((n) => n.id === req.params.id);
    if (!note || !note.audioFile) return res.status(404).json({ error: "not_found" });
    res.sendFile(path.join(DIRS.quickNotes, note.audioFile));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
