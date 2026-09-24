/**
 * Клиент TMDB (The Movie Database) для страницы «Фильмы и Сериалы».
 *
 * Зачем отдельный модуль: страница каталога (Seerr-style) требует много
 * однотипных запросов (trending/popular/top/upcoming/discover/search/details),
 * плюс нормализацию «сырых» ответов TMDB в удобные для фронта структуры.
 *
 * Ключевые особенности:
 *  - КЛЮЧ — сначала из зашифрованных секретов (storage/secrets.json), не из
 *    настроек: см. security.getSecret("tmdb"). Если своего ключа нет — берётся
 *    вшитый в сборку (server/bundled-keys.js от scripts/gen-bundled-keys.mjs),
 *    чтобы страница работала «из коробки». Поддерживаются оба формата TMDB:
 *    API Key (v3, ?api_key=) и Read Access Token (v4, Authorization: Bearer).
 *  - ВСЕ внешние запросы идут через per-page прокси (runWithPage + pageFetch) —
 *    то есть уважают правило страницы «movies» (ProxyPanel → «страница → прокси»).
 *    Если проксирование включено, но прокси недоступен, делаем один откат на
 *    прямой запрос (graceful), чтобы страница не «умирала» целиком.
 *  - Кэш ответов в локальной БД (media_meta_cache), TTL — settings.movies.cacheMinutes.
 *
 * TS-исходник, как server/ts/myspace-vault.ts: компилируется в server/tmdb.js
 * командой `npm run compile:server`, поэтому `require("../tmdb")` из
 * server/routes/movies.js работает без изменений.
 */
import crypto from "crypto";
// security.ts отдаёт именованные экспорты (как require("./security") в .js-версии),
// поэтому namespace-импорт: security.getSecret("tmdb").
import * as security from "./security";
import settings from "./settings";
import logger from "./logger";
import { stmts } from "./db";

/**
 * middleware/perPageProxy.js ещё не переведён на TS, поэтому require с
 * минимальным контрактом (как proxyCore в server/ts/proxyPing.ts). Путь указан
 * от server/ — ровно таким он и останется в собранном .js.
 */
interface PerPageProxy {
  runWithPage<T>(page: string, fn: () => Promise<T>): Promise<T>;
  pageFetch(url: string, init: RequestInit): Promise<Response>;
  getUndiciDispatcherForPage(page: string): unknown;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perPageProxy = require("./middleware/perPageProxy") as PerPageProxy;
const { runWithPage, pageFetch, getUndiciDispatcherForPage } = perPageProxy;

/**
 * Ответы TMDB — произвольные JSON-объекты: у detail-ответа десятки
 * необязательных полей, из которых читается 10–20, поэтому Raw.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
export const PAGE_ID = "movies";

/** Ошибка с машиночитаемым кодом — фронт показывает понятный текст. */
interface TmdbError extends Error {
  code: string;
}
function tmdbError(code: string, message?: string): TmdbError {
  const e = new Error(message || code) as TmdbError;
  e.code = code;
  return e;
}

/**
 * Ключи, вшитые в сборку (server/bundled-keys.js).
 *
 * Файл генерируется scripts/gen-bundled-keys.mjs из секретов CI перед упаковкой
 * инсталлятора, поэтому у пользователя страница «Фильмы» работает «из коробки».
 * В репозитории файла нет: require в try/catch — в dev-сборке ключ берётся
 * только из секретов (storage/secrets.json), и это нормальный режим.
 */
interface BundledKeys {
  tmdb?: string;
}

/**
 * Жёсткий запасной ключ TMDB — на случай, если server/bundled-keys.js не попал
 * в сборку (например, релиз собирался без секрета TMDB_API_KEY в CI). Раньше
 * страница «Фильмы» в упакованном инсталляторе оставалась без ключа «из
 * коробки» именно поэтому: локально (npm run dev/VSCode) рядом лежал файл
 * server/bundled-keys.js от прошлого локального запуска gen:keys, а в
 * официальной сборке — нет, и getSecret/bundledKey возвращали пусто.
 * Это ключ уровня "общий доступ для всех пользователей приложения" — не
 * персональный секрет; пользовательский ключ (storage/secrets.json) всё равно
 * имеет приоритет, см. resolveKey().
 */
const HARDCODED_TMDB_KEY = "b7f977ab2c5375d2fe543585bb360c6c";

function bundledKey(name: keyof BundledKeys): string {
  // Путь переопределяем через MOONAPP_BUNDLED_KEYS: тесты (и сборки с другим
  // набором ключей) не должны зависеть от файла, сгенерированного рядом с server.
  // Явный override (переменная задана) отключает жёсткий запасной ключ ниже —
  // так тесты могут детерминированно проверить сценарий "ключа вообще нет".
  const overridden = !!process.env.MOONAPP_BUNDLED_KEYS;
  const target = process.env.MOONAPP_BUNDLED_KEYS || "./bundled-keys";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keys = require(target) as BundledKeys;
    const fromFile = String(keys?.[name] || "").trim();
    if (fromFile) return fromFile;
  } catch {
    /* файла нет — падаем на жёсткий запасной ключ ниже (если не overridden) */
  }
  if (!overridden && name === "tmdb") return HARDCODED_TMDB_KEY;
  return "";
}

