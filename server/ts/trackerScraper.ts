/**
 * Поисковый агрегатор раздач (форум-трекер).
 *
 * Что делает:
 *  1) авторизуется на phpBB-форуме (по умолчанию rutracker.org) и ПЕРЕИСПОЛЬЗУЕТ
 *     сессию: куки (bb_data, sid, …) лежат в storage/trackers/session-<host>.json,
 *     логин/пароль — в зашифрованных секретах (storage/secrets.json, ключ "tracker"),
 *     поэтому пароль не попадает ни в settings.json, ни в ответы API, ни в логи;
 *  2) ищет по строке запроса в кодировке форума (windows-1251: и тело POST, и
 *     параметры GET кодируются своей таблицей — см. server/ts/charset.ts);
 *  3) парсит таблицу результатов (server/ts/trackerParse.ts — чистые функции) и
 *     дополняет каждую раздачу метаданными из названия: resolution, codec, audio,
 *     releaseGroup, source, HDR, год, сезон/серия;
 *  4) отдаёт массив, отсортированный ПО СИДАМ (как требует контракт плеера).
 *
 * Сеть: все запросы идут через per-page прокси страницы «movies»
 * (runWithPage + pageFetch) — то есть уважают правило «страница → прокси» и не
 * ломают другие страницы. Если прокси включён, но недоступен — один откат на
 * прямой запрос (как в server/tmdb.ts), затем понятный код ошибки.
 *
 * Скачивание .torrent делает ТОЛЬКО бэкенд: сессионные куки форума в браузер не
 * отдаются, фронт получает уже готовый разбор торрента (infoHash + файлы).
 *
 * TS-исходник, как server/ts/trackers.ts: компилируется в server/trackerScraper.js
 * командой `npm run compile:server`.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import * as security from "./security";
import settings from "./settings";
import { stmts } from "./db";
import { decodeBytes, formEncode, pctEncode } from "./charset";
import {
  parseReleasesByEngine,
  parseReleaseMeta,
  parseHiddenInputs,
  findSid,
  looksLikeNoResults,
  hasLoginForm,
  isCloudflareChallenge,
  looksAuthorized,
  pageSnippet,
  type RawReleaseRow,
} from "./trackerParse";
import {
  DEFAULT_PRESET,
  presetById,
  presetForEngine,
  trackerPresetList,
  type TrackerEngine,
} from "./trackerProviders";
import { getTorrentFileList, type TorrentAdded } from "./torrent";
import type { ReleaseMeta } from "./trackerParse";
import {
  collectBrowserCookies,
  probesSummary,
  uaForBrowser,
  type BrowserCookieResult,
  type BrowserProbe,
} from "./browserCookies";

const { DIRS } = config;
const PAGE_ID = "movies";

/**
 * middleware/perPageProxy.js ещё не переведён на TS, поэтому require с
 * минимальным контрактом (как в server/ts/tmdb.ts).
 */
