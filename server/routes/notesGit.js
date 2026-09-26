"use strict";

/**
 * API git-синхронизации заметок/канваса (storage/vault/).
 *
 *  GET  /api/notesgit/config   — текущая настройка (без токена, только hasToken)
 *  POST /api/notesgit/config   — { remoteUrl?, branch?, authorName?, authorEmail?, token? }
 *  GET  /api/notesgit/status   — { dirty, files }
 *  POST /api/notesgit/sync     — commit+pull(ff-only)+push
 *  POST /api/notesgit/test     — проверить доступ к удалённому репозиторию (git ls-remote, без записи на диск)
 *  GET  /api/notesgit/log      — история коммитов ?limit=50
 *  GET  /api/notesgit/diff/:oid — построчный дифф файлов коммита относительно родителя
 *  POST /api/notesgit/restore  — { oid } откатить рабочую копию к состоянию коммита (без переписывания истории)
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

router.post("/test", async (req, res) => {
  try {
    res.json(await notesGit.testConnection());
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

router.get("/log", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json(await notesGit.log(limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/diff/:oid", async (req, res) => {
  try {
    res.json(await notesGit.diffCommit(req.params.oid));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/restore", async (req, res) => {
  try {
    const oid = String((req.body && req.body.oid) || "");
    if (!oid) return res.status(400).json({ error: "missing_oid" });
    res.json(await notesGit.restoreToCommit(oid));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
