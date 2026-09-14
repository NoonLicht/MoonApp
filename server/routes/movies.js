"use strict";

/**
 * API страницы «Фильмы и Сериалы» (id страницы: movies).
 *
 * Разделы:
 *  1) Каталог/метаданные (TMDB, server/tmdb.js) — тренды, подборки, поиск,
 *     детали, жанры, discover, «где легально смотреть».
 *  2) Личная библиотека и статистика — список просмотра, оценки 1–10,
 *     часы просмотра, любимые жанры/актёры (хранится в server/db.js).
 *  3) Торрент-плеер — воспроизведение торрента, который пользователь открыл САМ
 *     (magnet/.torrent): server/torrent.js + HTTP Range-стриминг для <video>.
 *     Приложение НЕ ищет торренты и не парсит трекеры.
 *
 * Все внешние запросы TMDB уважают per-page прокси (см. server/tmdb.js).
 */

const express = require("express");
const tmdb = require("../tmdb");
const torrent = require("../torrent");
const settings = require("../settings");
const { setSecret, hasSecret } = require("../security");
const { stmts } = require("../db");
const logger = require("../logger");

const router = express.Router();

/** Код ошибки → HTTP-статус (чтобы фронт мог показать понятный текст). */
function statusForCode(code) {
  switch (code) {
    case "no_api_key":
    case "bad_api_key":
    case "bad_kind":
    case "bad_id":
    case "bad_source":
      return 400;
    case "not_found":
    case "no_torrent":
      return 404;
    case "rate_limited":
      return 429;
    case "engine_missing":
      return 501;
    case "image_unavailable":
      return 502; // CDN картинок недоступен (нет сети/прокси) — фронт покажет заглушку
    case "bad_size":
    case "bad_path":
      return 400;
    case "metadata_timeout":
      return 504;
    default:
      return 500;
  }
}

/** Единый обработчик ошибок роутов: { error, code } + лог. */
function fail(res, e, ctx) {
  const code = e?.code || "error";
  logger.error("movies." + (ctx || "request"), { error: e?.message, code });
  res.status(statusForCode(code)).json({ error: e?.message || "error", code });
}

/** Обёртка async-роутов. */
const wrap = (fn) => (req, res) => { Promise.resolve(fn(req, res)).catch((e) => fail(res, e, req.path)); };

const parseInt01 = (v, d = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
};

/* ==================== 1. Статус и API-ключ TMDB ==================== */

router.get("/status", (req, res) => {
  let cfg = {};
  try { cfg = settings.get("movies") || {}; } catch { /* ignore */ }
  res.json({
    hasKey: hasSecret("tmdb"),
    engine: torrent.engineStatus(),
    settings: cfg,
  });
});

router.post("/key", (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!key) return res.status(400).json({ error: "missing key", code: "no_api_key" });
    setSecret("tmdb", key);
    logger.action("movies.tmdb_key_saved");
    res.json({ ok: true, hasKey: true });
  } catch (e) { fail(res, e, "key"); }
});

/** Сбросить кэш метаданных TMDB. */
router.post("/refresh", (req, res) => {
  tmdb.clearCache();
  logger.action("movies.cache_refresh");
  res.json({ ok: true });
});

/**
 * Прокси картинок TMDB: /api/movies/image?s=w500&p=/abc.jpg
 *
 * Зачем: <img src="https://image.tmdb.org/..."> грузит Chromium НАПРЯМУЮ,
 * в обход per-page прокси, поэтому при блокировке TMDB (и из-за CSP
 * img-src 'self') постеры не отображались. Здесь картинка идёт через тот же
 * прокси, что и API-запросы страницы «movies».
 *
 * Роут намеренно без токена (см. server/index.js): <img> не умеет слать
 * заголовки. Безопасность обеспечивается жёсткой валидацией — хост всегда
 * image.tmdb.org, size из allowlist, path вида /file.jpg (без «..», без query).
 */
