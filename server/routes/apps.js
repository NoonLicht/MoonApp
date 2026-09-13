const express = require("express");
const path = require("path");
const { stmts } = require("../db");
const { download, runInstaller } = require("../downloads");
const winget = require("../winget");
const comss = require("../comss");
const logger = require("../logger");

const router = express.Router();

/** Стартовый список winget: seed + полный индекс (если готов). */
function wingetPackages() {
  const map = new Map();
  for (const p of winget.seed()) map.set(p.id, p);
  for (const p of winget.readIndex() || []) if (!map.has(p.id)) map.set(p.id, p);
  return [...map.values()];
}

function favSet() {
  return new Set(stmts.favAll.all().map((f) => f.key));
}

/** Объединённый список: winget (seed+индекс) + каталог (custom/comss). */
function getItems() {
  const favs = favSet();
  const wingetApps = wingetPackages().map((p) => ({
    key: `winget:${p.id}`,
    name: p.name,
    category: p.category || "winget",
    source: "winget",
    wingetId: p.id,
    version: p.version,
    favorite: favs.has(`winget:${p.id}`),
  }));

  const catalogApps = stmts.catAll.all().map((a) => ({
    key: `catalog:${a.id}`,
    id: a.id,
    name: a.name,
    url: a.url,
    category: a.category,
    source: a.source,
    favorite: favs.has(`catalog:${a.id}`) || !!a.favorite,
  }));

  return { ready: true, items: [...wingetApps, ...catalogApps] };
}

router.get("/", (req, res) => {
  res.json(getItems());
});

// Переключить избранное по ключу (winget:<id> | catalog:<id>)
router.post("/favorite", (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "missing key" });
  const has = stmts.favHas(key);
  if (has) stmts.favRemove(key); else stmts.favAdd(key);
  logger.action("apps.favorite", { key, val: !has });
  res.json({ ok: true, favorite: !has });
});

// Установка по ключу
router.post("/install", async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "missing key" });
  try {
    if (key.startsWith("winget:")) {
      const id = key.slice(7);
      const r = await winget.install(id);
      res.json({ ok: r.ok, method: "winget", id, tail: r.tail });
      return;
    }
    if (key.startsWith("catalog:")) {
      const app = stmts.catGet.get(Number(key.slice(8)));
      if (!app) return res.status(404).json({ error: "not found" });
      const { file } = await download(app.url);
      const launch = runInstaller(file);
      res.json({ ok: true, method: "catalog", file, ...launch });
      return;
    }
    res.status(400).json({ error: "bad key" });
  } catch (e) {
    logger.error("apps.install_error", { key, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Скачивание установщика без установки (кнопка «Скачать» на карточке).
router.post("/download", async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "missing key" });
  try {
    if (key.startsWith("winget:")) {
      const id = key.slice(7);
      const r = await winget.downloadPackage(id);
      if (!r.ok) return res.status(500).json({ error: "winget download failed", tail: r.tail });
      res.json({ ok: true, method: "winget", id, file: r.file, dir: r.dir });
      return;
    }
    if (key.startsWith("catalog:")) {
      const app = stmts.catGet.get(Number(key.slice(8)));
      if (!app) return res.status(404).json({ error: "not found" });
      const { file } = await download(app.url);
      res.json({ ok: true, method: "catalog", file });
      return;
    }
    res.status(400).json({ error: "bad key" });
  } catch (e) {
    logger.error("apps.download_error", { key, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Живой поиск по winget
router.get("/winget/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json([]);
  try {
    const found = await winget.search(q);
    const favs = favSet();
    res.json(found.map((p) => ({
      key: `winget:${p.id}`,
      name: p.name, category: "winget", source: "winget",
      wingetId: p.id, version: p.version,
      favorite: favs.has(`winget:${p.id}`),
    })));
  } catch (e) {
    logger.error("winget.search_error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Принудительно обновить seed не нужно — список курируемый, поиск живёт в /winget/search.

// Статус индексации полного каталога winget
router.get("/winget/status", (req, res) => {
  res.json(winget.indexStatus());
});

// Запустить фоновую индексацию каталога winget (a-z, 0-9)
router.post("/winget/index", (req, res) => {
  winget.startIndexing();
  res.json(winget.indexStatus());
});

// Рубрики comss
router.get("/comss/categories", (req, res) => {
  res.json(comss.CATEGORIES);
});

// Скрейпинг comss — запуск фонового джоба с прогрессом
// (джобы удаляются через 10 минут после завершения — без утечки памяти)
const COMSS_JOB_TTL_MS = 10 * 60 * 1000;
const comssJobs = {};
let comssSeq = 0;

function finishComssJob(job) {
  setTimeout(() => { delete comssJobs[job.id]; }, COMSS_JOB_TTL_MS).unref?.();
}

router.post("/comss/scrape", (req, res) => {
  const codes = (req.body?.categories) || comss.CATEGORIES.map((c) => c.code);
  const limit = Math.min(Number(req.body?.limit) || 0, 100); // 0 = без ограничения (все карточки рубрики)
  const cats = comss.CATEGORIES.filter((c) => codes.includes(c.code));
  const jobId = "comss-" + (++comssSeq);
  const job = { id: jobId, status: "running", done: 0, total: cats.length, current: "", items: [] };
  comssJobs[jobId] = job;
  comss.scrapeWithProgress(cats, limit, (info) => {
    job.done = info.done;
    job.total = info.total;
    job.current = info.current;
    job.items = info.items;
  }).then(() => { job.status = "done"; finishComssJob(job); })
    .catch((e) => { job.status = "error"; job.error = e.message; finishComssJob(job); });
  res.json({ ok: true, jobId });
});

// Прогресс джоба comss
router.get("/comss/progress", (req, res) => {
  const job = comssJobs[req.query.job];
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ id: job.id, status: job.status, done: job.done, total: job.total, current: job.current, items: job.items, error: job.error });
});

// Импорт найденного с comss с дедупликацией (winget приоритетнее)
function normName(name) {
  return String(name || "").toLowerCase()
    .replace(/\([^)]*\)/g, "")       // убираем скобки-уточнения: "VS Code (VS Code)"
    .replace(/[^a-zа-я0-9ё\s]/gi, "") // только буквы/цифры/пробелы
    .replace(/\s+/g, " ")
    .trim();
}

router.post("/comss/import", (req, res) => {
  const items = req.body?.items || [];
  const wingetNames = new Set(winget.seed().map((p) => normName(p.name)));
  const catalogNames = new Set(stmts.catAll.all().map((a) => normName(a.name)));
  const seen = new Set();
  let added = 0, skipped = 0;
  for (const it of items) {
    const name = String(it.name || "").trim();
    if (!name || !it.url) { skipped++; continue; }
    const lower = normName(name);
    if (!lower) { skipped++; continue; }
    if (seen.has(lower)) { skipped++; continue; }
    seen.add(lower);
    if (catalogNames.has(lower)) { skipped++; continue; }      // уже в каталоге
    if (wingetNames.has(lower)) { skipped++; continue; }       // есть в winget → предпочитаем winget
    stmts.catInsert.run(name, it.url, "comss", it.category || "Other", null);
    catalogNames.add(lower);
    added++;
  }
  logger.action("comss.import", { added, skipped });
  res.json({ ok: true, added, skipped });
});

module.exports = router;