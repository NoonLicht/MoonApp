"use strict";

/**
 * curl → код: обёртка над curlconverter (server/ts/curlConvert.ts).
 *
 *  GET  /api/curlconvert/targets            — список целевых языков
 *  POST /api/curlconvert  { command, target } — { code, warnings }
 */

const express = require("express");
const curlConvert = require("../curlConvert");

const router = express.Router();

router.get("/targets", (req, res) => {
  res.json(curlConvert.TARGETS.map(({ id, label }) => ({ id, label })));
});

router.post("/", (req, res) => {
  const command = String((req.body && req.body.command) || "");
  const target = String((req.body && req.body.target) || "");
  if (!command.trim()) return res.status(400).json({ error: "missing_command" });
  try {
    res.json(curlConvert.convert(command, target));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