interface PerPageProxy {
  runWithPage<T>(page: string, fn: () => Promise<T>): Promise<T>;
  pageFetch(url: string, init: RequestInit): Promise<Response>;
  getUndiciDispatcherForPage(page: string): unknown;
  /** Решение по прокси для страницы: нужно окну входа (тот же IP, что у поиска). */
  resolveProxyForPage(page: string): { proxied: boolean; proxyUrl: string | null };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perPageProxy = require("./middleware/perPageProxy") as PerPageProxy;
const { runWithPage, pageFetch, getUndiciDispatcherForPage } = perPageProxy;

/* ======================= Типы и конфигурация ======================= */

/** Ошибка с машиночитаемым кодом — роут отдаёт её фронту как { error, code }. */
export interface TrackerError extends Error {
  code: string;
  /** Диагностика (что вернул форум) — уходит в лог и в ответ API. */
  details?: TrackerErrorDetails;
}

/**
 * Диагностика ответа форума. Нужна, потому что «разметка изменилась» ничего не
 * объясняет: по статусу, размеру и «выжимке» сразу видно, был ли это Cloudflare,
 * форма входа или действительно другая вёрстка.
 */
export interface TrackerErrorDetails {
  status?: number;
  bytes?: number;
  url?: string;
  snippet?: string;
  authorized?: boolean;
  loginForm?: boolean;
  cloudflare?: boolean;
  /** Каким транспортом уходил запрос: сетевой стек Chromium приложения или fetch. */
  transport?: string;
  /** UA, которым представились форуму (для cf_clearance это критично). */
  userAgent?: string;
  /** Прокси страницы «Фильмы» (null — напрямую). */
  proxy?: string | null;
  /** Имена куки сессии, которые у нас есть. */
  cookies?: string[];
  /** Есть ли кука входа (bb_data). */
  hasLogin?: boolean;
}

function trackerError(
  code: string,
  message?: string,
  details?: TrackerErrorDetails,
): TrackerError {
  const e = new Error(message || code) as TrackerError;
  e.code = code;
  if (details) e.details = details;
  return e;
}

/** Диагностика по уже прочитанному ответу форума. */
function pageDetails(res: {
  status: number;
  buffer: Buffer;
  url: string;
  text: string;
}): TrackerErrorDetails {
  return {
    status: res.status,
    bytes: res.buffer.length,
    url: res.url,
    snippet: pageSnippet(res.text),
    authorized: looksAuthorized(res.text),
    loginForm: hasLoginForm(res.text),
    cloudflare: isCloudflareChallenge(res.text, res.status),
  };
}

/** Cloudflare-челлендж вместо страницы: у rutracker так закрыт tracker.php. */
function cfError(res: { status: number; buffer: Buffer; url: string; text: string }): TrackerError {
  const cfg = trackerCfg();
  const cookies = trackerCookieNames();
  return trackerError(
    "cf_challenge",
    "форум отдал страницу-проверку Cloudflare вместо результатов",
    {
      ...pageDetails(res),
      // Почему это важно: `cf_clearance` привязан к паре «IP + User-Agent». Если
      // запрос уходит другим транспортом (обычный fetch вместо сессии Chromium) или
      // с другим UA/прокси, проверка приходит снова, хотя кука в сессии есть.
      transport: chromiumTransportAvailable() ? "chromium" : "fetch",
      userAgent: cfg.userAgent || "",
      proxy: (() => {
        try {
          return resolveProxyUrl();
        } catch {
          return null;
        }
      })(),
      cookies,
      // Движку без входа (rutor) «нет куки входа» ни о чём не говорит: считаем,
      // что с авторизацией всё в порядке, и не пугаем пользователя зря.
      hasLogin: cfg.loginCookies.length === 0 || cfg.loginCookies.some((n) => cookies.includes(n)),
    },
  );
}

/** Настройки форума (settings.trackers). Всё, что зависит от движка, — здесь. */
export interface TrackerCfg {
  enabled: boolean;
  /** Движок разбора и способа поиска: rutracker (phpBB) | rutor. */
  engine: TrackerEngine;
  baseUrl: string;
  label: string;
  loginPath: string;
  searchPath: string;
  searchMethod: "get" | "post";
  searchParam: string;
  topicPath: string;
  torrentPath: string;
  encoding: string;
  /** UA для запросов; пусто — встроенный браузерный (важно для cf_clearance). */
  userAgent: string;
  minIntervalMs: number;
  timeoutMs: number;
  maxResults: number;
  requireDownloadable: boolean;
  /** Нужен ли вход для поиска (у rutor — нет): от него зависит требование логина. */
  requiresLogin: boolean;
  /** Куки, означающие «вход выполнен» (у движков без входа — пусто). */
  loginCookies: string[];
}

/** Значения по умолчанию — те же, что в settings.DEFAULTS.trackers. */
const CFG_DEFAULTS: TrackerCfg = {
  enabled: true,
  engine: DEFAULT_PRESET.engine,
  baseUrl: DEFAULT_PRESET.baseUrl,
  label: DEFAULT_PRESET.label,
  loginPath: DEFAULT_PRESET.loginPath,
  searchPath: DEFAULT_PRESET.searchPath,
  searchMethod: DEFAULT_PRESET.searchMethod,
  searchParam: DEFAULT_PRESET.searchParam,
  topicPath: DEFAULT_PRESET.topicPath,
  torrentPath: DEFAULT_PRESET.torrentPath,
  encoding: DEFAULT_PRESET.encoding,
  userAgent: "",
  minIntervalMs: 1200,
  timeoutMs: 20000,
  maxResults: 100,
  requireDownloadable: true,
  requiresLogin: DEFAULT_PRESET.requiresLogin,
  loginCookies: DEFAULT_PRESET.loginCookies,
};

/** Путь внутри форума → абсолютный URL (внешний URL не трогаем). */
function absUrl(base: string, p: string): string {
  const s = String(p || "").trim();
  if (!s) return base;
  if (/^https?:/i.test(s)) return s;
  return base.replace(/\/+$/, "") + (s.startsWith("/") ? s : "/" + s);
}

/** Диапазон/типы значений из settings.json приводим к безопасным. */
export function trackerCfg(): TrackerCfg {
  let raw: Partial<TrackerCfg> = {};
  try {
    raw = (settings.get("trackers") || {}) as Partial<TrackerCfg>;
  } catch {
    /* settings может быть недоступен в тестах */
  }
  // База для дефолтов — пресет движка из настроек: если трекер не задан вовсе или
  // задан частично, получаем осмысленный набор (а не пути rutracker для rutor).
  // Переключение трекера в UI применяет пресет целиком (см. applyTrackerPreset).
  const preset = presetForEngine(raw.engine);
  const num = (v: unknown, d: number, min: number, max: number): number => {
    const n = Number(v);
    // 0 — допустимое значение (например, minIntervalMs=0 «без пауз»), а NaN и
    // отрицательные — нет: тогда берём дефолт.
    if (!Number.isFinite(n) || n < 0) return d;
    return Math.min(max, Math.max(min, n));
  };
  const str = (v: unknown, d: string): string => {
    const s = String(v == null ? "" : v).trim();
    return s || d;
  };
  return {
    enabled: raw.enabled !== false,
    engine: preset.engine,
    baseUrl: str(raw.baseUrl, preset.baseUrl),
    label: str(raw.label, preset.label),
    loginPath: str(raw.loginPath, preset.loginPath),
    searchPath: str(raw.searchPath, preset.searchPath),
    searchMethod: raw.searchMethod === "get" ? "get" : raw.searchMethod === "post" ? "post" : preset.searchMethod,
    searchParam: str(raw.searchParam, preset.searchParam),
    topicPath: str(raw.topicPath, preset.topicPath),
    torrentPath: str(raw.torrentPath, preset.torrentPath),
    encoding: str(raw.encoding, preset.encoding),
    userAgent: String(raw.userAgent || "").trim(),
    minIntervalMs: num(raw.minIntervalMs, CFG_DEFAULTS.minIntervalMs, 0, 60000),
    timeoutMs: num(raw.timeoutMs, CFG_DEFAULTS.timeoutMs, 1000, 120000),
    maxResults: num(raw.maxResults, CFG_DEFAULTS.maxResults, 1, 200),
    requireDownloadable: raw.requireDownloadable !== false,
    // Вход/куки — из пресета движка, а не из settings: это свойство площадки.
    requiresLogin: preset.requiresLogin,
    loginCookies: preset.loginCookies,
  };
}

/** Раздача, готовая к показу в UI. */
export interface TrackerRelease {
  id: string;
  title: string;
  size: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  downloads: number;
  topicUrl: string | null;
  torrentUrl: string | null;
  magnet: string | null;
  meta: ReleaseMeta;
}

/** Результат поиска по форуму. */
export interface TrackerSearchResult {
  query: string;
  items: TrackerRelease[];
  total: number;
  cached: boolean;
  via: "proxy" | "direct";
}

/** Состояние форума для страницы настроек/плеера (пароль не раскрывается). */
export interface TrackerStatus {
  enabled: boolean;
  configured: boolean;
  hasCredentials: boolean;
  label: string;
  baseUrl: string;
  /** Движок трекера: rutracker (phpBB) | rutor. */
  engine: TrackerEngine;
  /** Нужен ли вход для поиска: у rutor — нет (UI прячет блок входа). */
  requiresLogin: boolean;
  /** Доступные трекеры для переключателя в UI. */
  presets: Array<{ id: string; label: string; baseUrl: string; requiresLogin: boolean }>;
  session: { ok: boolean; updatedAt: string | null };
  /** Имена куки сессии (значения не раскрываем): видно, есть ли cf_clearance. */
  cookieNames: string[];
  lastError: { code: string; message: string; at: string } | null;
  /**
   * Окно входа (Chromium приложения). available=false вне Electron: тогда остаётся
   * автоподхват куки из браузеров или ручная вставка.
   */
  chromium: { available: boolean; partition: string; loggedIn: boolean };
  /** Абсолютный URL страницы входа — открывается в окне входа. */
  loginUrl: string;
  /** SOCKS-прокси прокси, которым ходит поиск (null — напрямую): передаём окну. */
  proxyUrl: string | null;
  /**
   * UA, которым должно представляться окно входа: пусто — значит «возьми обычный
   * Chrome от версии Chromium приложения» (main.js: tracker:login-window). Возвращённый
   * окном UA сохраняется здесь же, поэтому скрапер и окно не расходятся.
   */
  userAgent: string;
}

/** Сессия форума на диске (куки + sid). */
interface TrackerSession {
  baseUrl: string;
  cookies: Record<string, string>;
  sid: string | null;
  updatedAt: string;
}

/* ======================= Секреты и сессия ======================= */

const SECRET_NAME = "tracker";
/** Браузерный UA по умолчанию (CF сверяет его с cf_clearance — можно переопределить). */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SESSION_TTL_MS = 30 * 60 * 1000; // старше — перепроверяем у форума
const TRUST_TTL_MS = 5 * 60 * 1000; // свежая сессия — без лишнего запроса
const CACHE_TTL_MS = 10 * 60 * 1000; // кэш результатов поиска
const MAX_QUERY = 200;

let lastError: TrackerStatus["lastError"] = null;

/** Есть ли живая сессия в окне входа (Chromium): тогда логин/пароль не нужны. */
let chromiumLoggedIn = false;

/** Логин/пароль форума из секретов (JSON-строка в зашифрованном секрете). */
export function trackerCredentials(): { login: string; password: string } | null {
  try {
    const raw = security.getSecret(SECRET_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { login?: string; password?: string };
    const login = String(parsed?.login || "").trim();
    const password = String(parsed?.password || "");
    if (!login || !password) return null;
    return { login, password };
  } catch {
    return null;
  }
}

/** Сохранить логин/пароль (шифрование — как у остальных секретов). */
export function saveTrackerCredentials(login: string, password: string): void {
  security.setSecret(SECRET_NAME, JSON.stringify({ login, password }));
  logger.action("movies.tracker_credentials_saved", {
    // В журнал попадает только префикс логина — пароль не логируем никогда.
    login: String(login || "").slice(0, 3) + "***",
  });
}

/** Имя файла сессии для конкретного хоста (несколько форумов не мешают друг другу). */
function sessionFile(baseUrl: string): string {
  let host = "tracker";
  try {
    host = new URL(baseUrl).host || host;
  } catch {
    /* не URL — оставляем дефолт */
  }
  const safe = host.replace(/[^a-z0-9.-]/gi, "_").slice(0, 60) || "tracker";
  return path.join(DIRS.trackers, `session-${safe}.json`);
}

function loadSession(baseUrl: string): TrackerSession | null {
  try {
    const raw = fs.readFileSync(sessionFile(baseUrl), "utf8");
    const parsed = JSON.parse(raw) as TrackerSession;
    if (!parsed || typeof parsed !== "object" || !parsed.cookies) return null;
    return {
      baseUrl: String(parsed.baseUrl || baseUrl),
      cookies: { ...parsed.cookies },
      sid: parsed.sid || null,
      updatedAt: String(parsed.updatedAt || ""),
    };
  } catch {
    return null;
  }
}

function saveSession(s: TrackerSession): void {
  try {
    fs.mkdirSync(DIRS.trackers, { recursive: true });
    fs.writeFileSync(sessionFile(s.baseUrl), JSON.stringify(s, null, 2), "utf8");
  } catch (e) {
    logger.warn("movies.tracker_session_save_failed", { error: (e as Error).message });
  }
}

/** Забыть сессию (кнопка «Выйти» / истёкшая сессия). */
export function trackerLogout(): { ok: boolean } {
  const cfg = trackerCfg();
  try {
    fs.rmSync(sessionFile(cfg.baseUrl), { force: true });
  } catch {
    /* файла нет — уже вышли */
  }
  // Сессию окна входа тоже гасим: иначе Chromium остался бы авторизованным, и
  // поиск продолжал работать «сам собой» после выхода.
  chromiumLoggedIn = false;
  void clearChromiumCookies(cfg.baseUrl).then((removed) => {
    if (removed) logger.action("movies.tracker_chromium_logout", { removed });
  });
  logger.action("movies.tracker_logout");
  return { ok: true };
}

/**
 * Разбор строки куки из браузера: принимает «Cookie: a=1; b=2», «a=1; b=2» или
 * JSON-объект. Атрибуты (path/domain/expires/…) отбрасываются. Чистая функция.
 */
export function parseCookieString(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = String(input == null ? "" : input).trim();
  if (!raw) return out;
  if (raw.startsWith("{")) {
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(json)) {
        if (k && v != null && String(v) !== "") out[k.trim()] = String(v);
      }
      return out;
    } catch {
      /* не JSON — разберём как строку */
    }
  }
  raw = raw.replace(/^cookie\s*:\s*/i, "");
  for (const piece of raw.split(/[;\n]+/)) {
    const pair = piece.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || COOKIE_ATTR.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Импорт куки из браузера («Куки из браузера» в UI).
 *
 * Зачем: rutracker закрыт Cloudflare Bot Management, и `cf_clearance` можно
 * получить только в настоящем браузере. Если браузер ходит на форум через тот же
 * прокси/VPN, что и приложение, скопированная строка куки работает и для наших
 * запросов (cf_clearance привязан к IP и User-Agent — UA можно задать в настройках
 * форума, поле userAgent).
 */
export function importTrackerCookies(
  input: unknown,
  userAgent?: string,
): {
  ok: boolean;
  cookies: string[];
  session: { sid: string | null; updatedAt: string };
} {
  const cfg = trackerCfg();
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    throw trackerError("tracker_disabled", "адрес форума не задан в настройках");
  }
  const parsed = parseCookieString(input);
  const names = Object.keys(parsed);
  if (!names.length) throw trackerError("bad_query", "в строке не нашлось ни одной куки");
  const existing = loadSession(cfg.baseUrl);
  const session: TrackerSession = {
    baseUrl: cfg.baseUrl,
    cookies: { ...(existing?.cookies || {}), ...parsed },
    sid: parsed.sid || existing?.sid || null,
    updatedAt: new Date().toISOString(),
  };
  saveSession(session);
  chromiumLoggedIn = cookiesHaveLogin(session.cookies);
  // UA, которым куки получены (от окна входа): cf_clearance привязан к паре
  // «IP + User-Agent», поэтому подставляем его, если пользователь не задал свой.
  const ua = String(userAgent || "").trim();
  if (ua) {
    // UA окна входа — авторитетный: именно им Cloudflare выдал cf_clearance, и наши
    // запросы обязаны представляться так же (иначе снова «Just a moment…»).
    const next = trackerCfg();
    if (next.userAgent !== ua) {
      next.userAgent = ua;
      settings.set({ trackers: next });
      logger.action("movies.tracker_ua_set", { from: "login-window", replaced: !!cfg.userAgent });
    }
  }
  logger.action("movies.tracker_cookies_imported", { cookies: names.length });
  return { ok: true, cookies: names, session: { sid: session.sid, updatedAt: session.updatedAt } };
}

/** Имена куки текущей сессии (для UI — видно, есть ли сессия и cf_clearance). */
export function trackerCookieNames(): string[] {
  const cfg = trackerCfg();
  const s = cfg.baseUrl ? loadSession(cfg.baseUrl) : null;
  return s ? Object.keys(s.cookies) : [];
}

/** Результат «подхвата» куки из браузера. */
export interface BrowserImportResult {
  ok: boolean;
  /** Имена подхваченных куки (значения — секрет сессии форума). */
  cookies: string[];
  probes: BrowserProbe[];
  /** Откуда взяли: браузер/профиль/версия (по нему подбирается UA). */
  source: { browser: string; profile: string; version: string } | null;
  /** UA, подставленный в настройки форума (чтобы cf_clearance подошёл). */
  userAgent: string;
  /** Проверка после импорта: пускает ли форум с новыми куки. */
  probe: TrackerErrorDetails;
  session: { sid: string | null; updatedAt: string };
}

/**
 * URL «проверки сессии»: страница поиска без запроса. У движков с шаблоном {q}
 * (rutor) подставляем заглушку, иначе запрос ушёл бы на несуществующий путь.
 */
function probeUrl(cfg: TrackerCfg): string {
  return absUrl(cfg.baseUrl, cfg.searchPath.replace(/\{q(?:uery)?\}/gi, "_"));
}

/** Асинхронная проверка сессии: что отдаёт форум на страницу поиска с текущими
 *  куки. Нужна после импорта — сразу видно, пускает ли форум и не Cloudflare ли это. */
export async function probeTrackerSessionAsync(
  cookies?: Record<string, string>,
): Promise<TrackerErrorDetails> {
  const cfg = trackerCfg();
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    return { url: cfg.baseUrl, snippet: "адрес форума не задан" };
  }
  const jar = cookies || loadSession(cfg.baseUrl)?.cookies || {};
  // Без куки проверять нечего только там, где вход обязателен: поиск у rutor
  // анонимный, поэтому запрос всё равно имеет смысл.
  if (!Object.keys(jar).length && cfg.requiresLogin) {
    return { url: probeUrl(cfg), snippet: "куки не заданы" };
  }
  try {
    const res = await httpRequest(probeUrl(cfg), { jar });
    return pageDetails(res);
  } catch (e) {
    const err = e as TrackerError;
    return err?.details || { snippet: String(err?.message || e) };
  }
}