/** Источник ключа: свой секрет важнее вшитого — его всегда можно переопределить. */
export type TmdbKeySource = "secret" | "bundled" | "none";

function resolveKey(): { token: string; source: TmdbKeySource } {
  let secret = "";
  try {
    secret = String(security.getSecret("tmdb") || "").trim();
  } catch {
    /* секреты могут быть недоступны в тестах */
  }
  if (secret) return { token: secret, source: "secret" };
  const bundled = bundledKey("tmdb");
  return bundled ? { token: bundled, source: "bundled" } : { token: "", source: "none" };
}

/** Действующий ключ TMDB: свой секрет → вшитый в сборку → пусто. */
export function tmdbKey(): string {
  return resolveKey().token;
}

/** Откуда взят ключ — для /status и диагностики в UI («ключ вшит в сборку»). */
export function keySource(): TmdbKeySource {
  return resolveKey().source;
}

/** Есть ли ключ TMDB (без обращения к сети). */
export function hasKey(): boolean {
  return !!tmdbKey();
}

/** v4 Read Access Token — длинный JWT (начинается с eyJ). Иначе — v3 API key. */
function isBearer(token: unknown): boolean {
  return typeof token === "string" && token.trim().startsWith("eyJ");
}

/** Настройки страницы «Фильмы», приведённые к безопасным значениям. */
interface MovieCfg {
  language: string;
  region: string;
  showAdult: boolean;
  cacheMinutes: number;
}

function movieCfg(): MovieCfg {
  let cfg: Raw = {};
  try {
    cfg = settings.get("movies") || {};
  } catch {
    /* настройки могут быть недоступны в тестах */
  }
  return {
    language: cfg.language || "ru-RU",
    region: String(cfg.region || "RU").toUpperCase(),
    showAdult: !!cfg.showAdult,
    cacheMinutes: Math.max(0, Number(cfg.cacheMinutes) || 0),
  };
}
/* ------------------------------- Кэш ---------------------------------- */

