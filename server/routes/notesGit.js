"use strict";

/**
 * API git-синхронизации заметок/канваса (storage/vault/).
 *
 *  GET  /api/notesgit/config   — текущая настройка (без токена, только hasToken)
 *  POST /api/notesgit/config   — { remoteUrl?, branch?, authorName?, authorEmail?, token? }
 *  GET  /api/notesgit/status   — { dirty, files }
 *  POST /api/notesgit/sync     — commit+pull(ff-only)+push
 */

const express = require("express");
const notesGit = require("../notesGit");

const router = express.Router();

router.get("/config", (req, res) => {
  try {
    res.json(notesGit.getConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/config", (req, res) => {
  try {
    res.json(notesGit.setConfig(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status", async (req, res) => {
  try {
    res.json(await notesGit.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/sync", async (req, res) => {
  try {
    res.json(await notesGit.sync());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
