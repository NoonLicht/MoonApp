import express from "express";
import * as monitor from "../monitor";
import * as monitorAlerts from "../monitorAlerts";
import settings from "../settings";
import logger from "../logger";
import { clearProblems, listProblems, reportProblem, summarize } from "../problemLog";

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: "0.1.0" });
});

// POST /api/log — приём событий с фронта (клики, навигация, ошибки UI).
// Кладём в полный журнал audit.log: он целиком попадает в файл кнопки
// «Собрать логи». Уровень события задаёт фронт (action | info | warn | error).
router.post("/log", (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [body];
  for (const e of events) {
    if (!e || !e.event) continue;
    const level = String(e.level || "action");
    logger.log(level, String(e.event), e.data);
    // Ошибки и предупреждения UI дублируем в журнал проблем (там они склеиваются).
    if (level === "error" || level === "warn") {
      reportProblem({ source: "ui", level, error: String(e.event) });
    }
  }
  res.json({ ok: true });
});

// GET /api/problems — журнал проблем (новые сверху) и текстовая сводка.
router.get("/problems", (req, res) => {
  const items = listProblems();
  res.json({ items, summary: summarize(items) });
});

// DELETE /api/problems — очистить журнал проблем.
router.delete("/problems", (req, res) => {
  clearProblems();
  res.json({ ok: true });
});

// --- Управление LibreHardwareMonitor (источник датчиков) ---
router.get("/monitor/lhm", async (req, res) => {
  try {
    res.json(await monitor.lhmStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Запуск: находится установленный LHM, поднимается (UAC-запрос), ожидается WMI.
router.post("/monitor/lhm/start", async (req, res) => {
  try {
    res.json(await monitor.startLhm());
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Скачать headless-движок (LibreHardwareMonitorLib с GitHub) и запустить его.
router.post("/monitor/lhm/download", async (req, res) => {
  try {
    res.json(await monitor.downloadAndStartEngine());
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/monitor/lhm/stop", (req, res) => {
  monitor.stopLhm();
  res.json({ ok: true });
});

// Реальная телеметрия системы (server/ts/monitor.ts → server/monitor.js).
// Поля cpuTemp/gpuTemp/ram/vram/fan1/fan2 оставлены для обратной совместимости.
// История показателей и алерты (сбор включается настройкой monitor.alertsEnabled).
router.get("/monitor/history", (req, res) => {
  const minutes = Math.min(1440, Math.max(1, Number(req.query.minutes) || 60));
  res.json(monitorAlerts.getHistory(minutes * 60_000));
});

router.get("/monitor/hourly", (_req, res) => {
  res.json(monitorAlerts.getHourly());
});

router.get("/monitor/alerts", (req, res) => {
  res.json({
    enabled: settings.get("monitor").alertsEnabled === true,
    alerts: monitorAlerts.getAlerts(),
    smart: monitorAlerts.getSmart(),
  });
});

router.get("/monitor", async (req, res) => {
  try {
    const s = await monitor.getSnapshot();
    const gpuTempLhm = s.temperatures.find((t) => /gpu/i.test(t.id + t.hw + t.name));
    const cpuTemp = s.cpu.temperatureC ?? s.temperatures[0]?.value ?? null;
    const gpuTemp = s.gpu[0]?.temperatureC ?? gpuTempLhm?.value ?? null;
    const g0 = s.gpu[0];
    res.json({
      ...s,
      stub: false,
      cpuTemp,
      gpuTemp,
      ram: s.memory.usedPercent,
      vram:
        g0?.memoryUsedMb != null && g0?.memoryTotalMb
          ? Math.round((100 * g0.memoryUsedMb) / g0.memoryTotalMb)
          : null,
      fan1: s.fans[0]?.rpm ?? null,
      fan2: s.fans[1]?.rpm ?? null,
      history: [],
    });
  } catch (e: any) {
    logger.error("monitor.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Архивация страниц переехала в routes/archive.js (движок .sitebak).
// Легаси-эндпоинты /api/archives и таблица archived_pages удалены (М9).

// Книги — перенесены в routes/books.js (полноценный каталог по OPDS).
// router.get("/books", ...) больше не здесь — см. /api/books.

export = router;