function cacheGet(key: string): Raw {
  const { cacheMinutes } = movieCfg();
  if (!cacheMinutes) return null;
  try {
    const hit = stmts.mmcGet.get(key);
    if (!hit) return null;
    const at = Date.parse(String(hit.cached_at || "").replace(" ", "T"));
    if (!Number.isFinite(at)) return null;
    if (Date.now() - at > cacheMinutes * 60_000) return null;
    return JSON.parse(hit.json);
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: unknown): void {
  try {
    stmts.mmcSet.run(key, JSON.stringify(value));
  } catch {
    /* кэш не критичен */
  }
}

/** Сбросить кэш метаданных TMDB (кнопка «Обновить» на странице). */
export function clearCache(): void {
  try {
    stmts.mmcClear.run();
  } catch {
    /* ignore */
  }
}

/* ------------------------------- HTTP --------------------------------- */

/** Результат запроса: via — \"proxy\" | \"direct\" (для диагностики/логов). */
interface FetchJsonResult {
  json: Raw;
  via: "proxy" | "direct";
}

/**
 * Запрос к TMDB с прокси-маршрутизацией по странице.
 * Возвращает { json, via } — via: \"proxy\" | \"direct\" (для диагностики/логов).
 */
export async function fetchJson(
  pathname: string,
  query: Raw = {},
  { page = PAGE_ID, timeout = 20000 }: { page?: string; timeout?: number } = {},
): Promise<FetchJsonResult> {
  const token = tmdbKey(); // свой секрет → вшитый в сборку ключ
  if (!token) throw tmdbError("no_api_key", "TMDB API key is not configured");

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  if (!isBearer(token)) params.set("api_key", token.trim());

  const url = `${API}${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isBearer(token)) headers.Authorization = `Bearer ${token.trim()}`;

  const attempt = async (useProxy: boolean): Promise<Response> => {
    const init: RequestInit = { headers, signal: AbortSignal.timeout(timeout) };
    if (!useProxy) return fetch(url, init); // явный direct-откат без dispatcher
    return pageFetch(url, init);
  };

  let useProxy = false;
  try {
    useProxy = !!getUndiciDispatcherForPage(page);
  } catch {
    useProxy = false;
  }

  let res: Response;
  try {
    res = await runWithPage(page, () => attempt(useProxy));
  } catch (e) {
    // Прокси включён, но достучаться не удалось — один откат напрямую.
    if (useProxy) {
      logger.warn("tmdb.proxy_failed_fallback", {
        path: pathname,
        error: (e as Error).message,
      });
      res = await attempt(false);
    } else {
      throw tmdbError("network_error", (e as Error).message);
    }
  }

  if (!res.ok) {
    if (res.status === 401) throw tmdbError("bad_api_key", "TMDB rejected the API key (401)");
    if (res.status === 404) throw tmdbError("not_found", "Not found in TMDB (404)");
    if (res.status === 429) throw tmdbError("rate_limited", "TMDB rate limit reached (429)");
    throw tmdbError("tmdb_http_" + res.status, `TMDB HTTP ${res.status}`);
  }

  const json = await res.json();
  return { json, via: useProxy ? "proxy" : "direct" };
}

/** Запрос с кэшем: ключ = путь + параметры (+язык). */
async function cached(
  pathname: string,
  query: Raw = {},
  opts: { page?: string; timeout?: number } = {},
): Promise<Raw> {
  const { language } = movieCfg();
  const key = `tmdb:${pathname}:${JSON.stringify({ ...query, language })}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { json } = await fetchJson(pathname, query, opts);
  cacheSet(key, json);
  return json;
}
/* ------------------------------ Картинки ------------------------------ */

const POSTER_SIZE = "w500";
const BACKDROP_SIZE = "w1280";
const PROFILE_SIZE = "w185";

export function imageUrl(path: unknown, size: string = POSTER_SIZE): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}

/* ------------------- Прокси картинок для фронта (API) ------------------ */
/* Chromium грузит <img src="image.tmdb.org/..."> НАПРЯМУЮ, минуя прокси
   приложения, поэтому у сетей с блокировкой TMDB постеры не открывались.
   Фронт переписывает такие ссылки на /api/movies/image?s=<size>&p=<path>
   (см. src/components/media/mediaImg.ts), а сюда картинка идёт через тот же
   per-page прокси, что и API-запросы страницы «movies». */

/** Размеры TMDB, разрешённые к проксированию (полный allowlist TMDB). */
export const IMG_SIZES = new Set([
  "w45",
  "w92",
  "w154",
  "w185",
  "w200",
  "w300",
  "w342",
  "w500",
  "w780",
  "w1280",
  "h632",
  "original",
]);

const IMG_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Путь файла TMDB: строго "/abc.jpg" — без выхода из каталога и без query. */
export function validImgPath(p: unknown): boolean {
  return typeof p === "string" && /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(p);
}

/** Нормализованная пара size/path: ключ кэша, ETag и сами значения. */
export interface ImageKey {
  size: string;
  path: string;
  key: string;
  etag: string;
}

/**
 * Нормализовать пару size/path и отдать ключ+ETag.
 * Бросает bad_size/bad_path — роут отвечает 400 (без похода в сеть).
 */
export function imageKey(rawSize: unknown, rawPath: unknown): ImageKey {
  const size = String(rawSize || POSTER_SIZE).toLowerCase();
  if (!IMG_SIZES.has(size)) throw tmdbError("bad_size", `unsupported image size: ${rawSize}`);
  const path = String(rawPath || "");
  if (!validImgPath(path)) throw tmdbError("bad_path", `invalid image path: ${rawPath}`);
  const key = `${size}${path}`;
  return {
    size,
    path,
    key,
    etag: `"${crypto.createHash("sha1").update(key).digest("hex").slice(0, 20)}"`,
  };
}

