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
const tracker = require("../trackerScraper");
const mediaProbe = require("../mediaProbe");
const config = require("../config");
const settings = require("../settings");
// hasSecret здесь больше не нужен: «есть ли ключ» решает сам tmdb (свой секрет
// ИЛИ вшитый в сборку ключ) — см. tmdb.hasKey() в /status ниже.
const { setSecret } = require("../security");
const { stmts } = require("../db");
const logger = require("../logger");

const router = express.Router();

/** Код ошибки → HTTP-статус (чтобы фронт мог показать понятный текст). */
function statusForCode(code) {
  switch (code) {
    // Ошибки входных данных: TMDB, форум-трекер, работа с дорожками.
    case "no_api_key":
    case "bad_api_key":
    case "bad_kind":
    case "bad_id":
    case "bad_source":
    case "bad_query":
    case "bad_release":
    case "bad_track":
    case "bad_file":
    case "tracker_disabled":
    case "no_credentials":
    case "subtitle_unsupported":
      return 400;
    case "not_found":
    case "no_torrent":
    case "no_media_files":
      return 404;
    case "rate_limited":
      return 429;
    // 409, а не 401: 401 зарезервирован middleware токена, и фронт (api.req)
    // обрабатывает его иначе.
    case "login_failed":
    case "captcha_required":
    case "session_expired":
      return 409;
    // FFmpeg-сборка: нет движка, нет ffmpeg, а также сборка без H.264-энкодера —
    // перекодирование невозможно. Это не «сбой потока», а отсутствие инструмента
    // (см. mediaProbe.pickH264Encoder), поэтому ответ отдельный — 501.
    case "engine_missing":
    case "ffmpeg_missing":
    case "ffmpeg_encoder_missing":
      return 501;
    // Внешний источник недоступен или не разобран: CDN картинок TMDB, форум,
    // ffprobe на потоке торрента.
    case "image_unavailable":
    case "parse_failed":
    case "network_error":
    case "torrent_download_failed":
    case "probe_failed":
    case "subtitle_failed":
      return 502;
    case "bad_size":
    case "bad_path":
      return 400;
    case "cf_challenge":
      return 502; // форум отдал проверку Cloudflare — нужен прокси/куки из браузера
    case "metadata_timeout":
      return 504;
    default:
      return 500;
  }
}

/** Единый обработчик ошибок роутов: { error, code, details } + лог. */
function fail(res, e, ctx) {
  const code = e?.code || "error";
  logger.error("movies." + (ctx || "request"), { error: e?.message, code, details: e?.details });
  // details — диагностика внешнего источника (статус, размер, начало текста):
  // без неё «разметка изменилась» невозможно ни объяснить, ни починить.
  res
    .status(statusForCode(code))
    .json({ error: e?.message || "error", code, details: e?.details || null });
}

/** Обёртка async-роутов. */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => fail(res, e, req.path));
};

const parseInt01 = (v, d = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
};

/* ==================== 1. Статус и API-ключ TMDB ==================== */

router.get("/status", (req, res) => {
  let cfg = {};
  try {
    cfg = settings.get("movies") || {};
  } catch {
    /* ignore */
  }
  res.json({
    hasKey: tmdb.hasKey(),
    // secret — ключ пользователя, bundled — вшитый в сборку, none — нет ключа:
    // страница по этому полю объясняет, откуда взялся ключ и нужен ли свой.
    keySource: tmdb.keySource(),
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
  } catch (e) {
    fail(res, e, "key");
  }
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
router.get(
  "/image",
  wrap(async (req, res) => {
    const { key, etag } = tmdb.imageKey(req.query.s, req.query.p);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    if (req.get("if-none-match") === etag) return res.status(304).end();

    const img = await tmdb.fetchImage(req.query.s, req.query.p);
    res.setHeader("Content-Type", img.contentType);
    res.setHeader("X-Moon-Img", img.cached ? "hit" : "miss");
    logger.debug("movies.image", { key, cached: img.cached });
    res.end(img.buffer);
  }),
);

/* ==================== 2. Каталог (TMDB) ==================== */

router.get(
  "/trending",
  wrap(async (req, res) => {
    const kind = tmdb.normKind(req.query.kind || "movie");
    res.json(
      await tmdb.trending(
        kind,
        req.query.window === "day" ? "day" : "week",
        parseInt01(req.query.page),
      ),
    );
  }),
);

router.get(
  "/list",
  wrap(async (req, res) => {
    const kind = tmdb.normKind(req.query.kind || "movie");
    res.json(
      await tmdb.list(kind, String(req.query.category || "popular"), parseInt01(req.query.page)),
    );
  }),
);

router.get(
  "/search",
  wrap(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ items: [], page: 1, totalPages: 1 });
    const kind = String(req.query.kind || "multi");
    res.json(await tmdb.search(q, kind, parseInt01(req.query.page)));
  }),
);