router.get("/image", wrap(async (req, res) => {
  const { key, etag } = tmdb.imageKey(req.query.s, req.query.p);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  if (req.get("if-none-match") === etag) return res.status(304).end();

  const img = await tmdb.fetchImage(req.query.s, req.query.p);
  res.setHeader("Content-Type", img.contentType);
  res.setHeader("X-Moon-Img", img.cached ? "hit" : "miss");
  logger.debug("movies.image", { key, cached: img.cached });
  res.end(img.buffer);
}));

/* ==================== 2. Каталог (TMDB) ==================== */

router.get("/trending", wrap(async (req, res) => {
  const kind = tmdb.normKind(req.query.kind || "movie");
  res.json(await tmdb.trending(kind, req.query.window === "day" ? "day" : "week", parseInt01(req.query.page)));
}));

router.get("/list", wrap(async (req, res) => {
  const kind = tmdb.normKind(req.query.kind || "movie");
  res.json(await tmdb.list(kind, String(req.query.category || "popular"), parseInt01(req.query.page)));
}));

router.get("/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ items: [], page: 1, totalPages: 1 });
  const kind = String(req.query.kind || "multi");
  res.json(await tmdb.search(q, kind, parseInt01(req.query.page)));
}));

router.get("/genres", wrap(async (req, res) => {
  res.json(await tmdb.genres(tmdb.normKind(req.query.kind || "movie")));
}));

router.get("/discover", wrap(async (req, res) => {
  const kind = tmdb.normKind(req.query.kind || "movie");
  res.json(await tmdb.discover(kind, {
    genre: req.query.genre,
    year: req.query.year,
    sort: req.query.sort,
    page: parseInt01(req.query.page),
  }));
}));

router.get("/providers/:kind/:id", wrap(async (req, res) => {
  res.json(await tmdb.watchProviders(tmdb.normKind(req.params.kind), req.params.id));
}));

router.get("/details/:kind/:id", wrap(async (req, res) => {
  res.json(await tmdb.details(tmdb.normKind(req.params.kind), req.params.id));
}));

/* ==================== 3. Личная библиотека и статистика ==================== */

/** Разобрать строку-массив (genres/cast) в массив (безопасно). */
function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

router.get("/library", (req, res) => {
  const watchlist = stmts.mwAll.all().map((r) => ({ ...r, genres: parseArr(r.genres) }));
  const ratings = stmts.mrAll.all();
  const stats = stmts.msAll.all().map((r) => ({ ...r, genres: parseArr(r.genres), cast: parseArr(r.cast) }));
  res.json({ watchlist, ratings, stats });
});

/** Состояние одного тайтла: в списке? оценка? просмотрено? */
router.get("/state/:kind/:id", (req, res) => {
  const kind = tmdb.normKind(req.params.kind);
  const id = Number(req.params.id);
  res.json({
    watchlist: stmts.mwGet.get(kind, id),
    rating: stmts.mrGet.get(kind, id),
    watch: stmts.msGet.get(kind, id),
  });
});

const STATUSES = ["plan", "watching", "watched"];

/** Добавить/обновить запись списка просмотра. */
router.post("/watchlist", (req, res) => {
  try {
    const kind = tmdb.normKind(req.body?.kind);
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "bad id", code: "bad_id" });
    const status = STATUSES.includes(req.body?.status) ? req.body.status : "plan";
    stmts.mwUpsert.run(kind, id, {
      title: String(req.body?.title || ""),
      poster: String(req.body?.poster || ""),
      year: req.body?.year != null ? Number(req.body.year) : null,
      runtime: req.body?.runtime != null ? Number(req.body.runtime) : null,
      genres: JSON.stringify(Array.isArray(req.body?.genres) ? req.body.genres : []),
      status,
    });
    // «Просмотрено» — сразу фиксируем факт просмотра в статистике.
    if (status === "watched") {
      stmts.msUpsert.run(kind, id, {
        title: String(req.body?.title || ""),
        genres: JSON.stringify(Array.isArray(req.body?.genres) ? req.body.genres : []),
        runtime: req.body?.runtime != null ? Number(req.body.runtime) : null,
        progress: 1,
      });
    }
    logger.action("movies.watchlist_set", { kind, id, status });
    res.json({ ok: true, watchlist: stmts.mwGet.get(kind, id) });
  } catch (e) { fail(res, e, "watchlist"); }
});

