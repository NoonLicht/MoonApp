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

import * as appTime from "../appTimeTracker";
import * as gameInsights from "../gameInsights";
import * as gameBench from "../gameBench";
import express from "express";
import * as games from "../games";

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
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

router.get("/", (req, res) => {
  try {
    res.json(games.list());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, exePath, description, iconDataUrl, backgroundDataUrl, savePath } = req.body || {};
    if (!exePath) return res.status(400).json({ error: "missing_exePath" });
    const entry = await games.create({
      name,
      exePath,
      description,
      iconDataUrl,
      backgroundDataUrl,
      savePath,
    });
    res.status(201).json(entry);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Аналитика: время игры из трекера окон, статус бэклога и рекомендации под FPS.
router.get("/insights", (_req, res) => {
  const totals = appTime.totalsByApp();
  const items = games.list().map((g) => ({
    id: g.id,
    name: g.name,
    status: (g.status ?? "backlog") as gameInsights.GameStatus,
    playSeconds: gameInsights.playSecondsFor(g.exePath, totals),
    createdAt: g.createdAt,
  }));
  res.json({ items: gameInsights.backlogOrder(items) });
});

router.get("/recommend", (req, res) => {
  const fps = Math.min(360, Math.max(30, Number(req.query.fps) || 60));
  const height = Number(req.query.height) || 1080;
  const vram = Number(req.query.vram);
  res.json(
    gameInsights.recommend({
      gpuName: String(req.query.gpu ?? ""),
      vramMb: Number.isFinite(vram) && vram > 0 ? vram : null,
      targetFps: fps,
      height,
    }),
  );
});

// Замеры FPS (CSV PresentMon / CapFrameX / Afterburner) и их сравнение.
router.get("/bench", (req, res) => {
  res.json({ runs: gameBench.listRuns(req.query.gameId ? String(req.query.gameId) : undefined) });
});

router.post("/bench", (req, res) => {
  try {
    const { gameId, label, csv } = req.body || {};
    if (!gameId) return res.status(400).json({ error: "missing_game" });
    res.status(201).json(gameBench.addRunFromCsv(String(gameId), String(label || ""), String(csv || "")));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/bench/:id", (req, res) => {
  res.json({ ok: gameBench.removeRun(req.params.id) });
});

router.get("/bench/compare", (req, res) => {
  const runs = gameBench.listRuns();
  const a = runs.find((r) => r.id === String(req.query.before));
  const b = runs.find((r) => r.id === String(req.query.after));
  if (!a || !b) return res.status(404).json({ error: "not_found" });
  res.json({ before: a, after: b, diff: gameInsights.compareRuns(a.stats, b.stats) });
});

router.put("/:id", (req, res) => {
  try {
    const entry = games.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json(entry);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = games.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/launch", (req, res) => {
  try {
    res.json(games.launch(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/autoscan", async (req, res) => {
  try {
    res.json(await games.autoScan());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/save/backup", (req, res) => {
  try {
    res.json(games.backupSave(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/save/versions", (req, res) => {
  try {
    res.json(games.listSaveVersions(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/save/restore", (req, res) => {
  try {
    const file = (req.body && req.body.file) || "";
    if (!file) return res.status(400).json({ error: "missing_file" });
    res.json(games.restoreSave(req.params.id, file));
  } catch (e: any) {
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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export = router;