router.get(
  "/genres",
  wrap(async (req, res) => {
    res.json(await tmdb.genres(tmdb.normKind(req.query.kind || "movie")));
  }),
);

router.get(
  "/discover",
  wrap(async (req, res) => {
    const kind = tmdb.normKind(req.query.kind || "movie");
    res.json(
      await tmdb.discover(kind, {
        genre: req.query.genre,
        year: req.query.year,
        sort: req.query.sort,
        page: parseInt01(req.query.page),
      }),
    );
  }),
);

router.get(
  "/providers/:kind/:id",
  wrap(async (req, res) => {
    res.json(await tmdb.watchProviders(tmdb.normKind(req.params.kind), req.params.id));
  }),
);

router.get(
  "/details/:kind/:id",
  wrap(async (req, res) => {
    res.json(await tmdb.details(tmdb.normKind(req.params.kind), req.params.id));
  }),
);

/* ==================== 3. Личная библиотека и статистика ==================== */

/** Разобрать строку-массив (genres/cast) в массив (безопасно). */
function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

router.get("/library", (req, res) => {
  const watchlist = stmts.mwAll.all().map((r) => ({ ...r, genres: parseArr(r.genres) }));
  const ratings = stmts.mrAll.all();
  const stats = stmts.msAll
    .all()
    .map((r) => ({ ...r, genres: parseArr(r.genres), cast: parseArr(r.cast) }));
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
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "bad id", code: "bad_id" });
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
  } catch (e) {
    fail(res, e, "watchlist");
  }
});

router.delete("/watchlist/:kind/:id", (req, res) => {
  try {
    stmts.mwDelete.run(tmdb.normKind(req.params.kind), Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "watchlist_delete");
  }
});

/** Оценка 1–10. rating = 0 → снять оценку. */
router.post("/rate", (req, res) => {
  try {
    const kind = tmdb.normKind(req.body?.kind);
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "bad id", code: "bad_id" });
    const rating = Math.max(0, Math.min(10, Math.round(Number(req.body?.rating) || 0)));
    if (rating === 0) stmts.mrDelete.run(kind, id);
    else stmts.mrSet.run(kind, id, String(req.body?.title || ""), rating);
    logger.action("movies.rate", { kind, id, rating });
    res.json({ ok: true, rating: stmts.mrGet.get(kind, id) });
  } catch (e) {
    fail(res, e, "rate");
  }
});

/** Отметить просмотр/прогресс (идёт в статистику). */
router.post("/watch", (req, res) => {
  try {
    const kind = tmdb.normKind(req.body?.kind);
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "bad id", code: "bad_id" });
    const runtime = req.body?.runtime != null ? Number(req.body.runtime) : null;
    const progress = Math.max(0, Math.min(1, Number(req.body?.progress ?? 1)));
    const minutes = runtime ? Math.round(runtime * progress) : 0;
    stmts.msUpsert.run(kind, id, {
      title: String(req.body?.title || ""),
      genres: JSON.stringify(Array.isArray(req.body?.genres) ? req.body.genres : []),
      cast: JSON.stringify(Array.isArray(req.body?.cast) ? req.body.cast.slice(0, 12) : []),
      runtime,
      progress,
      minutes,
    });
    logger.action("movies.watch", { kind, id, progress });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "watch");
  }
});

