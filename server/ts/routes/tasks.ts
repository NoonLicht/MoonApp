/**
 * API Диспетчера фоновых задач (единый список активных job'ов всех движков —
 * компрессия, апскейл, озвучка, лекции, веб-архиватор). Обвязка над
 * server/ts/taskRegistry.ts, который сами движки заполняют через
 * registerProvider при загрузке своих модулей (см. низ compressor.ts,
 * tts.ts, sitebak.ts, upscale/jobs.ts, lecture.js).
 *
 *  GET  /api/tasks              — все активные/недавние задачи всех движков
 *  POST /api/tasks/:engine/:id/cancel
 *  POST /api/tasks/:engine/:id/pause   (только там, где движок это умеет)
 *  POST /api/tasks/:engine/:id/resume
 */

import express from "express";
import * as taskRegistry from "../taskRegistry";
import { scheduler } from "../jobQueue";
import logger from "../logger";

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ tasks: taskRegistry.listAll() });
});

// --- Общий планировщик (server/ts/jobQueue.ts) ---
// Эти маршруты объявлены ДО /:engine/:id/*, иначе «queue» разобралось бы как движок.

// GET /api/tasks/queue/stats — занятость ресурсных слотов и состояние очереди.
router.get("/queue/stats", (req, res) => {
  res.json({ paused: scheduler.isPaused(), resources: scheduler.stats() });
});

// POST /api/tasks/queue/pause|resume — не запускать новые задачи / продолжить.
router.post("/queue/pause", (req, res) => {
  scheduler.setPaused(true);
  res.json({ ok: true, paused: true });
});
router.post("/queue/resume", (req, res) => {
  scheduler.setPaused(false);
  res.json({ ok: true, paused: false });
});

// POST /api/tasks/queue/:id/retry — повторить упавшую или отменённую задачу.
router.post("/queue/:id/retry", (req, res) => {
  if (!scheduler.retry(req.params.id))
    return res.status(404).json({ error: "not_found_or_not_failed" });
  res.json({ ok: true });
});

router.post("/:engine/:id/cancel", (req, res) => {
  const ok = taskRegistry.cancel(req.params.engine, req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found_or_done" });
  logger.action("tasks.cancel", { engine: req.params.engine, id: req.params.id });
  res.json({ ok: true });
});

router.post("/:engine/:id/pause", (req, res) => {
  const ok = taskRegistry.pause(req.params.engine, req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found_or_unsupported" });
  res.json({ ok: true });
});

router.post("/:engine/:id/resume", (req, res) => {
  const ok = taskRegistry.resume(req.params.engine, req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found_or_unsupported" });
  res.json({ ok: true });
});

export = router;
