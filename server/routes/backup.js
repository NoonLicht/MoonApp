const express = require("express");
const backups = require("../backup");
const logger = require("../logger");

const router = express.Router();

// POST /api/backup — создать бэкап вручную
router.post("/", (req, res) => {
  const dir = backups.createBackup("manual");
  if (!dir) return res.status(500).json({ error: "backup failed" });
  res.status(201).json({ ok: true, dir });
});

// GET /api/backup — список бэкапов
router.get("/", (req, res) => {
  res.json(backups.list());
});

// POST /api/log — приём событий с фронта (клики и т.п.)
router.post("/log", (req, res) => {
  const { event, data } = req.body || {};
  if (event) logger.action(event, data);
  res.json({ ok: true });
});

module.exports = router;