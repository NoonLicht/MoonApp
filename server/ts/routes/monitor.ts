/**
 * Мониторинг системы: телеметрия, история, оповещения, LibreHardwareMonitor.
 * Подключается как /api/monitor (раньше жил в routes/meta и тянул модули мониторинга при
 * каждом запуске, даже если страница отключена — см. features.ts).
 */
import express from "express";
import * as monitor from "../monitor";
import * as monitorAlerts from "../monitorAlerts";
import settings from "../settings";
import logger from "../logger";

const router = express.Router();

// --- Управление LibreHardwareMonitor (источник датчиков) ---
router.get("/lhm", async (req, res) => {
  try {
    res.json(await monitor.lhmStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Запуск: находится установленный LHM, поднимается (UAC-запрос), ожидается WMI.
router.post("/lhm/start", async (req, res) => {
  try {
    res.json(await monitor.startLhm());
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Скачать headless-движок (LibreHardwareMonitorLib с GitHub) и запустить его.
router.post("/lhm/download", async (req, res) => {
  try {
    res.json(await monitor.downloadAndStartEngine());
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/lhm/stop", (req, res) => {
  monitor.stopLhm();
  res.json({ ok: true });
});

// Реальная телеметрия системы (server/ts/monitor.ts → server/monitor.js).
// Поля cpuTemp/gpuTemp/ram/vram/fan1/fan2 оставлены для обратной совместимости.
// История показателей и алерты (сбор включается настройкой monitor.alertsEnabled).
router.get("/history", (req, res) => {
  const minutes = Math.min(1440, Math.max(1, Number(req.query.minutes) || 60));
  res.json(monitorAlerts.getHistory(minutes * 60_000));
});

router.get("/hourly", (_req, res) => {
  res.json(monitorAlerts.getHourly());
});

router.get("/alerts", (req, res) => {
  res.json({
    enabled: settings.get("monitor").alertsEnabled === true,
    alerts: monitorAlerts.getAlerts(),
    smart: monitorAlerts.getSmart(),
  });
});

router.get("/", async (req, res) => {
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

export default router;
