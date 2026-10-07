/**
 * Выделено из proxyCore.ts при разбиении крупного файла (поведение не менялось).
 */
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { CORE, CORE_DIR, PROXY_HOST, getSocksAgent, stopChild, waitPortReady } from "./proxyCore";
import { detectEngine } from "./proxyEngine";
import { buildSingBoxConfig, isNodeSupported } from "./proxyConfig";

const LATENCY_TARGETS = [
  { url: "https://www.google.com/generate_204", expect: 204 },
  { url: "https://cp.cloudflare.com/generate_204", expect: 204 },
];
const IPINFO_URL = "https://ipinfo.io/json";

/**
 * GET строго через SOCKS5-порт (TTFB). Замеряем время до первого байта ответа
 * (момент прихода заголовков). Никаких TCP-хендшейков «на глаз».
 * Порт параметризован: пинг узлов поднимает временное ядро на своём порту и не
 * должен трогать активный прокси.
 */
export async function requestThroughProxyOn(
  socksPort: any,
  url: any,
  opts: Record<string, any> = {},
) {
  const Agent = await getSocksAgent();
  const agent = new Agent(`socks5://${PROXY_HOST}:${socksPort}`);
  const u = new URL(url);
  const mod =
    u.protocol === "https:"
      ? (require("https") as typeof import("https"))
      : (require("http") as typeof import("http"));
  return new Promise<any>((resolve) => {
    const started = Date.now();
    const limitMs = opts.timeout || 3000;
    let done = false;
    let hard: any = null;
    let req: any = null;
    const finish: any = (r: any) => {
      if (done) return;
      done = true;
      if (hard) clearTimeout(hard);
      resolve(r);
    };
    // Жёсткий дедлайн по стенным часам. req.setTimeout() здесь НЕ спасает: он
    // взводится только на уже подключённом сокете, а во время CONNECT-туннеля
    // через SOCKS сокета ещё нет — «мёртвый» узел держал бы запрос до таймаута
    // самого sing-box (~5 с).
    hard = setTimeout(() => {
      try {
        if (req) req.destroy();
      } catch {
        /* ignore */
      }
      finish({ ok: false, status: 0, ttfbMs: null, body: "", error: "timeout" });
    }, limitMs);
    req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || { "User-Agent": "Mozilla/5.0" },
        agent,
      },
      (res: any) => {
        const ttfbMs = Date.now() - started; // заголовки пришли → это и есть TTFB
        let body = "";
        res.on("data", (c: any) => {
          body += c;
        });
        res.on("end", () =>
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            ttfbMs,
            body,
            error: "",
          }),
        );
      },
    );
    req.setTimeout(limitMs, () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      finish({ ok: false, status: 0, ttfbMs: null, body: "", error: "timeout" });
    });
    req.on("error", (e: any) =>
      finish({ ok: false, status: 0, ttfbMs: null, body: "", error: e.message }),
    );
    req.end();
  });
}

/** Запрос через активное ядро (порт берётся из его состояния). */
export function requestThroughProxy(url: any, opts = {}) {
  return requestThroughProxyOn(CORE.socksPort, url, opts);
}

// --- Пинг отдельного узла (для «пропинговать все») ---

// Отдельные порты: пинг не должен занимать порты активного прокси (10808/10809).
// Диапазоны SOCKS и HTTP НЕ пересекаются, а между пингами порты ротируются:
// иначе «залипший» слушатель от прошлого узла заставил бы измерить следующий узел
// через чужое ядро (результаты пинга тогда не соответствуют узлам).
export const PING_SOCKS_PORT = 10818;
export const PING_HTTP_PORT = 10918;
const PING_PORT_POOL = 16;
let pingPortCursor = 0;