/**
 * Подхватить куки прямо из браузера: пользователю достаточно ОДИН раз открыть
 * форум в своём браузере (в котором он уже вошёл) и нажать «Подхватить из браузера».
 * Никаких DevTools и копирования строк — приложение само читает базу куки браузера.
 *
 * Если браузер не дал куки (не найден профиль, Chrome 127+ с app-bound encryption,
 * чужая учётная запись Windows) — это НЕ ошибка: возвращаем ok:false и список того,
 * что проверено, чтобы UI предложил вход через окно приложения.
 */
export async function importCookiesFromBrowsers(opts?: {
  collect?: (host: string) => BrowserCookieResult;
  probe?: (cookies: Record<string, string>) => Promise<TrackerErrorDetails>;
}): Promise<BrowserImportResult> {
  const cfg = trackerCfg();
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    throw trackerError("tracker_disabled", "адрес форума не задан в настройках");
  }
  let host: string;
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    throw trackerError("tracker_disabled", "адрес форума указан неверно");
  }

  const scan = (opts?.collect || ((h: string) => collectBrowserCookies(h)))(host);
  const existing = loadSession(cfg.baseUrl);
  const names = Object.keys(scan.cookies);

  if (!names.length) {
    logger.warn("movies.tracker_cookies_not_found", { host, probes: probesSummary(scan.probes) });
    return {
      ok: false,
      cookies: [],
      probes: scan.probes,
      source: null,
      userAgent: "",
      probe: { url: probeUrl(cfg), snippet: "куки в браузерах не найдены" },
      session: { sid: existing?.sid || null, updatedAt: existing?.updatedAt || "" },
    };
  }

  const session: TrackerSession = {
    baseUrl: cfg.baseUrl,
    cookies: { ...(existing?.cookies || {}), ...scan.cookies },
    sid: scan.cookies.sid || existing?.sid || null,
    updatedAt: new Date().toISOString(),
  };
  saveSession(session);

  // UA браузера-источника: cf_clearance привязан к паре «IP + User-Agent», поэтому
  // подставляем UA того браузера, откуда взяты куки (только если пользователь не
  // задал UA вручную и версию удалось определить).
  const source = scan.source
    ? { browser: scan.source.browser, profile: scan.source.profile, version: scan.source.version }
    : null;
  let userAgent = "";
  if (source && !cfg.userAgent) {
    userAgent = uaForBrowser(scan.source!.id, source.version);
    if (userAgent) {
      const next = trackerCfg();
      next.userAgent = userAgent;
      settings.set({ trackers: next });
      logger.action("movies.tracker_ua_from_browser", { browser: source.browser, version: source.version });
    }
  }

  const probe = await (opts?.probe || probeTrackerSessionAsync)(session.cookies);
  logger.action("movies.tracker_cookies_from_browser", {
    host,
    cookies: names.length,
    source: source ? `${source.browser}/${source.profile}` : "?",
    cloudflare: !!probe.cloudflare,
    authorized: !!probe.authorized,
  });
  return {
    ok: true,
    cookies: names,
    probes: scan.probes,
    source,
    userAgent,
    probe,
    session: { sid: session.sid, updatedAt: session.updatedAt },
  };
}