router.delete("/watch/:kind/:id", (req, res) => {
  try {
    stmts.msDelete.run(tmdb.normKind(req.params.kind), Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "watch_delete");
  }
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

  const top = (map, n) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);

  const byStatus = { plan: 0, watching: 0, watched: 0 };
  for (const w of watchlist) if (byStatus[w.status] != null) byStatus[w.status]++;

  const ratingHistogram = Array.from({ length: 10 }, (_, i) => ({ value: i + 1, count: 0 }));
  let ratingSum = 0;
  for (const r of ratings) {
    const v = Math.round(Number(r.rating) || 0);
    if (v >= 1 && v <= 10) {
      ratingHistogram[v - 1].count++;
      ratingSum += v;
    }
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
 * Вкладка «Скачанные»: реестр загрузок с живым прогрессом.
 * keepDefault — состояние галочки «хранить после просмотра» для НОВЫХ загрузок
 * (per-download флаг хранится в самом реестре).
 */
router.get("/torrent/downloads", (req, res) => {
  res.json({ items: torrent.listDownloads(), keepDefault: torrent.keepFilesByDefault() });
});

/** Остановить загрузку (пауза): канал освобождается, скачанное остаётся на диске. */
router.post("/torrent/stop", (req, res) => {
  res.json(torrent.stopDownload(req.body?.infoHash));
});

/** Возобновить остановленную загрузку по сохранённому .torrent-метафайлу/magnet. */
router.post(
  "/torrent/resume",
  wrap(async (req, res) => {
    res.json(await torrent.resumeDownload(req.body?.infoHash));
  }),
);

/**
 * Галочка «хранить скачанный торрент после просмотра»:
 *  - { infoHash, keep } — для конкретной раздачи (плеер и вкладка «Скачанные»);
 *  - { saveDefault: true, keep } — общая настройка для новых загрузок. При
 *    выключении сразу освобождаем место: завершённые раздачи, которые никто не
 *    просил хранить, удаляются (purgeUnkept).
 */
router.post("/torrent/keep", (req, res) => {
  try {
    const keep = !!req.body?.keep;
    if (req.body?.saveDefault) {
      settings.set({ movies: { keepTorrentFiles: keep } });
      logger.action("movies.torrent_keep_default", { keep });
    }
    const infoHash = String(req.body?.infoHash || "");
    if (/^[a-f0-9]{40}$/i.test(infoHash)) torrent.setDownloadKept(infoHash, keep);
    const purged = keep ? 0 : torrent.purgeUnkept();
    res.json({ ok: true, keep, keepDefault: torrent.keepFilesByDefault(), purged });
  } catch (e) {
    fail(res, e, "torrent_keep");
  }
});

/** Позиция просмотра: при следующем открытии продолжим с этой секунды. */
router.post("/torrent/position", (req, res) => {
  const infoHash = String(req.body?.infoHash || "");
  if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: "bad infoHash", code: "bad_source" });
  }
  torrent.setDownloadPosition(infoHash, req.body?.position);
  res.json({ ok: true });
});

/**
 * Убрать завершённые раздачи, которые пользователь решил не хранить
 * (галочка «хранить после просмотра» выключена) — освобождаем место.
 */
router.post("/torrent/cleanup", (req, res) => {
  const purged = torrent.purgeUnkept();
  if (purged) logger.action("movies.torrent_cleanup", { purged });
  res.json({ purged });
});

/**
 * Состояние ffmpeg для плеера: путь, версия и признак «найден».
 * force=1 — пересобрать кэш определения (кнопка «Проверить снова»: пользователь
 * мог распаковать ffmpeg в storage уже после запуска приложения).
 */
router.get(
  "/ffmpeg",
  wrap(async (req, res) => {
    const force = String(req.query.force || "") === "1";
    const probe = await mediaProbe.probeStatus({ force });
    const ff = await mediaProbe.ffmpegInfo({ force });
    res.json({ ...probe, version: ff.version, searched: ff.searched });
  }),
);

/**
 * Добавить торрент: { magnet } ИЛИ { torrent: "<base64 .torrent>" }.
 * Приложение не ищет торренты — источник передаёт сам пользователь.
 */
router.post(
  "/torrent/add",
  wrap(async (req, res) => {
    const magnet = String(req.body?.magnet || "").trim();
    const b64 = String(req.body?.torrent || "").trim();
    let source;
    if (magnet) {
      if (!/^magnet:\?/i.test(magnet))
        return res.status(400).json({ error: "not a magnet link", code: "bad_source" });
      source = magnet;
    } else if (b64) {
      source = Buffer.from(b64, "base64");
      if (!source.length)
        return res.status(400).json({ error: "empty .torrent payload", code: "bad_source" });
    } else {
      return res.status(400).json({ error: "magnet or torrent required", code: "bad_source" });
    }
    // Название фильма и magnet уходят в реестр «Скачанные»: по названию окно
    // плеера восстанавливается, по magnet загрузка возобновляется после паузы.
    res.json(
      await torrent.add(source, {
        title: String(req.body?.title || ""),
        magnet: magnet || undefined,
      }),
    );
  }),
);

