"use strict";

/**
 * API трекера времени за приложениями.
 *
 *  POST /api/apptracker/start   — включить слежение
 *  POST /api/apptracker/stop    — выключить
 *  GET  /api/apptracker/status  — { tracking }
 *  GET  /api/apptracker/today   — { date, apps: [{name, seconds}] }
 *  GET  /api/apptracker/history?days=7 — [{date, totalSeconds}]
 */

const express = require("express");
const tracker = require("../appTimeTracker");

const router = express.Router();

router.post("/start", (req, res) => {
  try {
    res.json(tracker.start());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/stop", (req, res) => {
  try {
    res.json(tracker.stop());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status", (req, res) => {
  try {
    res.json(tracker.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/today", (req, res) => {
  try {
    res.json(tracker.todayStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/history", (req, res) => {
  try {
    const days = parseInt(String(req.query.days || "7"), 10);
    res.json(tracker.history(days));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
