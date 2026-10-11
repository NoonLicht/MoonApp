import express from "express";
import * as backups from "../backup";
import logger from "../logger";
import * as logBundle from "../logBundle";

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

// GET /api/backup/:id/verify — сверка файлов бэкапа с манифестом (sha256).
router.get("/:id/verify", (req, res) => {
  try {
    res.json(backups.verify(req.params.id));
  } catch (e) {
    const msg = (e as Error).message;
    res.status(msg === "backup.not_found" ? 404 : 400).json({ error: msg });
  }
});

// POST /api/backup/:id/restore — вернуть данные из проверенного бэкапа.
// Перед этим снимается страховочный бэкап; БД подменится при следующем запуске.
router.post("/:id/restore", (req, res) => {
  try {
    res.json({ ok: true, ...backups.restore(req.params.id) });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "backup.not_found" ? 404 : msg === "backup.bad_id" ? 400 : 409;
    res.status(status).json({ error: msg });
  }
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
  } catch (e: any) {
    logger.error("diagnostics.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/backup/logs — список уже собранных диагностических файлов.
router.get("/logs", (req, res) => {
  res.json(logBundle.listReports());
});

export = router;