router.get("/torrent/status/:infoHash", (req, res) => {
  const st = torrent.status(req.params.infoHash);
  if (!st) return res.status(404).json({ error: "torrent not found", code: "no_torrent" });
  res.json(st);
});

router.get("/torrent/file/:infoHash/:index", (req, res) => {
  try {
    res.json(torrent.streamInfo(req.params.infoHash, Number(req.params.index)));
  } catch (e) {
    fail(res, e, "torrent_file");
  }
});

/**
 * Стрим файла торрента для HTML5 <video>: поддержка HTTP Range (206).
 * Видео запрашивает байтовые диапазоны по мере воспроизведения — WebTorrent
 * качает именно нужные куски, поэтому старт почти мгновенный.
 */
router.get("/torrent/stream/:infoHash/:index", (req, res) => {
  // Строгая валидация: путь ресурсный (без токена), поэтому infoHash обязан быть
  // 40 hex, а index — целым в пределах разумного.
  const t = torrentTarget(req);
  if (t.error) return res.status(400).json({ error: t.error, code: t.error });
  const { infoHash, idx } = t;
  let info;
  try {
    info = torrent.streamInfo(infoHash, idx);
  } catch (e) {
    return fail(res, e, "torrent_stream");
  }

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
  req.on("close", () => {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.on("error", (e) => {
    logger.error("movies.torrent_stream_error", { infoHash, error: e?.message });
    if (!res.headersSent) res.status(500);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  });
  stream.pipe(res);
});

/**
 * Удалить раздачу: останавливаем загрузку и (по умолчанию) стираем скачанные
 * файлы. ?files=0 — «убрать из списка, файлы на диске оставить».
 * removed=false для неизвестного infoHash — как и раньше, роут не «врёт».
 */
router.delete("/torrent/:infoHash", (req, res) => {
  const hash = String(req.params.infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    return res.status(400).json({ error: "bad infoHash", code: "bad_source" });
  }
  const files = String(req.query.files ?? "1") !== "0";
  const known = torrent.listDownloads().some((d) => d.infoHash === hash);
  if (known) torrent.purgeDownload(hash, { files });
  else torrent.remove(hash);
  res.json({ removed: known, files: known ? files : false });
});

/* ==================== 5. Форум-трекер: поиск раздач ==================== */

/**
 * Статус трекера + готовность ffmpeg — одним запросом: вкладка «Поиск раздач»
 * показывает их вместе (есть ли ключи, жива ли сессия, доступны ли дорожки).
 * Пароль и куки наружу не отдаются — только факты «есть/нет».
 */
router.get(
  "/tracker/status",
  wrap(async (req, res) => {
    const probe = await mediaProbe.probeStatus();
    res.json({ ...tracker.trackerStatus(), ffmpeg: probe.ffmpeg, ffprobe: probe.ffprobe });
  }),
);

/**
 * Переключить трекер: body: { id: "rutracker" | "rutor" }.
 *
 * Настройки площадки применяются пресетом целиком (адреса, кодировка, способ
 * поиска, движок разбора) — иначе после смены трекера остались бы пути прежнего.
 * Логин/пароль остаются в секретах: их не трогаем.
 */
router.post("/tracker/preset", (req, res) => {
  try {
    const out = tracker.applyTrackerPreset(req.body?.id);
    logger.action("movies.tracker_preset_applied", { id: out.id });
    res.json({ ...out, status: tracker.trackerStatus() });
  } catch (e) {
    fail(res, e, "tracker_preset");
  }
});

/**
 * Настройки форума и (опционально) логин/пароль.
 * body: { enabled, baseUrl, loginPath, searchPath, searchParam, encoding, …,
 *         login, password }
 * Логин и пароль сохраняются ТОЛЬКО в зашифрованные секреты (storage/secrets.json),
 * поэтому в settings.json и в ответах API их нет.
 */
router.post("/tracker/config", (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const key of [
      "enabled",
      "engine",
      "baseUrl",
      "label",
      "loginPath",
      "searchPath",
      "searchMethod",
      "searchParam",
      "topicPath",
      "torrentPath",
      "encoding",
      "userAgent",
      "minIntervalMs",
      "timeoutMs",
      "maxResults",
      "requireDownloadable",
    ]) {
      if (b[key] !== undefined) patch[key] = b[key];
    }
    if (patch.baseUrl !== undefined) {
      const url = String(patch.baseUrl || "").trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res
          .status(400)
          .json({ error: "baseUrl must start with http(s)://", code: "bad_query" });
      }
      patch.baseUrl = url.replace(/\/+$/, "");
    }
    if (Object.keys(patch).length) settings.set({ trackers: patch });

    if (b.login || b.password) {
      const current = tracker.trackerCredentials() || { login: "", password: "" };
      const login = String(b.login || current.login).trim();
      const password = String(b.password || current.password);
      if (!login || !password) {
        return res
          .status(400)
          .json({ error: "login and password required", code: "no_credentials" });
      }
      tracker.saveTrackerCredentials(login, password);
      tracker.trackerLogout(); // сменили учётку — старая сессия больше не нужна
    }

    tracker.clearTrackerCache();
    logger.action("movies.tracker_config_saved", { fields: Object.keys(patch) });
    res.json({ ok: true, status: tracker.trackerStatus() });
  } catch (e) {
    fail(res, e, "tracker_config");
  }
});

