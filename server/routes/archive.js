"use strict";

/**
 * API Web Archive (.sitebak).
 *
 *  POST   /api/archive/start      — запуск краула { url, depth, domainScope, maxPages, imageMode, videoMode, videoCrf, stripScripts, inlineAssets, blockAds, stripExif, delayMs, concurrency, cookies, userAgent }
 *  GET    /api/archive/status/:id — статус задания (stage, pages, progress)
 *  GET    /api/archive/list       — список архивов со статистикой
 *  DELETE /api/archive/:id        — удалить архив (.sitebak + запись)
 *  POST   /api/archive/:id/verify — проверка SHA-256 целостности
 *  POST   /api/archive/:id/extract— извлечь ассеты в storage/sitebak/extracted
 *  GET    /api/archive/:id/file?path=x — офлайн-превью файла из архива
 *  GET    /api/archive/:id/download    — скачать .sitebak
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const engine = require("../sitebak");
const { DIRS } = require("../config");
const logger = require("../logger");

const router = express.Router();

const MIME = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

// Путь к .sitebak файлу архива — через DIRS (М1: storage может быть
// переопределён в Electron, cwd-хак сломался бы).
function bakFile(id) {
  const item = engine.loadArchiveList().find((a) => a.id === id);
  if (!item?.name) return null;
  const file = path.join(DIRS.sitebak, item.name);
  return fs.existsSync(file) ? file : null;
}

// К2: HTML из чужого сайта отдаётся ТОЛЬКО с вырезанными скриптами и жёстким
// CSP (script-src 'none'). Даже если архив снимался с stripScripts=false,
// превью не может стать вектором XSS против локального API (appBridge).
function serveHtml(res, buf) {
  const html = buf
    .toString("utf8")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, "")
    // Исходный сайт мог нести свой <meta http-equiv="Content-Security-Policy">
    // (частый случай на новостных/CMS-страницах) — он продолжает действовать
    // и внутри офлайн-копии, вместе с нашим заголовком CSP браузер применяет
    // ПЕРЕСЕЧЕНИЕ обеих политик. Если у исходного style-src нет
    // 'unsafe-inline', наши вшитые <style> (inlineAssets) блокируются
    // молча — страница выглядит "без стилей". Вырезаем донорский CSP.
    .replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; media-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; form-action 'none'",
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

router.post("/start", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "invalid_url" });
  // SSRF: без этой проверки краулер (следуя редиректам и ссылкам со страницы)
  // мог быть направлен на localhost/внутреннюю сеть пользователя — см.
  // isBlockedHost в server/ts/sitebak.ts (там же — проверка КАЖДОЙ найденной
  // ссылки в inScope, эта проверка — только для стартового URL).
  try {
    const host = new URL(url).hostname;
    if (engine.isBlockedHost(host)) {
      return res.status(400).json({ error: "blocked_host", code: "blocked_host" });
    }
  } catch {
    return res.status(400).json({ error: "invalid_url" });
  }
  const job = engine.startCrawl(req.body || {});
  logger.action("sitebak.start", { id: job.id, url });
  const { opts, ...rest } = job;
  res.status(201).json({ ...rest, opts: { ...opts, cookies: undefined } });
});

router.get("/status/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const { opts, ...rest } = job;
  res.json(rest);
});

// Остановить активный краул (Диспетчер фоновых задач). Уже посещённые
// страницы упаковываются в частичный .sitebak, а не пропадают.
router.post("/:id/cancel", (req, res) => {
  const ok = engine.cancelJob(req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found_or_done" });
  res.json({ ok: true });
});

router.get("/list", (req, res) => res.json(engine.loadArchiveList()));

router.delete("/:id", (req, res) => {
  const ok = engine.deleteArchive(req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  logger.action("sitebak.delete", { id: req.params.id });
  res.json({ ok: true });
});

router.post("/:id/verify", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  try {
    res.json(engine.verify(file));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/extract", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  try {
    const dir = engine.extractTo(file, req.params.id);
    logger.action("sitebak.extract", { id: req.params.id });
    res.json({ ok: true, dir: path.basename(dir), files: fs.readdirSync(dir).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Офлайн-превью: файл распаковывается на лету из .sitebak и отдаётся.
// path строго валидируется (запрет traversal). HTML — через serveHtml (К2).
//
// Файл ищется не только по точному ключу: архивы, собранные до исправления карты
// ссылок, ссылаются на .jpg, хотя картинка перекодирована в .webp — из-за этого
// в превью были битые фото (см. findEntry).
function findEntry(entries, rel) {
  const direct = entries.get(rel);
  if (direct) return { entry: direct, rel };
  const stem = String(rel).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  if (!stem) return null;
  for (const [key, entry] of entries) {
    if (key.replace(/\.[a-z0-9]+$/i, "").toLowerCase() === stem) return { entry, rel: key };
  }
  return null;
}

/** Отдать найденную запись: HTML — с вырезанными скриптами, остальное — по MIME. */
function sendEntry(res, rel, entry) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".html" || ext === ".htm") return serveHtml(res, entry.buf);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.send(entry.buf);
}