router.delete("/watchlist/:kind/:id", (req, res) => {
  try {
    stmts.mwDelete.run(tmdb.normKind(req.params.kind), Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e, "watchlist_delete"); }
});

/** Оценка 1–10. rating = 0 → снять оценку. */
router.post("/rate", (req, res) => {
  try {
    const kind = tmdb.normKind(req.body?.kind);
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "bad id", code: "bad_id" });
    const rating = Math.max(0, Math.min(10, Math.round(Number(req.body?.rating) || 0)));
    if (rating === 0) stmts.mrDelete.run(kind, id);
    else stmts.mrSet.run(kind, id, String(req.body?.title || ""), rating);
    logger.action("movies.rate", { kind, id, rating });
    res.json({ ok: true, rating: stmts.mrGet.get(kind, id) });
  } catch (e) { fail(res, e, "rate"); }
});

/** Отметить просмотр/прогресс (идёт в статистику). */
router.post("/watch", (req, res) => {
  try {
    const kind = tmdb.normKind(req.body?.kind);
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "bad id", code: "bad_id" });
    const runtime = req.body?.runtime != null ? Number(req.body.runtime) : null;
    const progress = Math.max(0, Math.min(1, Number(req.body?.progress ?? 1)));
    const minutes = runtime ? Math.round(runtime * progress) : 0;
    stmts.msUpsert.run(kind, id, {
      title: String(req.body?.title || ""),
      genres: JSON.stringify(Array.isArray(req.body?.genres) ? req.body.genres : []),
      cast: JSON.stringify(Array.isArray(req.body?.cast) ? req.body.cast.slice(0, 12) : []),
      runtime, progress, minutes,
    });
    logger.action("movies.watch", { kind, id, progress });
    res.json({ ok: true });
  } catch (e) { fail(res, e, "watch"); }
});

router.delete("/watch/:kind/:id", (req, res) => {
  try {
    stmts.msDelete.run(tmdb.normKind(req.params.kind), Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e, "watch_delete"); }
});

/** Агрегированная статистика просмотров. */
router.get("/stats", (req, res) => {
  const stats = stmts.msAll.all();
  const ratings = stmts.mrAll.all();
  const watchlist = stmts.mwAll.all();

  let minutes = 0;
  let completed = 0;
  const genreCount = new Map();
  const actorCount = new Map();
  const monthCount = new Map();

  for (const s of stats) {
    minutes += Number(s.minutes) || 0;
    if ((Number(s.progress) || 0) >= 0.9) completed++;
    for (const g of parseArr(s.genres)) {
      const name = typeof g === "string" ? g : g?.name;
      if (name) genreCount.set(name, (genreCount.get(name) || 0) + 1);
    }
    for (const a of parseArr(s.cast)) {
      const name = typeof a === "string" ? a : a?.name;
      if (name) actorCount.set(name, (actorCount.get(name) || 0) + 1);
    }
    const m = /^(\d{4})-(\d{2})/.exec(String(s.watched_at || ""));
    if (m) {
      const key = `${m[1]}-${m[2]}`;
      monthCount.set(key, (monthCount.get(key) || 0) + 1);
    }
  }

  const top = (map, n) => [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);

  const byStatus = { plan: 0, watching: 0, watched: 0 };
  for (const w of watchlist) if (byStatus[w.status] != null) byStatus[w.status]++;

  const ratingHistogram = Array.from({ length: 10 }, (_, i) => ({ value: i + 1, count: 0 }));
  let ratingSum = 0;
  for (const r of ratings) {
    const v = Math.round(Number(r.rating) || 0);
    if (v >= 1 && v <= 10) { ratingHistogram[v - 1].count++; ratingSum += v; }
  }

  res.json({
    totalTitles: stats.length,
    totalMinutes: minutes,
    totalHours: Math.round((minutes / 60) * 10) / 10,
    completed,
    watchlist: byStatus,
    avgRating: ratings.length ? Math.round((ratingSum / ratings.length) * 10) / 10 : 0,
    ratingCount: ratings.length,
    ratingHistogram,
    topGenres: top(genreCount, 8),
    topActors: top(actorCount, 8),
    monthly: [...monthCount.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-6),
  });
});