/* ===================== Chromium-транспорт (окно входа) =====================

 * ЗАЧЕМ ЭТО НУЖНО. Форум закрыт Cloudflare Bot Management: `tracker.php` и
 * `login.php` отдают страницу-проверку («Just a moment…») всем, кто не выглядит
 * настоящим браузером. Проверено на живом rutracker:
 *   - undici (Node) через прокси получает 403 на tracker.php (index.php — 200);
 *   - Chrome/Edge 127+ шифруют куки app-bound ключом (v20) — прочитать их извне
 *     нельзя в принципе, поэтому «взять куки из браузера пользователя» не работает;
 *   - окно входа внутри приложения (Electron Chromium) проходит проверку и
 *     хранит куки в своей session, откуда Chromium отдаёт их сам.
 *
 * Поэтому, когда доступен Electron, запросы к форуму идут ЧЕРЕЗ СЕТЕВОЙ СТЕК
 * CHROMIUM (session.fetch): настоящие TLS/HTTP2-отпечатки, куки и UA той же
 * сессии, что и окно входа. Вне Electron (standalone-сервер, тесты) остаётся
 * обычный fetch с per-page прокси.
 */

/** Мини-контракт Electron-сессии (полный тип тянет electron в сборку сервера). */
interface ChromiumCookies {
  /** Без аргументов Electron отдаёт ВСЕ куки раздела (фильтр по пути отбрасывал бы
   *  куки форума: rutracker ставит bb_data с `Path=/forum/`). */
  get(filter?: {
    url?: string;
  }): Promise<{ name: string; value: string; domain?: string; path?: string }[]>;
  remove(url: string, name: string): Promise<void>;
}
interface ChromiumSession {
  fetch(url: string, init: RequestInit): Promise<Response>;
  cookies: ChromiumCookies;
  /** UA сессии: окно входа и `fetch` должны представляться одинаково. */
  getUserAgent?(): string;
  setUserAgent?(userAgent: string, acceptLanguages?: string): Promise<void>;
}

/** Раздел сессии окна входа (одинаковый в main.js и здесь). */
export const TRACKER_PARTITION = "persist:moonapp-tracker";

/** Языки для Accept-Language в сессии Chromium (как у окна входа). */
const CHROMIUM_LANGS = "ru-RU,ru;q=0.9,en;q=0.8";

/**
 * UA, которым представляется сессия окна входа.
 *
 * Заполняется при синхронизации: главное — НЕ перебить UA окна входа своим
 * значением. `cf_clearance` привязан к паре «IP + User-Agent», поэтому заголовки
 * скрапера обязаны повторять тот UA, которым проверка Cloudflare была пройдена.
 */
let chromiumUa = "";

/** Сессия окна входа, привязанная приложением (Electron main) или тестами. */
let boundChromiumSession: ChromiumSession | null = null;

/**
 * Подходящий ли домен куки целевому хосту (совпадает или является его поддоменом).
 * Локальная копия логики hostMatches из browserCookies — чтобы не тянуть модуль
 * чтения браузерных куки в серверную сборку.
 */
export function cookieDomainMatches(domain: string, host: string): boolean {
  const d = String(domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  const h = String(host || "").toLowerCase();
  if (!d) return true; // без домена — считаем своей (раздел окна входа отдельный)
  if (!h) return false;
  return d === h || d.endsWith("." + h) || h.endsWith("." + d);
}

/**
 * Годится ли UA сессии для форума.
 *
 * UA Chromium приложения содержит «Electron/…» (и имя приложения) — Cloudflare
 * считает такой отпечаток ботом и отдаёт проверку. Такой UA не используем: лучше
 * наш браузерный, который выглядит как обычный Chrome.
 */
export function chromiumUaUsable(ua: string): boolean {
  const s = String(ua || "").trim();
  return !!s && !/electron/i.test(s) && !/\bmoonapp\/[0-9]/i.test(s);
}

/**
 * Привести UA сессии окна входа к нужному.
 *
 * Порядок важен:
 *  1) UA задан в настройках форума — ставим его (пользователь так решил);
 *  2) иначе берём UA самой сессии, если он похож на обычный браузер (это UA, которым
 *     окно входа прошло Cloudflare);
 *  3) иначе ставим наш браузерный UA — заголовки и сессия обязаны совпадать, иначе
 *     Cloudflare снова отдаёт «Just a moment…».
 */
async function applyChromiumUserAgent(ses: ChromiumSession): Promise<void> {
  const explicit = String(trackerCfg().userAgent || "").trim();
  const current =
    typeof ses.getUserAgent === "function" ? String(ses.getUserAgent() || "").trim() : "";
  const want = explicit || (chromiumUaUsable(current) ? current : DEFAULT_UA);
  if (typeof ses.setUserAgent === "function" && current !== want) {
    try {
      await ses.setUserAgent(want, CHROMIUM_LANGS);
    } catch {
      /* нет прав на смену UA — отправим заголовок вручную */
    }
  }
  chromiumUa = want;
}

/**
 * Активная Chromium-сессия приложения или null.
 *
 * `require("electron")` в основном процессе отдаёт объект Electron, в чистом Node —
 * путь к бинарю (или исключение), поэтому проверяем наличие `session.fromPartition`.
 */
/**
 * Активная Chromium-сессия приложения или null.
 *
 * Приоритет — у сессии, привязанной приложением (bindChromiumSession): так модуль
 * не зависит от `require("electron")` и его можно проверить тестами. Если сессию не
 * привязывали (standalone-сервер), пробуем получить её сами.
 */
function chromiumSession(): ChromiumSession | null {
  if (boundChromiumSession) return boundChromiumSession;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as {
      session?: { fromPartition?: (p: string) => ChromiumSession };
    };
    const fromPartition = electron?.session?.fromPartition;
    if (typeof fromPartition !== "function") return null;
    return fromPartition.call(electron.session, TRACKER_PARTITION) || null;
  } catch {
    return null; // приложение ещё не готово (или это не Electron)
  }
}

/**
 * Привязать сессию окна входа (вызывает Electron-процесс при старте: main.js).
 *
 * Зачем: запросы к форуму идут через сетевой стек ЭТОЙ сессии (настоящие
 * TLS/HTTP2-отпечатки и те же куки, что прошли Cloudflare). Пустое значение
 * отвязывает сессию (нужно тестам, чтобы вернуться к обычному fetch).
 */
