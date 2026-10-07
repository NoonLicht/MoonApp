/**
 * API kill-switch (страница Bypass).
 *
 *  GET  /api/killswitch/status   — { armed, blocking, proxyRunning, error }
 *  POST /api/killswitch/arm      — взвести
 *  POST /api/killswitch/disarm   — снять взвод + убрать блокировку, если была
 */

import express from "express";
import * as killSwitch from "../killSwitch";

const router = express.Router();

router.get("/status", async (req, res) => {
  try {
    res.json(await killSwitch.status());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/arm", (req, res) => {
  try {
    killSwitch.arm();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/disarm", async (req, res) => {
  try {
    res.json(await killSwitch.disarm());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export = router;
