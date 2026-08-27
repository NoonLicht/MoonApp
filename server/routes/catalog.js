const express = require("express");
const path = require("path");
const { stmts } = require("../db");
const { DIRS } = require("../config");
const { download, runInstaller } = require("../downloads");
const logger = require("../logger");

const router = express.Router();

// Список каталога (+ нормализация favorite в bool)
router.get("/", (req, res) => {
  res.json(stmts.catAll.all().map((a) => ({ ...a, favorite: !!a.favorite })));
});

// Добавить запись { name, url, category } — ручной источник "custom"
router.post("/", (req, res) => {
  const { name, url, category } = req.body || {};
  if (!name || !url || !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: "Нужны name и валидный http(s) url" });
  }
  const info = stmts.catInsert.run(String(name).trim(), String(url).trim(), "custom", category || "Other", null);
  const app = stmts.catGet.get(info.lastInsertRowid);
  logger.action("catalog.add", { id: app.id, name: app.name });
  res.status(201).json({ ...app, favorite: !!app.favorite });
});

// Удалить запись
router.delete("/:id", (req, res) => {
  stmts.catDelete.run(Number(req.params.id));
  logger.action("catalog.delete", { id: Number(req.params.id) });
  res.json({ ok: true });
});

// Переключить избранное
router.post("/:id/favorite", (req, res) => {
  const id = Number(req.params.id);
  const cur = stmts.catGet.get(id);
  if (!cur) return res.status(404).json({ error: "not found" });
  const next = !cur.favorite;
  stmts.catSetFavorite.run(id, next);
  logger.action("catalog.favorite", { id, val: next });
  res.json({ ok: true, favorite: next });
});

// Скачать установщик (без запуска)
router.post("/:id/download", async (req, res) => {
  try {
    const app = stmts.catGet.get(Number(req.params.id));
    if (!app) return res.status(404).json({ error: "not found" });
    const r = await download(app.url);
    logger.action("catalog.downloaded", { id: app.id, name: r.name });
    res.json({ ok: true, ...r });
  } catch (e) {
    logger.error("catalog.download_failed", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Скачать + установить (установка обычная, с окном)
router.post("/:id/download-and-install", async (req, res) => {
  try {
    const app = stmts.catGet.get(Number(req.params.id));
    if (!app) return res.status(404).json({ error: "not found" });
    const { file } = await download(app.url);
    const launch = runInstaller(file);
    logger.action("catalog.installed", { id: app.id, name: app.name, file: path.basename(file) });
    res.json({ ok: true, ...launch, file });
  } catch (e) {
    logger.error("catalog.install_failed", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Установить всё избранное (для восстановления после переустановки Windows)
router.post("/install-all", async (req, res) => {
  const onlyFavorites = req.body?.onlyFavorites !== false;
  const apps = stmts.catAll.all().filter((a) => (onlyFavorites ? a.favorite : true));
  const results = [];
  for (const app of apps) {
    try {
      const { file } = await download(app.url);
      runInstaller(file);
      results.push({ id: app.id, name: app.name, status: "ok", file: path.basename(file) });
    } catch (e) {
      results.push({ id: app.id, name: app.name, status: "error", error: e.message });
    }
  }
  logger.action("catalog.install_all", { onlyFavorites, total: apps.length });
  res.json({ ok: true, onlyFavorites, total: apps.length, results });
});

module.exports = router;