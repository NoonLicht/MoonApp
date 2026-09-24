"use strict";

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

const express = require("express");
const taskRegistry = require("../taskRegistry");
const logger = require("../logger");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ tasks: taskRegistry.listAll() });
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

module.exports = router;
