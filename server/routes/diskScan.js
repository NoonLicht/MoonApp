"use strict";

/**
 * API анализатора диска (аналог WinDirStat).
 *
 *  GET  /api/diskscan/roots          — доступные корни (буквы дисков)
 *  POST /api/diskscan/start          — { path } → { id }
 *  GET  /api/diskscan/status/:id     — { stage, scannedEntries, error }
 *  GET  /api/diskscan/result/:id     — готовое дерево (DiskNode) или 404, пока не готово
 *  POST /api/diskscan/cancel/:id     — остановить сканирование
 *  GET  /api/diskscan/files          — { path } → список файлов одной папки (лениво, без рекурсии)
 */

const express = require("express");
const diskScan = require("../diskScan");

const router = express.Router();

router.get("/roots", async (req, res) => {
  try {
    res.json({ roots: await diskScan.listRoots() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/start", (req, res) => {
  try {
    const p = String((req.body && req.body.path) || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    res.status(201).json(diskScan.startScan(p));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/:id", (req, res) => {
  const job = diskScan.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({
    id: job.id,
    root: job.root,
    stage: job.stage,
    scannedEntries: job.scannedEntries,
    error: job.error,
  });
});

router.get("/result/:id", (req, res) => {
  const job = diskScan.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.stage !== "done") return res.status(409).json({ error: "not_ready", stage: job.stage });
  res.json(job.result);
});

router.post("/cancel/:id", (req, res) => {
  res.json({ ok: diskScan.cancelJob(req.params.id) });
});

router.get("/files", async (req, res) => {
  try {
    const p = String(req.query.path || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    res.json({ files: await diskScan.listFiles(p) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