/** Принудительный вход: сбрасываем сессию и логинимся заново. */
router.post(
  "/tracker/login",
  wrap(async (req, res) => {
    tracker.trackerLogout();
    const session = await tracker.trackerLogin();
    res.json({ ok: true, sid: session.sid, cookies: Object.keys(session.cookies).length });
  }),
);

/**
 * Подхват куки прямо из браузера — основной путь для Cloudflare.
 *
 * Пользователь один раз входит на форум в своём браузере и жмёт кнопку: приложение
 * читает базу куки браузера (Chrome/Edge/Brave/Opera/Yandex/Vivaldi/Firefox) и
 * переносит их в свою сессию (IP+UA подбираются, чтобы cf_clearance подошёл).
 * Ничего копировать руками не нужно.
 */
router.post(
  "/tracker/cookies/from-browser",
  wrap(async (_req, res) => {
    const out = await tracker.importCookiesFromBrowsers();
    tracker.clearTrackerCache();
    res.json({ ...out, status: tracker.trackerStatus() });
  }),
);

/**
 * Проверка текущей сессии: GET страницы поиска с нашими куки. Возвращает
 * диагностику (форум пустил / Cloudflare / форма входа) — кнопка «Проверить».
 */
router.get(
  "/tracker/session",
  wrap(async (_req, res) => {
    res.json({ probe: await tracker.probeTrackerSessionAsync() });
  }),
);

/**
 * Импорт куки строкой вручную: body { cookies: "cf_clearance=…; bb_data=…" }.
 * Оставлено как запасной путь (браузер не найден / нужен чужой профиль).
 */
router.post(
  "/tracker/cookies",
  wrap(async (req, res) => {
    const out = tracker.importTrackerCookies(req.body?.cookies, req.body?.userAgent);
    tracker.clearTrackerCache();
    res.json({ ...out, status: tracker.trackerStatus() });
  }),
);

router.post("/tracker/logout", (req, res) => {
  const out = tracker.trackerLogout();
  // Кэш поиска тоже сбрасываем: иначе следующий поиск отдал бы результат прошлой
  // (уже закрытой) сессии из кэша, и «сброс входа» выглядел бы несработавшим.
  tracker.clearTrackerCache();
  res.json(out);
});

/** Сброс кэша результатов поиска (кнопка «Обновить»). */
router.post("/tracker/refresh", (req, res) => {
  tracker.clearTrackerCache();
  logger.action("movies.tracker_cache_refresh");
  res.json({ ok: true });
});

/**
 * Поиск раздач: body { query, limit?, refresh? }.
 * Ответ: { query, items[], total, cached, via } — отсортирован по сидам.
 */
router.post(
  "/tracker/search",
  wrap(async (req, res) => {
    const limit = Number(req.body?.limit) || undefined;
    res.json(
      await tracker.searchTrackerReleases(req.body?.query, {
        limit,
        forceRefresh: !!req.body?.refresh,
      }),
    );
  }),
);

/**
 * Открыть раздачу: сервер сам скачивает .torrent своими сессионными куками
 * (в браузер они не попадают) и возвращает список медиафайлов раздачи.
 */
router.post(
  "/tracker/add",
  wrap(async (req, res) => {
    // Название фильма связывает раздачу с тайтлом: при повторном открытии фильма
    // окно плеера восстановит эту загрузку (см. server/ts/torrent.ts → downloadForTitle).
    res.json(await tracker.addTrackerRelease(req.body?.id, { title: req.body?.title }));
  }),
);

/* ====== 6. Торрент-плеер: файлы раздачи, переключение файла, дорожки ====== */

