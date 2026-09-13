const express = require("express");
const { stmts } = require("../db");
const monitor = require("../monitor");
const logger = require("../logger");
const proxy = require("../proxy");

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
    logger.log(String(e.level || "action"), String(e.event), e.data);
  }
  res.json({ ok: true });
});

// --- Управление LibreHardwareMonitor (источник датчиков) ---
router.get("/monitor/lhm", async (req, res) => {
  try { res.json(await monitor.lhmStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Запуск: находится установленный LHM, поднимается (UAC-запрос), ожидается WMI.
router.post("/monitor/lhm/start", async (req, res) => {
  try { res.json(await monitor.startLhm()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Скачать headless-движок (LibreHardwareMonitorLib с GitHub) и запустить его.
router.post("/monitor/lhm/download", async (req, res) => {
  try { res.json(await monitor.downloadAndStartEngine()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post("/monitor/lhm/stop", (req, res) => {
  monitor.stopLhm();
  res.json({ ok: true });
});

// Реальная телеметрия системы (server/ts/monitor.ts → server/monitor.js).
// Поля cpuTemp/gpuTemp/ram/vram/fan1/fan2 оставлены для обратной совместимости.
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
      vram: g0?.memoryUsedMb != null && g0?.memoryTotalMb
        ? Math.round((100 * g0.memoryUsedMb) / g0.memoryTotalMb)
        : null,
      fan1: s.fans[0]?.rpm ?? null,
      fan2: s.fans[1]?.rpm ?? null,
      history: [],
    });
  } catch (e) {
    logger.error("monitor.error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Архивация страниц переехала в routes/archive.js (движок .sitebak).
// Легаси-эндпоинты /api/archives и таблица archived_pages удалены (М9).

// Книги — перенесены в routes/books.js (полноценный каталог по OPDS).
// router.get("/books", ...) больше не здесь — см. /api/books.

module.exports = router;