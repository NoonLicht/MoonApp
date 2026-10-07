/**
 * API трекера времени за приложениями.
 *
 *  POST /api/apptracker/start   — включить слежение
 *  POST /api/apptracker/stop    — выключить
 *  GET  /api/apptracker/status  — { tracking }
 *  GET  /api/apptracker/today   — { date, apps: [{name, seconds}] }
 *  GET  /api/apptracker/history?days=7 — [{date, totalSeconds}]
 */

import express from "express";
import * as tracker from "../appTimeTracker";

const router = express.Router();

router.post("/start", (req, res) => {
  try {
    res.json(tracker.start());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/stop", (req, res) => {
  try {
    res.json(tracker.stop());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status", (req, res) => {
  try {
    res.json(tracker.status());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/today", (req, res) => {
  try {
    res.json(tracker.todayStats());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/history", (req, res) => {
  try {
    const days = parseInt(String(req.query.days || "7"), 10);
    res.json(tracker.history(days));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export = router;