export function bindChromiumSession(ses: unknown): void {
  const s = ses as ChromiumSession | null;
  boundChromiumSession = s && typeof s.fetch === "function" && s.cookies ? s : null;
  chromiumUa = "";
}

/** Доступен ли Chromium-транспорт (для статуса в UI). */
export function chromiumTransportAvailable(): boolean {
  return !!chromiumSession();
}

/**
 * Перенести куки Chromium-сессии в нашу сессию.
 *
 * Это и есть «автоматический подхват»: куки окна входа остаются в Chromium (он
 * сам их расшифровывает — app-bound ключ нас не касается), а мы лишь сохраняем их
 * копию, чтобы наша логика (проверка «вошли/не вошли», статус, логи) работала.
 */
async function syncChromiumCookies(baseUrl: string): Promise<Record<string, string>> {
  const ses = chromiumSession();
  if (!ses) return {};
  await applyChromiumUserAgent(ses);
  try {
    // Без фильтра по URL: у rutracker куки сессии выставлены с `Path=/forum/`, и
    // фильтр `{url: baseUrl}` (путь «/») их не вернул бы — вход выглядел бы пустым.
    const list = await ses.cookies.get({});
    let host = "";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* нет хоста — берём все куки раздела */
    }
    const out: Record<string, string> = {};
    for (const c of list || []) {
      if (!c?.name) continue;
      if (host && !cookieDomainMatches(String(c.domain || ""), host)) continue;
      out[c.name] = String(c.value ?? "");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Признак живой сессии форума (куки, которые форум ставит ТОЛЬКО вошедшим).
 *
 * ВАЖНО про rutracker: `bb_guid`, `bb_ssl`, `bb_session` форум ставит и Гостю, а
 * `bb_t` — вообще трекинг. Если считать их признаком входа, приложение думает, что
 * «уже вошли», окно входа закрывается сразу после проверки Cloudflare (до ввода
 * логина), а поиск уходит гостем. Вход отмечает только `bb_data` (в нём id сессии
 * пользователя).
 *
 * Куки-признаки берём из пресета движка (cfg.loginCookies). Если движку вход не
 * нужен вовсе (rutor), функция отвечает true: «вход есть или не требуется» —
 * именно так это значение используют и статус, и автопоиск.
 */
export function cookiesHaveLogin(cookies: Record<string, string>, cfg?: TrackerCfg): boolean {
  const required = (cfg || trackerCfg()).loginCookies;
  if (!required.length) return true;
  return required.some((n) => !!cookies[n]);
}

/** Стереть куки Chromium-сессии (выход): окно входа перестанет быть авторизованным. */
async function clearChromiumCookies(baseUrl: string): Promise<number> {
  const ses = chromiumSession();
  if (!ses) return 0;
  let removed = 0;
  try {
    // Как и при синхронизации: берём все куки раздела и фильтруем по домену, иначе
    // куки с путём /forum/ остались бы и «выход» ничего не менял.
    const list = await ses.cookies.get({});
    let host = "";
    let scheme = "https";
    try {
      const u = new URL(baseUrl);
      host = u.hostname;
      scheme = u.protocol.replace(":", "") || "https";
    } catch {
      /* нет хоста — чистим всё, что вернул раздел */
    }
    for (const c of list || []) {
      if (!c?.name) continue;
      if (host && !cookieDomainMatches(String(c.domain || ""), host)) continue;
      try {
        // URL для удаления собираем по СОБСТВЕННОМУ пути куки: Chromium ищет куку
        // по «домен + путь», и для куки с Path=/forum/ адрес «/» не подошёл бы —
        // выход оставлял бы сессию форума живой.
        const removeUrl = `${scheme}://${host}${String(c.path || "/") || "/"}`;
        await ses.cookies.remove(removeUrl, c.name);
        removed++;
      } catch {
        /* отдельная кука не удалилась — не критично */
      }
    }
  } catch {
    /* сессии нет */
  }
  return removed;
}

/* ======================= HTTP-слой ======================= */

/** Задержки между запросами к форуму (вежливость + защита от бан-листа). */
let lastRequestAt = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Значения Set-Cookie, которые не куки, а атрибуты. */
const COOKIE_ATTR = /^(expires|path|domain|max-age|samesite|secure|httponly|priority)$/i;

/** Один заголовок Set-Cookie может содержать несколько куки через запятую. */
function splitCookieHeader(line: string): string[] {
  return String(line || "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
}

/** Забрать куки из ответа в jar (мутирует jar). */
function absorbCookies(res: Response, jar: Record<string, string>): void {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const raw = lines.length ? lines : [res.headers.get("set-cookie") || ""].filter(Boolean);
  for (const line of raw) {
    for (const piece of splitCookieHeader(line)) {
      const pair = piece.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || COOKIE_ATTR.test(name)) continue;
      // phpBB удаляет куку пустым значением или словом "deleted".
      if (!value || /^(deleted|expired)$/i.test(value)) delete jar[name];
      else jar[name] = value;
    }
  }
}

/** Заголовок Cookie из jar. */
function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Ответ форума: статус, байты и уже раскодированный текст. */
export interface HttpResult {
  status: number;
  buffer: Buffer;
  text: string;
  url: string;
  headers: Headers;
}

/**
 * Запрос к форуму. Учитывает:
 *  - per-page прокси страницы «movies» (с откатом на прямое соединение);
 *  - один повтор при сетевой ошибке (форумы любят рвать соединения);
 *  - таймаут (AbortSignal.timeout) и троттлинг minIntervalMs;
 *  - накопление куки-сессии в переданный jar.
 */
async function httpRequest(
  url: string,
  opts: {
    method?: string;
    body?: Buffer | string;
    jar?: Record<string, string>;
    headers?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<HttpResult> {
  const cfg = trackerCfg();
  const jar = opts.jar || {};
  const wait = cfg.minIntervalMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);

  const headers: Record<string, string> = {
    // UA обязательно совпадает с тем, которым окно входа прошло Cloudflare:
    // cf_clearance привязан к паре «IP + User-Agent» (см. applyChromiumUserAgent).
    "User-Agent": cfg.userAgent || chromiumUa || DEFAULT_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    ...(opts.headers || {}),
  };
  const cookies = cookieHeader(jar);
  if (cookies) headers.Cookie = cookies;

  const timeout = opts.timeout || cfg.timeoutMs;
  const init: RequestInit = {
    method: opts.method || "GET",
    headers,
    body: (opts.body ?? null) as RequestInit["body"],
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  };

  const chromium = chromiumSession();
  if (chromium) {
    // Окно входа и скрапер делят одну сессию: куки (включая cf_clearance) берём
    // из Chromium, запрос отправляем ЕГО стеком — форум видит настоящий браузер.
    const sesCookies = await syncChromiumCookies(cfg.baseUrl);
    if (Object.keys(sesCookies).length) {
      const merged = { ...jar, ...sesCookies };
      for (const [k, v] of Object.entries(sesCookies)) jar[k] = v;
      headers.Cookie = cookieHeader(merged);
      persistSessionCookies(cfg, merged);
    }
    let res: Response;
    try {
      res = await chromium.fetch(url, init);
    } catch (e) {
      lastRequestAt = Date.now();
      throw trackerError("network_error", (e as Error).message);
    }
    lastRequestAt = Date.now();
    return await finishResponse(cfg, url, res, jar);
  }

  const attempt = async (useProxy: boolean): Promise<Response> =>
    useProxy ? pageFetch(url, init) : fetch(url, init);

  let useProxy = false;
  try {
    useProxy = !!getUndiciDispatcherForPage(PAGE_ID);
  } catch {
    useProxy = false;
  }

  let res: Response;
  try {
    res = await runWithPage(PAGE_ID, () => attempt(useProxy));
  } catch (first) {
    // Сеть/прокси подвели: один повтор (напрямую, если был прокси).
    logger.warn("movies.tracker_net_retry", { url, error: (first as Error).message });
    await sleep(400);
    try {
      res = await attempt(false);
      useProxy = false;
    } catch (second) {
      lastRequestAt = Date.now();
      throw trackerError("network_error", (second as Error).message);
    }
  }
  lastRequestAt = Date.now();
  return await finishResponse(cfg, url, res, jar);
}

/**
 * Общий «хвост» ответа форума: накопить куки, декодировать cp1251 и отличить
 * страницу-проверку Cloudflare от настоящей выдачи (иначе она выглядела бы как
 * «на странице нет формы входа» = «мы вошли», и поиск падал с непонятной ошибкой).
 */
async function finishResponse(
  cfg: TrackerCfg,
  url: string,
  res: Response,
  jar: Record<string, string>,
): Promise<HttpResult> {
  absorbCookies(res, jar);
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = decodeBytes(buffer, cfg.encoding);
  const result: HttpResult = {
    status: res.status,
    buffer,
    text,
    url: res.url || url,
    headers: res.headers,
  };
  // Cloudflare Bot Management отдаёт челлендж вместо контента (403 «Just a moment…»).
  // Именно так ведёт себя rutracker: index.php доступен, а tracker.php/login.php —
  // нет.
  if (
    isCloudflareChallenge(text, res.status) ||
    /challenge/i.test(String(res.headers.get("cf-mitigated") || ""))
  ) {
    throw cfError(result);
  }
  return result;
}

/**
 * Обновить файл сессии, если куки изменились (Chromium-сессия окна входа —
 * источник правды). sid сохраняем; при отсутствии изменений файл не трогаем.
 */
function persistSessionCookies(cfg: TrackerCfg, cookies: Record<string, string>): void {
  const existing = loadSession(cfg.baseUrl);
  const prev = existing?.cookies || {};
  const names = Object.keys(cookies);
  const same =
    names.length === Object.keys(prev).length && names.every((n) => prev[n] === cookies[n]);
  if (same) return;
  saveSession({
    baseUrl: cfg.baseUrl,
    cookies,
    sid: cookies.sid || existing?.sid || null,
    updatedAt: new Date().toISOString(),
  });
}

/* ======================= Авторизация ======================= */

/** Запомнить ошибку (для /tracker/status) и пробросить её дальше. */
function rememberError(e: unknown): never {
  const err = e as TrackerError;
  lastError = {
    code: err?.code || "error",
    message: String(err?.message || e),
    at: new Date().toISOString(),
  };
  // Диагностику пишем в лог: по ней видно, что именно вернул форум.
  if (err?.details) logger.warn("movies.tracker_error", { code: err.code, ...err.details });
  throw e;
}

/** Страница «не авторизованы»? Форма входа — точный признак. */
function isGuestPage(html: string): boolean {
  return hasLoginForm(html);
}

/** На странице логина распознаём капчу (решать её не пытаемся). */
function hasCaptcha(html: string): boolean {
  return /(cap_code|cap_sid|captcha|капч)/i.test(html);
}

/**
 * Вход на форум (login + password из секретов).
 *
 * Скрытые поля формы (phpBB: creation_time/form_token/sid) переносим в POST —
 * без них форум отвергает логин. Тело формы кодируется в cp1251: для логина это
 * не критично (латиница), но для форумов с кириллическим ником — обязательно.
 */
export async function trackerLogin(): Promise<TrackerSession> {
  const cfg = trackerCfg();
  if (!cfg.enabled) throw trackerError("tracker_disabled", "tracker search is disabled");
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    throw trackerError("tracker_disabled", "tracker baseUrl is not configured");
  }
  const creds = trackerCredentials();
  if (!creds) throw trackerError("no_credentials", "tracker login/password are not set");

  const loginUrl = absUrl(cfg.baseUrl, cfg.loginPath);
  const jar: Record<string, string> = {};

  try {
    // 1) Страница входа: забираем скрытые поля формы.
    const form = await httpRequest(loginUrl, { jar });
    const hidden = parseHiddenInputs(form.text);

    // 2) POST логин/пароль в кодировке форума.
    const body = Buffer.from(
      formEncode(
        { ...hidden, login_username: creds.login, login_password: creds.password, login: "Вход" },
        cfg.encoding,
      ),
      "latin1",
    );
    const res = await httpRequest(loginUrl, {
      method: "POST",
      body,
      jar,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: loginUrl,
        Origin: cfg.baseUrl,
      },
    });
    if (hasCaptcha(res.text)) {
      throw trackerError(
        "captcha_required",
        "форум требует капчу: войдите на форуме в браузере и повторите поиск",
      );
    }

    // Проверка сессии: страница поиска без формы входа = вошли. Cloudflare-челлендж
    // сюда не доходит — httpRequest бросает cf_challenge раньше, поэтому «пустая
    // страница без формы» больше не принимается за успешный вход.
    const probe = await httpRequest(probeUrl(cfg), { jar });
    if (isGuestPage(probe.text)) {
      throw trackerError("login_failed", "форум отклонил логин или пароль", pageDetails(probe));
    }

    const session: TrackerSession = {
      baseUrl: cfg.baseUrl,
      cookies: jar,
      sid: findSid(probe.text) || findSid(res.text) || jar.sid || null,
      updatedAt: new Date().toISOString(),
    };
    saveSession(session);
    logger.action("movies.tracker_login", {
      host: new URL(cfg.baseUrl).host,
      cookies: Object.keys(jar).length,
    });
    return session;
  } catch (e) {
    return rememberError(e);
  }
}

/**
 * Гарантировать рабочую сессию: свежую берём с диска, старую перепроверяем,
 * нерабочую — перелогиниваемся. Это и есть «переиспользование куки bb_data/sid».
 */
async function ensureSession(): Promise<TrackerSession> {
  const cfg = trackerCfg();
  // Движок без входа (rutor): поиск работает анонимно, но куки площадки (в том
  // числе облачные проверки) всё равно полезны — берём то, что есть на диске, и
  // НЕ пытаемся логиниться (логина у такого движка нет).
  if (!cfg.requiresLogin) {
    const existing = loadSession(cfg.baseUrl);
    return (
      existing || {
        baseUrl: cfg.baseUrl,
        cookies: {},
        sid: null,
        updatedAt: new Date().toISOString(),
      }
    );
  }
  // 1) Сессия окна входа (Chromium) — приоритетный источник: пользователь мог
  //    войти в окне приложения, и тогда логин с паролем вообще не нужны.
  const sesCookies = await syncChromiumCookies(cfg.baseUrl);
  if (Object.keys(sesCookies).length) {
    chromiumLoggedIn = cookiesHaveLogin(sesCookies, cfg);
    if (chromiumLoggedIn) {
      const merged = { ...(loadSession(cfg.baseUrl)?.cookies || {}), ...sesCookies };
      persistSessionCookies(cfg, merged);
      return {
        baseUrl: cfg.baseUrl,
        cookies: merged,
        sid: merged.sid || null,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  const cached = loadSession(cfg.baseUrl);
  if (cached) {
    const age = Date.now() - parseStamp(cached.updatedAt);
    if (Number.isFinite(age) && age < TRUST_TTL_MS) return cached;
    if (Number.isFinite(age) && age < SESSION_TTL_MS) {
      // Сессия «в возрасте»: одним запросом проверяем, что форум нас ещё помнит.
      const probe = await httpRequest(probeUrl(cfg), {
        jar: cached.cookies,
      });
      if (!isGuestPage(probe.text)) {
        cached.updatedAt = new Date().toISOString();
        cached.sid = findSid(probe.text) || cached.sid;
        saveSession(cached);
        return cached;
      }
      logger.info("movies.tracker_session_expired", { host: new URL(cfg.baseUrl).host });
    }
  }
  const fresh = await trackerLogin();
  return fresh;
}

/* ======================= Поиск ======================= */

/**
 * Разбор метки времени из БД.
 *
 * `db.now()` пишет время в UTC БЕЗ суффикса Z («2026-09-18 16:20:00»), а
 * `Date.parse` такую строку понимает как ЛОКАЛЬНУЮ — в любом часовом поясе кроме
 * UTC это давало сдвиг на часы, и кэш считался всегда протухшим. Дописываем Z.
 */
function parseStamp(value: unknown): number {
  const s = String(value || "")
    .trim()
    .replace(" ", "T");
  if (!s) return NaN;
  return Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
}

/** Кэш результатов поиска в БД (tracker_search_cache), TTL 10 минут. */
function cacheGet(key: string): TrackerSearchResult | null {
  const row = stmts.tscGet.get(key);
  if (!row) return null;
  const age = Date.now() - parseStamp(row.cached_at);
  if (!Number.isFinite(age) || age > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(String(row.json)) as TrackerSearchResult;
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: TrackerSearchResult): void {
  try {
    stmts.tscSet.run(key, JSON.stringify(value));
  } catch (e) {
    logger.warn("movies.tracker_cache_set_failed", { error: (e as Error).message });
  }
}

/** Сбросить кэш поиска (кнопка «Обновить» на странице). */
export function clearTrackerCache(): void {
  try {
    stmts.tscClear.run();
  } catch {
    /* кэш — не критичная часть */
  }
}

/** Строка таблицы → раздача для UI (абсолютные ссылки + метаданные названия). */
function toRelease(cfg: TrackerCfg, row: RawReleaseRow): TrackerRelease {
  return {
    id: row.id,
    title: row.title,
    size: row.sizeText,
    sizeBytes: row.sizeBytes,
    seeders: row.seeders,
    leechers: row.leechers,
    downloads: row.downloads,
    topicUrl: row.id ? absUrl(cfg.baseUrl, cfg.topicPath.replace("{id}", row.id)) : null,
    // .torrent строим ТОЛЬКО когда в строке реально была ссылка на скачивание:
    // иначе «открыть раздачу» вёл бы на несуществующий URL (и фильтр
    // requireDownloadable перестал бы что-либо отсеивать).
    torrentUrl: row.torrentId
      ? absUrl(cfg.baseUrl, cfg.torrentPath.replace("{id}", row.torrentId))
      : null,
    magnet: row.magnet,
    meta: parseReleaseMeta(row.title),
  };
}

/** Один запрос поиска с уже готовой сессией. */
async function sendSearch(
  cfg: TrackerCfg,
  query: string,
  jar: Record<string, string>,
): Promise<HttpResult> {
  const searchUrl = absUrl(cfg.baseUrl, cfg.searchPath);
  // Шаблон {q} в пути (rutor: /search/0/0/000/0/{q}): запрос — часть ПУТИ, а не
  // параметр; разделитель пробела только %20 (`+` в пути — литеральный плюс).
  if (/\{q(?:uery)?\}/i.test(cfg.searchPath)) {
    const encoded = pctEncode(query, cfg.encoding, false);
    return httpRequest(searchUrl.replace(/\{q(?:uery)?\}/gi, encoded), { jar });
  }
  if (cfg.searchMethod === "get") {
    // GET: значение параметра кодируем в кодировке форума (cp1251 → %C2%EE...).
    const sep = searchUrl.includes("?") ? "&" : "?";
    const qs = formEncode({ [cfg.searchParam]: query }, cfg.encoding);
    return httpRequest(`${searchUrl}${sep}${qs}`, { jar });
  }
  const body = Buffer.from(formEncode({ [cfg.searchParam]: query }, cfg.encoding), "latin1");
  return httpRequest(searchUrl, {
    method: "POST",
    body,
    jar,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: searchUrl },
  });
}

/**
 * Поиск с защитой от разлогина: если форум ответил формой входа (истёк sid),
 * один раз логинимся заново и повторяем запрос.
 */
async function runSearch(
  cfg: TrackerCfg,
  query: string,
  session: TrackerSession,
): Promise<{ rows: RawReleaseRow[]; via: "proxy" | "direct" }> {
  let res = await sendSearch(cfg, query, session.cookies);
  // Форма входа в ответе = сессия истекла: один раз логинимся и повторяем.
  // Движкам без входа (rutor) перелогин не нужен — логина у них и нет.
  if (cfg.requiresLogin && isGuestPage(res.text)) {
    logger.info("movies.tracker_search_relogin", { url: res.url });
    const fresh = await trackerLogin();
    session.cookies = fresh.cookies;
    session.sid = fresh.sid;
    res = await sendSearch(cfg, query, session.cookies);
    if (isGuestPage(res.text)) {
      throw trackerError(
        "session_expired",
        "форум снова требует вход: проверьте логин/пароль или капчу",
        pageDetails(res),
      );
    }
  }

  const rows = parseReleasesByEngine(res.text, cfg.engine);
  if (!rows.length && !looksLikeNoResults(res.text)) {
    // Выдачу не разобрали и «не найдено» не написано: отдаём диагностику
    // (статус, размер, начало видимого текста), а не только «изменилась разметка».
    throw trackerError(
      "parse_failed",
      `не удалось разобрать таблицу результатов (HTTP ${res.status}, ${res.buffer.length} байт)`,
      pageDetails(res),
    );
  }
  let via: "proxy" | "direct";
  try {
    via = getUndiciDispatcherForPage(PAGE_ID) ? "proxy" : "direct";
  } catch {
    via = "direct";
  }
  return { rows, via };
}

/**
 * ПОИСК РАЗДАЧ НА ФОРУМЕ (главная функция модуля).
 *
 * Авторизуется (или переиспользует сохранённые куки bb_data/sid), ищет по строке
 * в кодировке форума, разбирает HTML-таблицу, обогащает названия метаданными
 * (resolution/audio/codec/releaseGroup/…) и возвращает массив,
 * ОТСОРТИРОВАННЫЙ ПО СИДАМ (по убыванию), затем по размеру.
 *
 * Результаты кэшируются на 10 минут в tracker_search_cache, чтобы не долбить
 * форум при каждом перерендере страницы (forceRefresh — кнопка «Обновить»).
 */
export async function searchTrackerReleases(
  query: unknown,
  opts: { limit?: number; forceRefresh?: boolean } = {},
): Promise<TrackerSearchResult> {
  const cfg = trackerCfg();
  const q = String(query == null ? "" : query)
    .replace(/\s+/g, " ")
    .trim();
  if (!q) throw trackerError("bad_query", "строка поиска пуста");
  if (q.length > MAX_QUERY) {
    throw trackerError("bad_query", `строка поиска длиннее ${MAX_QUERY} символов`);
  }
  if (!cfg.enabled) throw trackerError("tracker_disabled", "поиск по форуму выключен в настройках");
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    throw trackerError("tracker_disabled", "адрес форума не задан в настройках");
  }
  if (cfg.requiresLogin && !trackerCredentials() && !chromiumLoggedIn) {
    // Логин с паролем может не понадобиться: вход можно выполнить в окне
    // приложения (Chromium) — тогда сессия форума уже живая.
    throw trackerError(
      "no_credentials",
      "не заданы логин и пароль форума (или войдите в окне входа)",
    );
  }

  const limit = Math.min(Math.max(1, Number(opts.limit) || cfg.maxResults), cfg.maxResults);
  const key = `tracker:${cfg.baseUrl}:${q.toLowerCase()}:${limit}`;
  if (!opts.forceRefresh) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  try {
    const session = await ensureSession();
    // Гостевая сессия (нет bb_data) — это не «не удалось разобрать страницу»:
    // честно говорим, что вход не выполнен, и что с этим делать. Для движков без
    // входа (rutor) проверка не нужна: поиск работает анонимно.
    if (cfg.requiresLogin && !cookiesHaveLogin(session.cookies, cfg) && !trackerCredentials()) {
      throw trackerError(
        "no_credentials",
        "вход на форум не выполнен: войдите в окне «Войти на форум» или задайте логин и пароль",
      );
    }
    const { rows, via } = await runSearch(cfg, q, session);
    const items = rows
      .map((r) => toRelease(cfg, r))
      .filter((r) => (cfg.requireDownloadable ? !!(r.magnet || r.torrentUrl) : true))
      .sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)
      .slice(0, limit);
    const result: TrackerSearchResult = { query: q, items, total: rows.length, cached: false, via };
    cacheSet(key, result);
    logger.action("movies.tracker_search", {
      query: q,
      found: rows.length,
      shown: items.length,
      via,
      // Диагностика транспорта: именно она показывает, уходил ли запрос стеком
      // Chromium (тогда cf_clearance работает) или обычным fetch.
      transport: chromiumTransportAvailable() ? "chromium" : "fetch",
      cookies: Object.keys(session.cookies).length,
      login: cookiesHaveLogin(session.cookies, cfg),
    });
    return result;
  } catch (e) {
    return rememberError(e);
  }
}

/** Состояние форума для UI (без пароля и без куки). */
export function trackerStatus(): TrackerStatus {
  const cfg = trackerCfg();
  const session = cfg.baseUrl ? loadSession(cfg.baseUrl) : null;
  const hasCreds = !!trackerCredentials();
  return {
    enabled: cfg.enabled,
    configured: /^https?:\/\//i.test(cfg.baseUrl),
    hasCredentials: hasCreds,
    label: cfg.label,
    baseUrl: cfg.baseUrl,
    engine: cfg.engine,
    requiresLogin: cfg.requiresLogin,
    presets: trackerPresetList(),
    // Для движка без входа «сессии нет» — это норма, а не проблема: показываем
    // готовность к поиску, иначе UI просил бы войти там, где вход не нужен.
    session: {
      ok: cookiesHaveLogin(session?.cookies || {}, cfg),
      updatedAt: session?.updatedAt || null,
    },
    cookieNames: session ? Object.keys(session.cookies) : [],
    lastError,
    // Окно входа: единственный путь, который проходит Cloudflare-проверку форума
    // (см. комментарий у chromiumSession). loginUrl открывает страницу входа, а
    // proxyUrl (если прокси включён) гарантирует тот же IP, что у поиска.
    chromium: {
      available: !!chromiumSession(),
      partition: TRACKER_PARTITION,
      loggedIn: chromiumLoggedIn || cookiesHaveLogin(session?.cookies || {}, cfg),
    },
    loginUrl: /^https?:\/\//i.test(cfg.baseUrl) ? absUrl(cfg.baseUrl, cfg.loginPath) : "",
    proxyUrl: resolveProxyUrl(),
    userAgent: cfg.userAgent || "",
  };
}

/**
 * Применить пресет трекера (переключатель в UI).
 *
 * Почему целиком, а не «одним полем engine»: у площадок разные пути, кодировка и
 * способ поиска, поэтому частичное обновление оставило бы «хвосты» предыдущего
 * трекера (например, `/forum/tracker.php` при движке rutor). Пользовательские
 * настройки, не относящиеся к площадке (пауза, таймаут, лимит, UA), сохраняем.
 *
 * Логин/пароль НЕ трогаем: они лежат в секретах (storage/secrets.json), а сессии
 * трекеров не пересекаются — файл сессии называется по хосту
 * (storage/trackers/session-<host>.json), поэтому возврат к прежнему трекеру
 * подхватит его же сессию.
 */
export function applyTrackerPreset(id: unknown): {
  ok: boolean;
  id: string;
  engine: TrackerEngine;
  label: string;
  baseUrl: string;
} {
  const preset = presetById(id);
  if (!preset) throw trackerError("bad_query", `неизвестный трекер: ${String(id || "")}`);
  const current = trackerCfg();
  settings.set({
    trackers: {
      // Поля площадки — из пресета.
      engine: preset.engine,
      baseUrl: preset.baseUrl,
      label: preset.label,
      loginPath: preset.loginPath,
      searchPath: preset.searchPath,
      searchMethod: preset.searchMethod,
      searchParam: preset.searchParam,
      topicPath: preset.topicPath,
      torrentPath: preset.torrentPath,
      encoding: preset.encoding,
      // Пользовательские предпочтения — как были.
      enabled: current.enabled,
      userAgent: current.userAgent,
      minIntervalMs: current.minIntervalMs,
      timeoutMs: current.timeoutMs,
      maxResults: current.maxResults,
      requireDownloadable: current.requireDownloadable,
    },
  });
  clearTrackerCache(); // выдача другого трекера — кэш недействителен
  logger.action("movies.tracker_preset", { id: preset.id, engine: preset.engine, url: preset.baseUrl });
  return {
    ok: true,
    id: preset.id,
    engine: preset.engine,
    label: preset.label,
    baseUrl: preset.baseUrl,
  };
}

/** SOCKS-URL прокси для страницы «movies» (или null): нужен окну входа. */
function resolveProxyUrl(): string | null {
  try {
    return perPageProxy.resolveProxyForPage(PAGE_ID).proxyUrl;
  } catch {
    return null;
  }
}

/** Название файла из Content-Disposition (RFC5987 + обычный filename). */
function filenameFromDisposition(value: string | null): string | null {
  const s = String(value || "");
  const star = /filename\*=UTF-8''([^;]+)/i.exec(s);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* мусор в заголовке — попробуем обычный filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(s);
  return plain ? plain[1].trim() : null;
}

/**
 * Скачать .torrent раздачи. Делает ТОЛЬКО бэкенд: сессионные куки форума
 * остаются на сервере и в браузер не попадают.
 */
export async function downloadTrackerTorrent(
  releaseId: unknown,
): Promise<{ buffer: Buffer; name: string }> {
  const cfg = trackerCfg();
  const id = String(releaseId == null ? "" : releaseId).trim();
  if (!/^\d{1,12}$/.test(id)) throw trackerError("bad_release", "некорректный id раздачи");
  try {
    const session = await ensureSession();
    const url = absUrl(cfg.baseUrl, cfg.torrentPath.replace("{id}", id));
    const res = await httpRequest(url, {
      jar: session.cookies,
      headers: {
        Referer: absUrl(cfg.baseUrl, cfg.topicPath.replace("{id}", id)),
        Accept: "application/x-bittorrent,*/*;q=0.8",
      },
    });
    // Валидный .torrent — bencode-словарь, первый байт 'd'. Если форум вернул
    // HTML (приветственная/страница входа), честно сообщаем об ошибке, а не
    // кормим торрент-клиент мусором.
    if (!res.buffer.length || res.buffer[0] !== 0x64) {
      throw trackerError(
        "torrent_download_failed",
        "форум вернул не .torrent — нужен вход с аккаунта, у которого есть доступ к раздаче",
      );
    }
    const name =
      filenameFromDisposition(res.headers.get("content-disposition")) || `tracker-${id}.torrent`;
    logger.action("movies.tracker_torrent_downloaded", { id, bytes: res.buffer.length });
    return { buffer: res.buffer, name };
  } catch (e) {
    return rememberError(e);
  }
}

/**
 * «Открыть раздачу»: скачиваем .torrent своими куками и сразу отдаём список
 * медиафайлов (метаданные доступны до полного скачивания — см.
 * torrent.getTorrentFileList), с которым фронт уже работает как обычно.
 */
export async function addTrackerRelease(
  releaseId: unknown,
  opts: { title?: string; magnet?: string } = {},
): Promise<TorrentAdded & { release: { id: string; name: string } }> {
  const id = String(releaseId == null ? "" : releaseId).trim();
  const { buffer, name } = await downloadTrackerTorrent(id);
  // Раздача попадает в реестр «Скачанные» вместе с названием фильма и id на
  // трекере: по названию окно плеера восстанавливается, а .torrent-метафайл
  // (его сохраняет torrent.add) позволяет возобновить загрузку после паузы.
  const added = await getTorrentFileList(buffer, {
    title: String(opts.title || "").trim(),
    releaseId: id,
    magnet: opts.magnet ? String(opts.magnet) : undefined,
  });
  return { ...added, release: { id, name } };
}