/**
 * Валидация параметров ресурсных путей (stream/remux/subtitles): они не защищены
 * токеном (браузер грузит их тегами <video>/<track> и заголовок передать не может),
 * поэтому проверяем строго здесь: infoHash — 40 hex, index — целое в разумных
 * пределах. Иначе сюда попадёт произвольный ввод, который уйдёт в ffmpeg.
 */
function torrentTarget(req) {
  const infoHash = String(req.params.infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return { error: "bad_source" };
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0 || idx > 100000) return { error: "bad_file" };
  return { infoHash, idx };
}

/** URL собственного Range-стрима — именно его читают ffprobe и ffmpeg. */
function selfStreamUrl(req, infoHash, idx) {
  const port = (req.socket && req.socket.localPort) || config.PORT;
  return `http://127.0.0.1:${port}/api/movies/torrent/stream/${infoHash}/${idx}`;
}

/** Прочитать файл раздачи целиком (с ограничением) — для внешних .srt/.vtt. */
function readTorrentFile(infoHash, index, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const stream = torrent.createReadStream(infoHash, index, {});
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error("subtitle file is too large"), { code: "bad_file" }));
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (e) => reject(Object.assign(e, { code: (e && e.code) || "torrent_error" })));
  });
}

/**
 * Сценарий А: список медиафайлов раздачи (метаданные до полной загрузки).
 * body: { magnet?, torrent? (base64), infoHash?, mediaOnly? }
 */
router.post(
  "/torrent/files",
  wrap(async (req, res) => {
    const b = req.body || {};
    let input = b.magnet || b.infoHash || "";
    if (b.torrent) input = Buffer.from(String(b.torrent), "base64");
    if (!input) {
      return res
        .status(400)
        .json({ error: "magnet, torrent or infoHash required", code: "bad_source" });
    }
    res.json(
      await torrent.getTorrentFileList(input, {
        mediaOnly: b.mediaOnly !== false,
        title: String(b.title || ""),
      }),
    );
  }),
);

/** Переключение воспроизводимого файла раздачи (например, серии). */
router.post("/torrent/select", (req, res) => {
  try {
    const infoHash = String(req.body?.infoHash || "");
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
      return res.status(400).json({ error: "bad infoHash", code: "bad_source" });
    }
    res.json(torrent.selectTorrentFile(infoHash, req.body?.index));
  } catch (e) {
    fail(res, e, "torrent_select");
  }
});

/**
 * Сценарий Б: дорожки файла — аудио и субтитры через ffprobe плюс внешние
 * .srt/.vtt из самой раздачи. Если ffprobe нет (код ffmpeg_missing), плеер
 * продолжает играть обычным стримом — просто без выбора дорожек.
 */
router.get(
  "/torrent/tracks/:infoHash/:index",
  wrap(async (req, res) => {
    const t = torrentTarget(req);
    if (t.error) return res.status(400).json({ error: t.error, code: t.error });
    const file = torrent.streamInfo(t.infoHash, t.idx); // бросит no_torrent/no_metadata/bad_file

    const probe = await mediaProbe.probeMedia({
      kind: "url",
      url: selfStreamUrl(req, t.infoHash, t.idx),
    });

    let external;
    try {
      const st = torrent.status(t.infoHash);
      external = mediaProbe.findSiblingSubs(st ? st.files : [], file.name).map((s) => ({
        ...s,
        index: -1,
        streamIndex: -1,
        isDefault: false,
        forced: false,
        external: true,
      }));
    } catch {
      external = [];
    }

    res.json({
      infoHash: t.infoHash,
      index: t.idx,
      file,
      durationSec: probe.durationSec,
      video: probe.video,
      audio: probe.audio,
      subtitles: [...probe.subtitles, ...(external || [])],
      ffmpeg: probe.ffmpeg,
      defaultAudio: mediaProbe.defaultAudioIndex(probe.audio),
      // Как это играть: MKV/AC3 Chromium сам не читает, поэтому плеер должен
      // знать заранее — прямой стрим или remux/перекодирование (см. playbackPlan).
      plan: mediaProbe.playbackPlan({
        name: file.name,
        videoCodec: probe.video ? probe.video.codec : null,
        audioCodecs: probe.audio.map((a) => a.codec),
        ffmpeg: probe.ffmpeg,
      }),
    });
  }),
);