/** Запись кэша байтов картинки. */
interface CachedImage {
  buffer: Buffer;
  contentType: string;
}

/** LRU-кэш байтов картинок: постеры повторяются, а сеть до CDN дорогая. */
const IMG_CACHE_MAX = 160;
const IMG_CACHE_BYTES = 64 * 1024 * 1024;
const imgCache = new Map<string, CachedImage>();
let imgCacheBytes = 0;
/** Backoff на неудачные загрузки: не долбим недоступный хост на каждый <img>. */
const imgFailed = new Map<string, number>();
const IMG_FAIL_TTL = 30_000;

function imgCacheGet(key: string): CachedImage | null {
  const hit = imgCache.get(key);
  if (!hit) return null;
  imgCache.delete(key); // refresh LRU-порядок
  imgCache.set(key, hit);
  return hit;
}

function imgCacheSet(key: string, buffer: Buffer, contentType: string): void {
  const prev = imgCache.get(key);
  if (prev) imgCacheBytes -= prev.buffer.length;
  imgCache.set(key, { buffer, contentType });
  imgCacheBytes += buffer.length;
  while (imgCache.size > IMG_CACHE_MAX || imgCacheBytes > IMG_CACHE_BYTES) {
    const oldest = imgCache.keys().next();
    if (oldest.done) break;
    const dropped = imgCache.get(oldest.value);
    imgCache.delete(oldest.value);
    if (dropped) imgCacheBytes -= dropped.buffer.length;
  }
}
/** Скачанная картинка: via есть только у свежей загрузки (из кэша — нет). */
export interface FetchedImage {
  buffer: Buffer;
  contentType: string;
  key: string;
  cached: boolean;
  via?: "proxy" | "direct";
}

/**
 * Скачать картинку TMDB (прокси-маршрутизация как у API-запросов).
 * Возвращает { buffer, contentType, key, cached }.
 */
