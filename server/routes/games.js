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
 *  POST   /api/games/:id/save/find-path — автопоиск папки сохранений по имени игры
 *  GET    /api/games/cover/:appId       — прокси обложки Steam (CSP img-src 'self')
 */

const express = require("express");
const games = require("../games");

const router = express.Router();

/**
 * Прокси обложки Steam: <img src="https://cdn.cloudflare.steamstatic.com/...">
 * грузился бы Chromium напрямую и падал под CSP img-src 'self' (тот же приём,
 * что и /api/movies/image для постеров TMDB). Без токена — <img> не умеет
 * слать заголовки; безопасность — appId строго цифры, хост всегда steamstatic.
 */
router.get("/cover/:appId", async (req, res) => {
  const appId = String(req.params.appId || "");
  if (!/^\d+$/.test(appId)) return res.status(400).json({ error: "bad_app_id" });
  try {
    const upstream = await fetch(
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
    );
    if (!upstream.ok) return res.status(upstream.status).end();
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get("/", (req, res) => {
  try {
    res.json(games.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, exePath, description, iconDataUrl, backgroundDataUrl, savePath } = req.body || {};
    if (!exePath) return res.status(400).json({ error: "missing_exePath" });
    const entry = await games.create({ name, exePath, description, iconDataUrl, backgroundDataUrl, savePath });
    res.status(201).json(entry);
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

router.post("/:id/save/find-path", (req, res) => {
  try {
    const list = games.list();
    const entry = list.find((g) => g.id === req.params.id);
    if (!entry) return res.status(404).json({ error: "not_found" });
    const found = games.guessSavePath(entry.name);
    if (!found) return res.json({ found: false, savePath: null });
    const updated = games.update(entry.id, { savePath: found });
    res.json({ found: true, savePath: found, entry: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
