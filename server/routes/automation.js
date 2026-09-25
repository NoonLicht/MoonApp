"use strict";

/**
 * API автоматизации: быстрый лаунчер + задания планировщика (\MoonApp\).
 *
 *  GET    /api/automation/launchers               — список лаунчеров
 *  POST   /api/automation/launchers                — создать
 *  DELETE /api/automation/launchers/:id             — удалить
 *  POST   /api/automation/launchers/:id/run         — запустить сейчас
 *  GET    /api/automation/tasks                     — список заданий планировщика
 *  POST   /api/automation/tasks                     — создать задание
 *  DELETE /api/automation/tasks/:name                — удалить задание
 *  POST   /api/automation/tasks/:name/run            — запустить задание сейчас
 */

const express = require("express");
const automation = require("../automation");

const router = express.Router();

router.get("/launchers", (req, res) => {
  try {
    res.json(automation.listLaunchers());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/launchers", (req, res) => {
  try {
    const { name, exePath, args } = req.body || {};
    if (!exePath) return res.status(400).json({ error: "missing_exePath" });
    res.status(201).json(automation.createLauncher({ name, exePath, args }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/launchers/:id", (req, res) => {
  try {
    const ok = automation.removeLauncher(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/launchers/:id/run", (req, res) => {
  try {
    res.json(automation.launch(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/tasks", async (req, res) => {
  try {
    res.json(await automation.listScheduledTasks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks", async (req, res) => {
  try {
    const { name, launcherId, schedule, time } = req.body || {};
    if (!name || !launcherId || !schedule) return res.status(400).json({ error: "missing_fields" });
    res.json(await automation.createScheduledTask({ name, launcherId, schedule, time }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/tasks/:name", async (req, res) => {
  try {
    res.json(await automation.deleteScheduledTask(req.params.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks/:name/run", async (req, res) => {
  try {
    res.json(await automation.runScheduledTaskNow(req.params.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
