"use strict";

/**
 * Per-page proxy enforcement.
 *
 * Проблема, которую решаем: приложение — SPA с одного origin (localhost), поэтому
 * Chromium/`webRequest` не может понять, какая страница инициировала запрос. Значит
 * «пускать трафик страницы через прокси или напрямую» решается ТОЛЬКО на бэкенде.
 *
 * Механика:
 *  - клиент шлёт заголовок `X-App-Page: <id>` (см. src/api/client.ts pageHeaders);
 *  - middleware кладёт в req.appPage / req.proxy / req.proxyUrl;
 *  - сервисы внешней сети (yt-dlp, LLM-провайдеры) берут прокси из этого решения.
 *
 * Правило хранится в таблице proxy_page_rules (proxy_page_rules.is_proxied):
 *   1  — страница проксируется (по умолчанию, если правила нет),
 *   0  — страница ходит напрямую (bypass), даже когда прокси включён.
 *
 * Порядок выбора движка (защита от регресса): активное ядро sing-box → legacy
 * прокси (server/proxy.js) → напрямую. Два движка не могут делить порт 10808,
 * поэтому startCore()/startProxy() останавливают друг друга.
 */

const { AsyncLocalStorage } = require("async_hooks");
const { stmts } = require("../db");
const proxyCore = require("../proxyCore");
const legacyProxy = require("../proxy");

const PAGE_HEADER = "x-app-page";
const SOCKS_HOST = "127.0.0.1";

// Контекст страницы для кода, у которого нет доступа к req (LLM-провайдеры).
const als = new AsyncLocalStorage();

