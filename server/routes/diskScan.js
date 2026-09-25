"use strict";

/**
 * API анализатора диска (аналог WinDirStat).
 *
 *  GET  /api/diskscan/roots          — доступные корни (буквы дисков)
 *  POST /api/diskscan/start          — { path } → { id }
 *  GET  /api/diskscan/status/:id     — { stage, scannedEntries, error }
 *  GET  /api/diskscan/result/:id     — { path? } → ОДИН уровень дерева (узел + прямые дети,
 *                                       без внуков — см. diskScan.getNode). Без path — корень.
 *  POST /api/diskscan/cancel/:id     — остановить сканирование
 *  GET  /api/diskscan/files          — { path } → список файлов одной папки (лениво, без рекурсии)
 *  POST /api/diskscan/reveal         — { path } → открыть в проводнике
 *  POST /api/diskscan/console        — { path, isDir } → открыть терминал в этой папке
 *  POST /api/diskscan/delete         — { path, isDir } → удалить в корзину
 *  POST /api/diskscan/compress       — { path } → запустить сжатие в .zip рядом (в фоне)
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
  const p = String(req.query.path || "");
  const node = diskScan.getNode(req.params.id, p);
  if (!node) return res.status(404).json({ error: "path_not_found" });
  res.json(node);
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

router.post("/reveal", (req, res) => {
  try {
    const p = String((req.body && req.body.path) || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    diskScan.revealInExplorer(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/console", (req, res) => {
  try {
    const p = String((req.body && req.body.path) || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    diskScan.openConsole(p, !!(req.body && req.body.isDir));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/delete", async (req, res) => {
  try {
    const p = String((req.body && req.body.path) || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    await diskScan.deleteToTrash(p, !!(req.body && req.body.isDir));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/compress", (req, res) => {
  try {
    const p = String((req.body && req.body.path) || "").trim();
    if (!p) return res.status(400).json({ error: "missing_path" });
    res.json({ ok: true, dest: diskScan.compressPath(p) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