/**
 * Куда реально встанет перемотка (секунда старта потока).
 *
 * Плеер перематывает точным seek (`copy=0`): видео перекодируется, и `-ss` режет
 * поток ровно по запрошенной секунде — тогда и картинка, и звук начинаются в ней.
 * Здесь же он берёт эту секунду, чтобы шкала, субтитры и сохранённая позиция
 * совпадали с тем, что на экране.
 *
 * Раньше этот роут искал ключевой кадр (для режима копирования): при `-c:v copy`
 * ffmpeg начинает видео с ключевого кадра СТРОГО до `-ss`, а звук — ровно по нему,
 * и они расходятся на длину GOP (замер: 2.294 с). Режим `copy=1` оставлен для
 * совместимости: он по-прежнему возвращает выровненную секунду.
 *
 * query: at (секунды), copy=0 — точный seek (перекодирование). Ответ:
 *        { requested, startSec, keyframe, exact }.
 */
router.get(
  "/torrent/seek/:infoHash/:index",
  wrap(async (req, res) => {
    const t = torrentTarget(req);
    if (t.error) return res.status(400).json({ error: t.error, code: t.error });
    // Проверяем, что торрент добавлен и индекс в диапазоне (иначе no_torrent/bad_file).
    torrent.streamInfo(t.infoHash, t.idx);

    const at = Number(req.query.at);
    const requested = Number.isFinite(at) && at >= 0 && at < 86400 ? at : 0;
    // Начало фильма и точный seek (copy=0) — ключевой кадр ни при чём: секунда
    // точная. `exact` сообщает это плееру, чтобы он не менял режим и не показывал
    // предупреждение о сдвиге старта.
    if (requested <= 0 || req.query.copy === "0") {
      return res.json({ requested, startSec: requested, keyframe: false, exact: true });
    }

    const kf = await mediaProbe.keyframeBefore(
      { kind: "url", url: selfStreamUrl(req, t.infoHash, t.idx) },
      requested,
    );
    // Допуск KEYFRAME_EPS: кадр, который на пару миллисекунд позже запрошенной
    // секунды, — это тот же старт (при -ss ffmpeg всё равно встанет на него).
    // Строгое сравнение сваливало выравнивание на ПРЕДЫДУЩИЙ кадр — в логах это
    // видно как «запрос 1174 с → поток начался с 1172.546», и картинка уезжала
    // от звука почти на секунду.
    const aligned = kf != null && kf <= requested + mediaProbe.KEYFRAME_EPS;
    res.json({
      requested,
      startSec: aligned ? kf : requested,
      keyframe: aligned,
      // Точной секунда бывает только при перекодировании (copy=0): тогда поток
      // стартует ровно с неё. Копирование же начинает видео с КЛЮЧЕВОГО кадра ДО
      // запрошенной секунды, поэтому «точность» заявлять нельзя — exact=false.
      exact: !aligned,
    });
  }),
);

/**
 * Поток с выбранной аудиодорожкой: ffmpeg переупаковывает видео «на лету»
 * (видео копируется, аудио → AAC) и отдаёт fragmented MP4, который <video>
 * проигрывает сразу, без полной загрузки раздачи.
 *
 * Поток не seekable по природе: перемотка — это новый запрос с &start=<сек>,
 * поэтому Accept-Ranges: none (иначе плеер попробует Range и получит кашу).
 * query: audio (индекс дорожки), start (секунды), quality (kbps AAC),
 *        video ("copy" | "h264" — перекодировать видео, если Chromium не читает кодек),
 *        aligned=1 — секунда уже получена клиентом через /torrent/seek (сервер её не
 *        пересчитывает). Перемотка (start>0) ВСЕГДА перекодирует видео: копирование
 *        стартует с ключевого кадра ДО секунды реза и даёт рассинхрон на длину GOP.
 */
