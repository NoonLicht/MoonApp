const express = require("express");
const backups = require("../backup");
const logger = require("../logger");
const logBundle = require("../logBundle");

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

// POST /api/log — приём событий с фронта (клики, навигация, ошибки UI).
// Принимает как одно событие { event, data, level }, так и пачку { events: [...] }.
// Все события идут в полный журнал (logs/audit.log) и попадают в файл,
// который собирает кнопка «Собрать логи».
router.post("/log", (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [body];
  for (const e of events) {
    if (!e || !e.event) continue;
    logger.log(String(e.level || "action"), String(e.event), e.data);
  }
  res.json({ ok: true });
});

// POST /api/backup/logs — собрать диагностический файл со всеми логами.
// Файл появляется в корне storage (рядом с приложением) и пересылается разработчику.
router.post("/logs", (req, res) => {
  try {
    const report = logBundle.collect();
    res.status(201).json({ ok: true, ...report });
  } catch (e) {
    logger.error("diagnostics.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/backup/logs — список уже собранных диагностических файлов.
router.get("/logs", (req, res) => {
  res.json(logBundle.listReports());
});

module.exports = router;