/** Свободная пара портов для временного ядра (ротация + пропуск занятых). */
async function pickPingPorts() {
  for (let i = 0; i < PING_PORT_POOL; i++) {
    const idx = (pingPortCursor + i) % PING_PORT_POOL;
    const socksPort = PING_SOCKS_PORT + idx;
    const httpPort = PING_HTTP_PORT + idx;
    if (!(await isPortOpen(socksPort)) && !(await isPortOpen(httpPort))) {
      pingPortCursor = (idx + 1) % PING_PORT_POOL;
      return { socksPort, httpPort };
    }
  }
  // Всё занято — берём следующую по кругу: попробовать лучше, чем не пинговать.
  const socksPort = PING_SOCKS_PORT + pingPortCursor;
  const httpPort = PING_HTTP_PORT + pingPortCursor;
  pingPortCursor = (pingPortCursor + 1) % PING_PORT_POOL;
  return { socksPort, httpPort };
}

export const sleep = (ms: any) => new Promise<any>((r) => setTimeout(r, ms));

/**
 * Цели для пинга. Их НЕСКОЛЬКО намеренно: часть рабочих узлов не ходит в Google
 * (география/DNS/фильтры), и единственная цель давала ложные «блок».
 */
export const PING_TARGETS = [
  "https://www.google.com/generate_204",
  "https://cp.cloudflare.com/generate_204",
  "https://www.gstatic.com/generate_204",
];

/** Стандартный бюджет одного узла: ОДИН запрос на 2.5 с ловил только ближние
 *  узлы (первое подключение через свежее ядро = DNS + TCP + TLS + reality). */
export const PING_DEFAULT_TIMEOUT = 6000;
const PING_TOTAL_BUDGET = 15000;

/** Открыт ли TCP-порт (по умолчанию — локальный хост). */
export function isPortOpen(port: any, timeoutMs = 400, host = PROXY_HOST) {
  return new Promise<any>((resolve) => {
    const net = require("net") as typeof import("net");
    const sock = net.connect({ host, port });
    const done = (v: any) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Быстрая проверка доступности сервера узла (TCP). Ложное «нет» исключено:
 *  если TCP до узла не открывается, sing-box тоже не подключится. */
export function canConnectTo(host: any, port: any, timeoutMs = 2500) {
  return isPortOpen(Number(port), timeoutMs, host);
}

/**
 * Ждём готовности ядра: пока не откроются ОБА порта — SOCKS и HTTP.
 *
 * Почему не по логам: при `log.level = "warn"` sing-box не пишет вообще ничего,
 * поэтому определять запуск по тексту stderr нельзя — именно из-за этого ядро
 * работало, а приложение показывало «ничего не произошло». Открытый порт —
 * объективный признак, он же снимает путаницу «ошибка поиска inbound» = «старт».
 *
 * Раньше проверялся только SOCKS-порт: если HTTP-inbound не поднимался (гонка
 * порта, второй листенер заблокирован антивирусом и т.п.), UI всё равно
 * показывал «прокси подключён», а TMDB и другие HTTP-запросы (они идут через
 * HTTP-inbound, см. middleware/perPageProxy.js) реально шли в обход прокси —
 * отсюда «прокси вроде подключён, но страница фильмов не работает».
 */
export async function waitCoreReady(child: any, socksPort: any, httpPort: any, timeoutMs: any) {
  const deadline = Date.now() + timeoutMs;
  let socksReady = false;
  let httpReady = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ok: false, reason: "exited", socksReady, httpReady };
    if (!socksReady) socksReady = await isPortOpen(socksPort);
    if (!httpReady) httpReady = await isPortOpen(httpPort);
    if (socksReady && httpReady) return { ok: true, reason: "", socksReady, httpReady };
    await sleep(100);
  }
  return { ok: false, reason: "timeout", socksReady, httpReady };
}

/** Дождаться освобождения порта (после гашения прошлого процесса). */
export async function waitPortFree(port: any, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(100);
  }
  return !(await isPortOpen(port));
}

