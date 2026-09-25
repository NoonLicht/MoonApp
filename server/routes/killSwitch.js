"use strict";

/**
 * API kill-switch (страница Bypass).
 *
 *  GET  /api/killswitch/status   — { armed, blocking, proxyRunning, error }
 *  POST /api/killswitch/arm      — взвести
 *  POST /api/killswitch/disarm   — снять взвод + убрать блокировку, если была
 */

const express = require("express");
const killSwitch = require("../killSwitch");

const router = express.Router();

router.get("/status", async (req, res) => {
  try {
    res.json(await killSwitch.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/arm", (req, res) => {
  try {
    killSwitch.arm();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/disarm", async (req, res) => {
  try {
    res.json(await killSwitch.disarm());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