export async function fetchImage(
  rawSize: unknown,
  rawPath: unknown,
  { timeout = 15000 }: { timeout?: number } = {},
): Promise<FetchedImage> {
  const { size, path, key } = imageKey(rawSize, rawPath);

  const hit = imgCacheGet(key);
  if (hit) return { buffer: hit.buffer, contentType: hit.contentType, key, cached: true };

  const failedAt = imgFailed.get(key);
  if (failedAt && Date.now() - failedAt < IMG_FAIL_TTL) {
    throw tmdbError("image_unavailable", "image fetch failed recently (backoff)");
  }

  const url = `${IMG}/${size}${path}`;
  const attempt = (useProxy: boolean): Promise<Response> => {
    const init: RequestInit = { signal: AbortSignal.timeout(timeout) };
    return useProxy ? pageFetch(url, init) : fetch(url, init); // direct-откат без dispatcher
  };

  let useProxy = false;
  try {
    useProxy = !!getUndiciDispatcherForPage(PAGE_ID);
  } catch {
    useProxy = false;
  }

  const markFailed = (message: string): TmdbError => {
    imgFailed.set(key, Date.now());
    logger.warn("tmdb.image_failed", { key, error: message });
    return tmdbError("image_unavailable", message);
  };

  let res: Response;
  try {
    res = await runWithPage(PAGE_ID, () => attempt(useProxy));
  } catch (e) {
    if (!useProxy) throw markFailed((e as Error).message);
    try {
      res = await attempt(false);
    } catch (e2) {
      throw markFailed((e2 as Error).message);
    }
  }
  if (!res.ok) throw markFailed(`image HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = (/\.[a-z0-9]+$/i.exec(path) || [""])[0].toLowerCase();
  const contentType = res.headers.get("content-type") || IMG_MIME[ext] || "image/jpeg";
  imgCacheSet(key, buffer, contentType);
  imgFailed.delete(key);

  const via = useProxy ? "proxy" : "direct";
  return { buffer, contentType, key, cached: false, via };
}
/* --------------------------- Нормализация ----------------------------- */

export const KIND_LABEL = { movie: "movie", tv: "tv" };

/** Краткая карточка тайтла — то, чем оперируют карусели и сетка каталога. */
export interface MediaSummary {
  kind: "movie" | "tv";
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  year: number | null;
  date: string | null;
  voteAverage: number;
  voteCount: number;
  popularity: number;
  genreIds: number[];
  adult: boolean;
}

/** Привести kind к "movie"|"tv" (иначе — ошибка). */
export function normKind(kind: unknown): "movie" | "tv" {
  const k = String(kind || "").toLowerCase();
  if (k === "movie" || k === "movies" || k === "film") return "movie";
  if (k === "tv" || k === "series" || k === "show") return "tv";
  throw tmdbError("bad_kind", `unknown media kind: ${kind}`);
}

function yearOf(dateStr: unknown): number | null {
  const m = /^(\d{4})/.exec(String(dateStr || ""));
  return m ? Number(m[1]) : null;
}

/** Краткая карточка для каруселей/сетки. */
export function toSummary(kind: "movie" | "tv", raw: Raw): MediaSummary | null {
  if (!raw) return null;
  const isTv = kind === "tv";
  const date = isTv ? raw.first_air_date : raw.release_date;
  return {
    kind,
    id: Number(raw.id),
    title: raw.title || raw.name || raw.original_title || raw.original_name || "",
    originalTitle: raw.original_title || raw.original_name || "",
    overview: raw.overview || "",
    poster: imageUrl(raw.poster_path, POSTER_SIZE),
    backdrop: imageUrl(raw.backdrop_path, BACKDROP_SIZE),
    year: yearOf(date),
    date: date || null,
    voteAverage: Number(raw.vote_average) || 0,
    voteCount: Number(raw.vote_count) || 0,
    popularity: Number(raw.popularity) || 0,
    genreIds: Array.isArray(raw.genre_ids) ? raw.genre_ids : [],
    adult: !!raw.adult,
  };
}

/** Возрастной рейтинг из release_dates (movie) / content_ratings (tv) по региону. */
export function ageRatingOf(kind: "movie" | "tv", raw: Raw, region: string): string | null {
  try {
    if (kind === "movie") {
      const list = raw?.release_dates?.results || [];
      const entry =
        list.find((r: Raw) => r.iso_3166_1 === region) ||
        list.find((r: Raw) => r.iso_3166_1 === "US");
      const cert = (entry?.release_dates || [])
        .map((d: Raw) => d.certification)
        .find((c: Raw) => c && String(c).trim());
      return cert ? String(cert).trim() : null;
    }
    const list = raw?.content_ratings?.results || [];
    const entry =
      list.find((r: Raw) => r.iso_3166_1 === region) ||
      list.find((r: Raw) => r.iso_3166_1 === "US");
    return entry?.rating ? String(entry.rating) : null;
  } catch {
    return null;
  }
}

/** Лучший трейлер (YouTube), иначе — любой ролик. */
export function pickTrailer(videos: Raw): Raw {
  const list = (videos?.results || []).filter((v: Raw) => v.site === "YouTube" && v.key);
  const trailer = list.find((v: Raw) => /trailer/i.test(v.type || ""));
  return trailer || list[0] || null;
}
/** Площадка «где легально смотреть» в нормализованном виде. */
interface Provider {
  id: number;
  name: string;
  logo: string | null;
  displayPriority: number;
}

export interface ProvidersInfo {
  region: string;
  link: string | null;
  flatrate: Provider[];
  rent: Provider[];
  buy: Provider[];
}

/** Локализованные провайдеры («где легально смотреть») по региону. */
export function providersOf(raw: Raw, region: string): ProvidersInfo {
  const block = raw?.["watch/providers"]?.results?.[region] || null;
  if (!block) return { region, link: null, flatrate: [], rent: [], buy: [] };
  const map = (arr: Raw): Provider[] =>
    (arr || []).map((p: Raw) => ({
      id: p.provider_id,
      name: p.provider_name,
      logo: imageUrl(p.logo_path, PROFILE_SIZE),
      displayPriority: p.display_priority,
    }));
  return {
    region,
    link: block.link || null,
    flatrate: map(block.flatrate),
    rent: map(block.rent),
    buy: map(block.buy),
  };
}

/** Полная карточка тайтла из ответа /{kind}/{id}?append_to_response=… */
export function toDetails(kind: "movie" | "tv", raw: Raw, region: string) {
  const base = toSummary(kind, raw);
  const isTv = kind === "tv";
  const crew = (raw?.credits?.crew || [])
    .filter((c: Raw) =>
      [
        "Director",
        "Writer",
        "Screenplay",
        "Creator",
        "Producer",
        "Composer",
        "Executive Producer",
      ].includes(c.job),
    )
    .slice(0, 12)
    .map((c: Raw) => ({
      id: c.id,
      name: c.name,
      job: c.job,
      department: c.department,
      profile: imageUrl(c.profile_path, PROFILE_SIZE),
    }));

  const images = raw?.images || {};
  const trailer = pickTrailer(raw?.videos);
  return {
    ...base,
    tagline: raw?.tagline || "",
    status: raw?.status || "",
    homepage: raw?.homepage || "",
    runtime: isTv ? raw?.episode_run_time?.[0] || null : raw?.runtime || null,
    seasons: isTv ? Number(raw?.number_of_seasons) || 0 : 0,
    episodes: isTv ? Number(raw?.number_of_episodes) || 0 : 0,
    budget: isTv ? 0 : Number(raw?.budget) || 0,
    revenue: isTv ? 0 : Number(raw?.revenue) || 0,
    genres: (raw?.genres || []).map((g: Raw) => ({ id: g.id, name: g.name })),
    countries: (raw?.production_countries || []).map((c: Raw) => c.name),
    languages: (raw?.spoken_languages || []).map((l: Raw) => l.english_name || l.name),
    ageRating: ageRatingOf(kind, raw, region),
    imdbId: raw?.external_ids?.imdb_id || null,
    cast: (raw?.credits?.cast || []).slice(0, 24).map((c: Raw) => ({
      id: c.id,
      name: c.name,
      character: c.character || "",
      profile: imageUrl(c.profile_path, PROFILE_SIZE),
    })),
    crew,
    videos: (raw?.videos?.results || [])
      .filter((v: Raw) => v.site === "YouTube" && v.key)
      .slice(0, 12)
      .map((v: Raw) => ({
        key: v.key,
        name: v.name,
        type: v.type,
        official: !!v.official,
      })),
    trailer: trailer ? { key: trailer.key, name: trailer.name, type: trailer.type } : null,
    gallery: {
      backdrops: (images.backdrops || [])
        .slice(0, 12)
        .map((i: Raw) => imageUrl(i.file_path, BACKDROP_SIZE)),
      posters: (images.posters || [])
        .slice(0, 12)
        .map((i: Raw) => imageUrl(i.file_path, POSTER_SIZE)),
    },
    similar: (raw?.similar?.results || []).slice(0, 12).map((r: Raw) => toSummary(kind, r)),
    recommendations: (raw?.recommendations?.results || [])
      .slice(0, 12)
      .map((r: Raw) => toSummary(kind, r)),
    providers: providersOf(raw, region),
  };
}
/**
 * Форма страницы списка TMDB: то, что нужно UI для подкачки и счётчика.
 *
 * TMDB отдаёт по 20 тайтлов на страницу (`total_pages` до 500), сам список
 * может быть в тысячи записей, поэтому «Показано N из M» берём из
 * `total_results`, а не из длины массива.
 */
export interface PageInfo {
  page: number;
  totalPages: number;
  totalResults: number;
}

/** Страница подборки/трендов: элементы + регион для площадок. */
export interface MediaListResult extends PageInfo {
  items: MediaSummary[];
  region: string;
}

/** Страница подборки с эхом выбранной категории. */
export interface MediaCategoryResult extends MediaListResult {
  category: string;
}

const DETAIL_APPEND =
  "credits,videos,images,similar,recommendations,watch/providers,release_dates,content_ratings,external_ids";

export function pageInfo(json: Raw, page: number): PageInfo {
  return {
    page: Number(json?.page) || page,
    totalPages: Number(json?.total_pages) || 1,
    totalResults: Number(json?.total_results) || (json?.results || []).length,
  };
}

/** Тренды: kind = "movie"|"tv", window = "day"|"week". */
export async function trending(kind: unknown, window = "week", page = 1): Promise<MediaListResult> {
  const k = normKind(kind);
  const { language, showAdult, region } = movieCfg();
  const json = await cached(`/trending/${k}/${window === "day" ? "day" : "week"}`, {
    language,
    page,
  });
  return {
    ...pageInfo(json, page),
    items: (json.results || [])
      .map((r: Raw) => toSummary(k, r))
      .filter((r: MediaSummary | null): r is MediaSummary => !!r && (showAdult || !r.adult)),
    region,
  };
}
/** Подборка: popular | top_rated | upcoming | now_playing (movie) / on_the_air | airing_today (tv). */
export async function list(
  kind: unknown,
  category = "popular",
  page = 1,
): Promise<MediaCategoryResult> {
  const k = normKind(kind);
  const allowed: Record<"movie" | "tv", string[]> = {
    movie: ["popular", "top_rated", "upcoming", "now_playing"],
    tv: ["popular", "top_rated", "on_the_air", "airing_today"],
  };
  const cat = allowed[k].includes(category) ? category : "popular";
  const { language, showAdult, region } = movieCfg();
  const json = await cached(`/${k}/${cat}`, { language, page });
  return {
    ...pageInfo(json, page),
    category: cat,
    items: (json.results || [])
      .map((r: Raw) => toSummary(k, r))
      .filter((r: MediaSummary | null): r is MediaSummary => !!r && (showAdult || !r.adult)),
    region,
  };
}

/** Поиск по названию (в переводе и оригинале — TMDB делает это сам). */
export async function search(
  query: unknown,
  kind: unknown = "multi",
  page = 1,
): Promise<PageInfo & { items: MediaSummary[] }> {
  const q = String(query || "").trim();
  if (!q) return { items: [], page: 1, totalPages: 1, totalResults: 0 };
  const { language, showAdult } = movieCfg();
  const path = kind === "multi" ? "/search/multi" : `/search/${normKind(kind)}`;
  const json = await cached(path, {
    query: q,
    language,
    page,
    include_adult: showAdult ? "true" : "false",
  });
  const items = (json.results || [])
    .filter((r: Raw) => r.media_type !== "person")
    .map((r: Raw) => toSummary(r.media_type === "tv" ? "tv" : "movie", r))
    .filter((r: MediaSummary | null): r is MediaSummary => !!r && (showAdult || !r.adult));
  return { ...pageInfo(json, page), items };
}

/** Полная карточка тайтла (детали + каст + трейлеры + галерея + похожие + площадки). */
export async function details(kind: unknown, id: unknown) {
  const k = normKind(kind);
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw tmdbError("bad_id", "invalid TMDB id");
  const { language, region } = movieCfg();
  const json = await cached(`/${k}/${tmdbId}`, { language, append_to_response: DETAIL_APPEND });
  return toDetails(k, json, region);
}

/** Жанры для фильтров каталога. */
export async function genres(kind: unknown): Promise<{ genres: { id: number; name: string }[] }> {
  const k = normKind(kind);
  const { language } = movieCfg();
  const json = await cached(`/genre/${k}/list`, { language });
  return { genres: (json.genres || []).map((g: Raw) => ({ id: g.id, name: g.name })) };
}
/** Фильтр по жанру/году/сортировке (страница «Каталог → жанры»). */
export async function discover(
  kind: unknown,
  {
    genre,
    year,
    sort = "popularity.desc",
    page = 1,
  }: { genre?: unknown; year?: unknown; sort?: string; page?: number } = {},
): Promise<MediaListResult> {
  const k = normKind(kind);
  const { language, showAdult, region } = movieCfg();
  // Параметры собираются постепенно (год добавляется ниже), поэтому Record.
  const query: Record<string, unknown> = {
    language,
    page,
    sort_by: sort,
    with_genres: genre || undefined,
    include_adult: showAdult ? "true" : "false",
    "vote_count.gte": sort === "vote_average.desc" ? 200 : undefined,
  };
  if (year) {
    if (k === "movie") query.primary_release_year = Number(year) || undefined;
    else query.first_air_date_year = Number(year) || undefined;
  }
  const json = await cached(`/discover/${k}`, query);
  return {
    ...pageInfo(json, page),
    items: (json.results || [])
      .map((r: Raw) => toSummary(k, r))
      .filter((r: MediaSummary | null): r is MediaSummary => !!r && (showAdult || !r.adult)),
    region,
  };
}

/** «Где легально смотреть» отдельным запросом (если нужна только эта вкладка). */
export async function watchProviders(kind: unknown, id: unknown): Promise<ProvidersInfo> {
  const k = normKind(kind);
  const tmdbId = Number(id);
  const json = await cached(`/${k}/${tmdbId}/watch/providers`, {});
  const { region } = movieCfg();
  return providersOf({ "watch/providers": json }, region);
}

// Имя с подчёркиванием — как ключ в .js-версии: внутренняя проверка типа токена
// (v4 Bearer или v3 API key), нужна тестам.
export { isBearer as _isBearer };