router.post("/stats/clear", (req, res) => {
  stmts.msClear.run();
  logger.action("movies.stats_clear");
  res.json({ ok: true });
});

/* ==================== 4. Торрент-плеер (источник задаёт пользователь) ==================== */

router.get("/torrent/engine", (req, res) => {
  res.json(torrent.engineStatus());
});

router.get("/torrent/active", (req, res) => {
  res.json(torrent.active());
});

/**
 * Добавить торрент: { magnet } ИЛИ { torrent: "<base64 .torrent>" }.
 * Приложение не ищет торренты — источник передаёт сам пользователь.
 */
router.post("/torrent/add", wrap(async (req, res) => {
  const magnet = String(req.body?.magnet || "").trim();
  const b64 = String(req.body?.torrent || "").trim();
  let source;
  if (magnet) {
    if (!/^magnet:\?/i.test(magnet)) return res.status(400).json({ error: "not a magnet link", code: "bad_source" });
    source = magnet;
  } else if (b64) {
    source = Buffer.from(b64, "base64");
    if (!source.length) return res.status(400).json({ error: "empty .torrent payload", code: "bad_source" });
  } else {
    return res.status(400).json({ error: "magnet or torrent required", code: "bad_source" });
  }
  res.json(await torrent.add(source));
}));

router.get("/torrent/status/:infoHash", (req, res) => {
  const st = torrent.status(req.params.infoHash);
  if (!st) return res.status(404).json({ error: "torrent not found", code: "no_torrent" });
  res.json(st);
});

router.get("/torrent/file/:infoHash/:index", (req, res) => {
  try {
    res.json(torrent.streamInfo(req.params.infoHash, Number(req.params.index)));
  } catch (e) { fail(res, e, "torrent_file"); }
});

/**
 * Стрим файла торрента для HTML5 <video>: поддержка HTTP Range (206).
 * Видео запрашивает байтовые диапазоны по мере воспроизведения — WebTorrent
 * качает именно нужные куски, поэтому старт почти мгновенный.
 */
router.get("/torrent/stream/:infoHash/:index", (req, res) => {
  const infoHash = req.params.infoHash;
  const idx = Number(req.params.index);
  let info;
  try {
    info = torrent.streamInfo(infoHash, idx);
  } catch (e) { return fail(res, e, "torrent_stream"); }

  const total = info.length;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", info.mime);
  // Разрешаем <video> в этом же origin читать поток.
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(info.name)}"`);

  let stream;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : Math.min(start + 1_500_000, total - 1);
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) return res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));
    stream = torrent.createReadStream(infoHash, idx, { start, end });
  } else {
    res.status(200);
    res.setHeader("Content-Length", String(total));
    stream = torrent.createReadStream(infoHash, idx, {});
  }

  // Если клиент отключился (перемотка/закрытие) — гасим поток.
  req.on("close", () => { try { stream.destroy(); } catch { /* ignore */ } });
  stream.on("error", (e) => {
    logger.error("movies.torrent_stream_error", { infoHash, error: e?.message });
    if (!res.headersSent) res.status(500);
    try { res.end(); } catch { /* ignore */ }
  });
  stream.pipe(res);
});

router.delete("/torrent/:infoHash", (req, res) => {
  res.json(torrent.remove(req.params.infoHash));
});

module.exports = router;