router.get("/:id/file", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  try {
    const rel = String(req.query.path || "");
    if (!rel || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) {
      return res.status(400).json({ error: "bad_path" });
    }
    const { entries } = engine.readBak(file);
    const found = findEntry(entries, rel);
    if (!found) return res.status(404).json({ error: "no_entry" });
    sendEntry(res, found.rel, found.entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Раздача файлов архива для перезаписанных ссылок (/raw/<rel>).
router.get("/:id/raw/*", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  try {
    const rel = decodeURIComponent(req.params[0] || "");
    if (!rel || rel.includes("..")) return res.status(400).json({ error: "bad_path" });
    const { entries } = engine.readBak(file);
    const found = findEntry(entries, rel);
    if (!found) return res.status(404).json({ error: "no_entry" });
    sendEntry(res, found.rel, found.entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Встроенный просмотр архива ====================
//
// GET /api/archive/:id/pages — список страниц архива для открытия внутри
// приложения: путь внутри .sitebak, заголовок <title> и (если сохранился)
// исходный адрес. Сама страница отдаётся уже существующим /:id/file (или
// /:id/raw/*, куда переписаны ссылки), поэтому iframe грузит её как обычный
// документ: ссылки внутри архива ведут на те же локальные адреса, картинки —
// на /raw/<файл>. Скрипты в HTML вырезаны, CSP жёсткий (serveHtml).

/** HTML-сущности в заголовке: «&amp;» в <title> иначе виден как есть. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Заголовок страницы из HTML (длинные обрезаем — это подпись в списке). */
function pageTitle(html, rel) {
  const m = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
  const title = m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
  return (title || rel.replace(/\.html?$/i, "")).slice(0, 160);
}

/**
 * Исходный адрес страницы (canonical / og:url). В самом архиве ссылки уже
 * переписаны на локальные (/api/archive/...), поэтому такие значения
 * отбрасываем — показывать «свой же» адрес бессмысленно.
 */
function pageUrl(html) {
  const m =
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html);
  const url = m ? decodeEntities(m[1]) : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

router.get("/:id/pages", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  try {
    const { manifest, entries } = engine.readBak(file);
    const pages = [];
    for (const [rel, entry] of entries) {
      if (!entry.text || !/\.(html?|xhtml)$/i.test(rel)) continue;
      const html = entry.buf.toString("utf8");
      pages.push({
        path: rel,
        title: pageTitle(html, rel),
        url: pageUrl(html),
        size: entry.buf.length,
      });
      // Предохранитель: гигантский архив не должен отдавать бесконечный список.
      if (pages.length >= 2000) break;
    }
    pages.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    logger.action("sitebak.pages", { id: req.params.id, pages: pages.length });
    res.json({
      id: req.params.id,
      site: manifest.site || "",
      name: manifest.name || "",
      total: pages.length,
      pages,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/download", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  res.download(
    file,
    engine.loadArchiveList().find((a) => a.id === req.params.id)?.name || "archive.sitebak",
  );
});

// М5: путь распакованной копии для «Reveal in File Explorer».
router.get("/:id/reveal", (req, res) => {
  const file = bakFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  res.json({ path: file });
});

module.exports = router;