/** Санитайз id страницы: только [a-z0-9_-], ≤32 символов. */
function normalizePage(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  if (!s) return "";
  return s.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

/**
 * ЧИСТАЯ логика решения. → "direct" | "core" | "legacy".
 *  - rule: true/false/0/1 или null/undefined (правила нет → считаем проксируемой);
 *  - coreActive / legacyActive: активно ли соответствующее ядро.
 */
function decidePageProxy(rule, coreActive, legacyActive) {
  const proxied = rule === null || rule === undefined ? true : !!rule;
  if (!proxied) return "direct"; // явный bypass страницы
  if (coreActive) return "core"; // приоритет — встроенное ядро sing-box
  if (legacyActive) return "legacy"; // фолбэк на старый VLESS-прокси
  return "direct"; // проксировать некуда — идём напрямую
}

/** Решение для страницы + готовые URL прокси (или null). */
function resolveProxyForPage(page) {
  const id = normalizePage(page);
  const rule = id ? stmts.pprIsProxied.get(id) : null;
  const core = proxyCore.getCoreStatus();
  const coreActive = !!(core.enabled && core.running);
  const legacyUrl = legacyProxy.getProxyUrl();
  const decision = decidePageProxy(rule, coreActive, !!legacyUrl);

  if (decision === "core") {
    return {
      proxied: true,
      source: "core",
      proxyUrl: `socks5://${SOCKS_HOST}:${core.socksPort}`,
      httpProxyUrl: `http://${SOCKS_HOST}:${core.httpPort}`,
    };
  }
  if (decision === "legacy") {
    return { proxied: true, source: "legacy", proxyUrl: legacyUrl, httpProxyUrl: null };
  }
  return { proxied: false, source: "direct", proxyUrl: null, httpProxyUrl: null };
}

/** URL SOCKS5-прокси для страницы (для yt-dlp `--proxy`) или null. */
function proxyUrlForPage(page) {
  return resolveProxyForPage(page).proxyUrl;
}

/** Express-middleware: размечает запрос решением по его странице. */
function perPageProxyMiddleware(req, res, next) {
  const page = normalizePage(req.headers[PAGE_HEADER]) || "unknown";
  const decision = resolveProxyForPage(page);
  req.appPage = page;
  req.proxy = decision;
  req.proxyUrl = decision.proxyUrl;
  next();
}

/* ----------------------- Контекст страницы (ALS) ------------------------- */

/** Выполнить fn в контексте страницы (для провайдеров без доступа к req). */
function runWithPage(page, fn) {
  return als.run(normalizePage(page) || "unknown", fn);
}

function currentPage() {
  return als.getStore() || "unknown";
}

/* --------------------------- Клиенты внешней сети ------------------------ */

// ProxyAgent из undici кэшируем по URL (создание не бесплатно).
let undiciCache = { url: null, agent: null };

/**
 * Ленивая загрузка ProxyAgent из undici.
 *
 * ПОЧЕМУ ЭТО КРИТИЧНО И ПОЧЕМУ ТУТ ОТДЕЛЬНАЯ ФУНКЦИЯ: раньше `undici` был только
 * транзитивной зависимостью devDependency (@electron/rebuild → node-gyp → undici),
 * и в собранное приложение electron-builder его не клал (в dev-дереве он есть, в
 * app.asar — нет). Тогда `require("undici")` бросал MODULE_NOT_FOUND, catch
 * помечал прокси «сломанным» навсегда — и ВСЕ запросы страниц (TMDB, LLM,
 * форум) уходили напрямую, то есть под блокировку. Снаружи это выглядело ровно
 * как «в VS Code всё работает, а в установленном приложении страница фильмов
 * пустая и пишет network_error», хотя прокси был подключён и пинговался.
 *
 * Теперь undici объявлен в dependencies package.json (и проверяется в
 * scripts/check-pack.js), а здесь результат загрузки запоминается, и о
 * недоступности модуля пишется ОДНА понятная строка в журнал вместо серии
 * необъяснимых network_error.
 *
 * → класс ProxyAgent, либо null (модуля нет/не загрузился).
 */
let proxyAgentClass; // undefined — ещё не пробовали, null — недоступен
let undiciWarned = false;

function loadProxyAgent() {
  if (proxyAgentClass !== undefined) return proxyAgentClass;
  try {
    const mod = require("undici");
    proxyAgentClass = mod && mod.ProxyAgent ? mod.ProxyAgent : null;
  } catch {
    proxyAgentClass = null;
  }
  if (!proxyAgentClass && !undiciWarned) {
    undiciWarned = true;
    // Диагностика в журнал, а не в тишину: именно отсутствие этого модуля в
    // упакованной сборке давало «fetch failed» на всех страницах, ходящих в сеть.
    try {
      require("../logger").warn("proxy.undici_missing", {
        hint: "undici должен быть в dependencies package.json, иначе сборка ходит мимо прокси",
      });
    } catch {
      /* журнал недоступен (тесты/ранняя инициализация) — не роняем приложение */
    }
  }
  return proxyAgentClass;
}

/**
 * undici-диспетчер для нативного fetch/SDK (LLM-провайдеры, TMDB, форум).
 * undici 6 умеет только HTTP-прокси → используем HTTP-inbound ядра (10809),
 * который туннелирует https через CONNECT. null — если прокси не нужен/нет undici.
 */
function getUndiciDispatcherForPage(page) {
  const decision = resolveProxyForPage(page || currentPage());
  if (!decision.proxied || !decision.httpProxyUrl) return null;
  if (undiciCache.url === decision.httpProxyUrl && undiciCache.agent) return undiciCache.agent;
  const ProxyAgent = loadProxyAgent();
  // Модуля нет — предупреждение уже в журнале (loadProxyAgent); запрос пойдёт
  // напрямую, но это больше не «немой» сбой: причина видна в логах.
  if (!ProxyAgent) return null;
  try {
    const agent = new ProxyAgent(decision.httpProxyUrl);
    undiciCache = { url: decision.httpProxyUrl, agent };
    return agent;
  } catch {
    // Некорректный URL прокси (или сломанный агент) — ходим напрямую.
    return null;
  }
}

/** SOCKS-агент для axios/http/https-кода, инициированного страницей. */
async function getAgentForPage(page) {
  const decision = resolveProxyForPage(page || currentPage());
  if (!decision.proxied || !decision.proxyUrl) return null;
  try {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(decision.proxyUrl);
  } catch {
    return null;
  }
}

/** fetch-обёртка: добавляет dispatcher, если страница проксируется. */
function pageFetch(url, init = {}) {
  const dispatcher = getUndiciDispatcherForPage(currentPage());
  return fetch(url, dispatcher ? { ...init, dispatcher } : init);
}

module.exports = {
  PAGE_HEADER,
  normalizePage,
  decidePageProxy,
  resolveProxyForPage,
  proxyUrlForPage,
  perPageProxyMiddleware,
  runWithPage,
  currentPage,
  getUndiciDispatcherForPage,
  getAgentForPage,
  pageFetch,
};