/** Диагностика фаз пинга (включается MOONAPP_PING_DEBUG=1). */
function pingDebug(label: any, extra: any) {
  if (process.env.MOONAPP_PING_DEBUG) {
    try {
      console.error(`[pingNode] ${label}${extra ? " " + JSON.stringify(extra) : ""}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Реальный пинг ОДНОГО узла: поднимаем временное ядро на свободных портах,
 * ждём первый успешный TTFB (это и есть задержка канала) и гасим его.
 *
 * Активное ядро не трогаем вообще — иначе «пропинговать все» рвало бы текущее
 * соединение пользователя.
 */
export async function pingNode(node: any, opts: Record<string, any> = {}) {
  const timeout = Number(opts.timeout) || PING_DEFAULT_TIMEOUT;
  const tcpCheck = opts.tcpCheck !== false;
  // Порты по умолчанию подбираются динамически (ротация + пропуск занятых).
  const ports =
    opts.socksPort != null && opts.httpPort != null
      ? { socksPort: opts.socksPort, httpPort: opts.httpPort }
      : await pickPingPorts();
  const { socksPort, httpPort } = ports;
  const tStart = Date.now();

  // Быстрый фильтр: если TCP до сервера узла не открывается, sing-box всё равно
  // не подключится. Не тратим секунды на запуск (и даже на поиск) движка ради
  // заведомо мёртвого узла — поэтому эта проверка идёт ДО detectEngine().
  if (tcpCheck) {
    const up = await canConnectTo(node.server, node.port, Math.min(2500, timeout));
    pingDebug("tcp", { ms: Date.now() - tStart, up });
    if (!up)
      return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "unreachable" };
  }

  const engine = await detectEngine();
  if (!engine.found)
    return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "engine_missing" };
  pingDebug("engine", { ms: Date.now() - tStart, path: engine.path });

  // Транспорт, который движок не умеет (xhttp/kcp) — сразу честная причина,
  // а не «timeout» после запуска ядра.
  if (!isNodeSupported(node)) {
    return {
      ok: false,
      state: "blocked",
      ttfbMs: null,
      country: null,
      error: `unsupported_transport:${node.network || node.protocol}`,
    };
  }

  const cfg = buildSingBoxConfig(node, { socksPort, httpPort });
  if (!cfg)
    return {
      ok: false,
      state: "blocked",
      ttfbMs: null,
      country: null,
      error: "unsupported_protocol",
    };

  const cfgDir = path.join(CORE_DIR, "configs");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, `ping-${process.pid}-${Date.now().toString(36)}.json`);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e: any) {
    return {
      ok: false,
      state: "blocked",
      ttfbMs: null,
      country: null,
      error: "config_write_failed: " + e.message,
    };
  }

  let child: any = null;
  try {
    child = spawn(engine.path, ["run", "-c", cfgPath, "--disable-color"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnErr = "";
    child.on("error", (e: any) => {
      spawnErr = e.message;
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});

    // Фаза 1: ждём, пока ядро откроет SOCKS-порт. Это дешёвый TCP-коннект, а не
    // проба через прокси: иначе «мёртвый» узел заставлял бы ждать полный таймаут.
    const ready: any = await waitPortReady(
      socksPort,
      () => ({ spawned: child != null, exitCode: child.exitCode, spawnErr }),
      5000,
    );
    pingDebug("ready", { ms: Date.now() - tStart, ok: ready.ok, error: ready.error });
    if (!ready.ok) {
      return { ok: false, state: "blocked", ttfbMs: null, country: null, error: ready.error };
    }

    // Фаза 2: замер. Перебираем цели и делаем повторы: первое подключение через
    // только что поднятое ядро часто не успевает (DNS + TCP + TLS/REALITY), а
    // одиночная попытка на 2.5 с отбрасывала рабочие дальние узлы.
    const targets =
      Array.isArray(opts.targets) && opts.targets.length ? opts.targets : PING_TARGETS;
    const deadline = Date.now() + PING_TOTAL_BUDGET;
    let lastErr = "timeout";
    for (const target of targets) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await requestThroughProxyOn(socksPort, target, { timeout });
        pingDebug("ttfb", {
          ms: Date.now() - tStart,
          target,
          attempt,
          ok: r.ok,
          status: r.status,
          error: r.error,
          ttfbMs: r.ttfbMs,
        });
        if (r.ok && r.status < 400) {
          const state = classifyLatency(true, r.ttfbMs);
          return {
            ok: true,
            state,
            ttfbMs: r.ttfbMs,
            country: await bestEffortCountry(socksPort),
            error: "",
          };
        }
        lastErr = r.error || `HTTP ${r.status}`;
        if (Date.now() > deadline)
          return { ok: false, state: "blocked", ttfbMs: null, country: null, error: lastErr };
        await sleep(250);
      }
    }
    return { ok: false, state: "blocked", ttfbMs: null, country: null, error: lastErr };
  } finally {
    const tStop = Date.now();
    await stopChild(child);
    pingDebug("stopped", { ms: Date.now() - tStop, totalMs: Date.now() - tStart });
    try {
      fs.rmSync(cfgPath, { force: true });
    } catch {
      /* уже удалён */
    }
  }
}

/** Страна выхода — best-effort: не влияет на результат пинга. */
async function bestEffortCountry(socksPort: any) {
  try {
    const info = await requestThroughProxyOn(socksPort, IPINFO_URL, { timeout: 2000 });
    if (info.ok && info.body) return JSON.parse(info.body).country || null;
  } catch {
    /* страна необязательна */
  }
  return null;
}

/** Классификация: online (<300ms) | degraded (>300ms) | blocked (ошибка/таймаут). */
export function classifyLatency(ok: any, ttfbMs: any) {
  if (!ok || ttfbMs == null) return "blocked";
  return ttfbMs <= 300 ? "online" : "degraded";
}

/**
 * Полная проверка активного ядра: реальные HTTP-запросы через SOCKS5,
 * TTFB, классификация и фактический выходной IP/страна/ISP через ipinfo.io.
 */
export async function testLatency({ timeout = 3000 } = {}) {
  if (!CORE.running || !CORE.enabled) {
    return {
      state: "offline",
      error: "Not running",
      latencyMs: null,
      targets: [],
      ip: null,
      country: null,
      isp: null,
    };
  }
  const results = [];
  let best = null;
  for (const t of LATENCY_TARGETS) {
    const r = await requestThroughProxy(t.url, { timeout });
    const state = classifyLatency(r.ok && (t.expect ? r.status === t.expect : true), r.ttfbMs);
    results.push({ url: t.url, state, status: r.status, ttfbMs: r.ttfbMs, error: r.error });
    if (state !== "blocked" && (best == null || r.ttfbMs < best)) best = r.ttfbMs;
  }
  let ip = null,
    country = null,
    isp = null;
  try {
    const info = await requestThroughProxy(IPINFO_URL, { timeout });
    if (info.ok && info.body) {
      const d = JSON.parse(info.body);
      ip = d.ip || null;
      country = d.country || null;
      isp = d.org || null;
      results.push({
        url: IPINFO_URL,
        state: classifyLatency(true, info.ttfbMs),
        status: info.status,
        ttfbMs: info.ttfbMs,
        error: "",
      });
    }
  } catch {
    /* ipinfo не обязателен */
  }

  const state = best == null ? "blocked" : best <= 300 ? "online" : "degraded";
  const node = CORE.node;
  if (node) node.country = country;
  return { state, latencyMs: best, targets: results, ip, country, isp };
}

/** GET текста: через ядро, если оно активно, иначе напрямую. Нужен для подписок. */
export async function fetchText(url: any, { timeout = 15000 } = {}) {
  if (CORE.running && CORE.enabled) {
    const r = await requestThroughProxy(url, { timeout, headers: { "User-Agent": "MoonApp" } });
    if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
    return r.body;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "MoonApp" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