router.get(
  "/torrent/remux/:infoHash/:index",
  wrap(async (req, res) => {
    const t = torrentTarget(req);
    if (t.error) return res.status(400).json({ error: t.error, code: t.error });
    let info;
    try {
      info = torrent.streamInfo(t.infoHash, t.idx);
    } catch (e) {
      return fail(res, e, "torrent_remux");
    }

    // Строгая валидация: эти значения уходят в аргументы ffmpeg.
    const audio = Number(req.query.audio);
    const start = Number(req.query.start);
    const quality = Number(req.query.quality);
    const audioIdx = Number.isInteger(audio) && audio >= 0 && audio < 64 ? audio : 0;
    const startSec = Number.isFinite(start) && start >= 0 && start < 86400 ? start : 0;
    const kbps = Number.isFinite(quality) && quality >= 64 && quality <= 512 ? quality : 192;
    // Перемотка: копирование невозможно. ffmpeg начнёт видео с ключевого кадра ДО
    // секунды реза, а звук обрежет ровно по ней — рассинхрон на длину GOP (замер на
    // живой раздаче: 2.294 с). Поэтому с середины фильма видео перекодируется, и
    // секунда старта честная. См. exactSeekVideoMode в mediaProbe.
    const video = mediaProbe.exactSeekVideoMode(
      startSec,
      req.query.video === "h264" ? "h264" : "copy",
    );
    const srcUrl = selfStreamUrl(req, t.infoHash, t.idx);

    /**
     * Секунда старта честная: при перекодировании accurate seek режет ровно по `-ss`,
     * а при копировании (осталось только для старта с нуля) реза нет вовсе. Именно
     * поэтому ffprobe здесь больше не вызывается: раньше сервер «выравнивал» секунду
     * сам и сдвигал старт (клиент 1173.673 → сервер 1172.546), а картинка уезжала от
     * звука на длину GOP. Теперь и шкала, и звук начинаются ровно там, где просил плеер.
     */
    const fromSec = startSec;

    const child = await mediaProbe.spawnRemux({
      src: { kind: "url", url: srcUrl },
      audio: audioIdx,
      startSec: fromSec,
      quality: kbps,
      video,
    });
    if (!child.stdout) return res.status(500).json({ error: "ffmpeg stdout is not piped" });

    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "none");
    // Диагностика: с какой секунды реально начали (плеер узнаёт её заранее).
    res.setHeader("X-MoonApp-Start-Sec", String(fromSec));
    child.stdout.pipe(res);

    // Клиент закрыл плеер/перемотал — гасим ffmpeg, чтобы не жёг CPU впустую.
    req.on("close", () => {
      try {
        child.kill();
      } catch {
        /* процесс уже завершился */
      }
    });
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        const msg = String(d).trim();
        if (msg) logger.debug("movies.remux_stderr", { msg: msg.slice(-300) });
      });
    }
    child.on("error", (e) => {
      logger.error("movies.remux_error", { error: e && e.message, name: info.name });
      try {
        res.end();
      } catch {
        /* ответ уже закрыт */
      }
    });
    child.on("close", (code) => {
      if (code) logger.warn("movies.remux_exit", { code, name: info.name });
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
    logger.action("movies.remux_start", {
      infoHash: t.infoHash,
      index: t.idx,
      audio: audioIdx,
      // requested и from совпадают всегда (точный seek) — поле оставлено намеренно:
      // по нему в логах видно, с какой секунды реально стартовал поток.
      requested: startSec,
      from: fromSec,
      aligned: req.query.aligned === "1",
      // exact: перемотка перекодируется ради точного старта (см. exactSeekVideoMode).
      exact: startSec > 0 && video === "h264",
      video,
    });
  }),
);

/**
 * Субтитры как WebVTT (Chromium понимает только этот формат):
 *  - ?track=<N> — дорожка из контейнера (ffmpeg -map 0:s:N, включая ASS/SSA);
 *  - ?file=<index> — файл .srt/.vtt из самой раздачи (читаем и конвертируем).
 */
router.get(
  "/torrent/subtitles/:infoHash/:index",
  wrap(async (req, res) => {
    const t = torrentTarget(req);
    if (t.error) return res.status(400).json({ error: t.error, code: t.error });
    // Проверяем, что торрент добавлен и индекс в диапазоне: иначе непонятная
    // ошибка ffmpeg вместо честного no_torrent/bad_file.
    torrent.streamInfo(t.infoHash, t.idx);

    const fileIdx = Number(req.query.file);
    let text;
    if (Number.isInteger(fileIdx) && fileIdx >= 0) {
      const info = torrent.streamInfo(t.infoHash, fileIdx);
      const buf = await readTorrentFile(t.infoHash, fileIdx);
      text = mediaProbe.subtitleFileToVtt(buf, info.name);
    } else {
      const track = Number(req.query.track);
      const trackIdx = Number.isInteger(track) && track >= 0 && track < 64 ? track : 0;
      const out = await mediaProbe.extractSubtitleWebVtt({
        src: { kind: "url", url: selfStreamUrl(req, t.infoHash, t.idx) },
        index: trackIdx,
        cacheKey: `${t.infoHash}-${t.idx}-t${trackIdx}`,
      });
      text = out.text;
    }

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(text);
  }),
);

module.exports = router;
