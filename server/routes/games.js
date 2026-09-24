"use strict";

/**
 * API лаунчера игр/приложений.
 *
 *  GET    /api/games                    — библиотека
 *  POST   /api/games                    — создать карточку вручную
 *  PUT    /api/games/:id                — обновить карточку
 *  DELETE /api/games/:id                — удалить карточку
 *  POST   /api/games/:id/launch         — запустить
 *  POST   /api/games/autoscan           — автосбор из Steam/Epic
 *  POST   /api/games/:id/save/backup    — сделать версионный бэкап сохранений
 *  GET    /api/games/:id/save/versions  — список версий бэкапа
 *  POST   /api/games/:id/save/restore   — восстановить версию { file }
 */

const express = require("express");
const games = require("../games");

const router = express.Router();

router.get("/", (req, res) => {
  try {
    res.json(games.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req, res) => {
  try {
    const { name, exePath, description, iconDataUrl, backgroundDataUrl, savePath } = req.body || {};
    if (!exePath) return res.status(400).json({ error: "missing_exePath" });
    res
      .status(201)
      .json(games.create({ name, exePath, description, iconDataUrl, backgroundDataUrl, savePath }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", (req, res) => {
  try {
    const entry = games.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = games.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/launch", (req, res) => {
  try {
    res.json(games.launch(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/autoscan", async (req, res) => {
  try {
    res.json(await games.autoScan());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/save/backup", (req, res) => {
  try {
    res.json(games.backupSave(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/save/versions", (req, res) => {
  try {
    res.json(games.listSaveVersions(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/save/restore", (req, res) => {
  try {
    const file = (req.body && req.body.file) || "";
    if (!file) return res.status(400).json({ error: "missing_file" });
    res.json(games.restoreSave(req.params.id, file));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
