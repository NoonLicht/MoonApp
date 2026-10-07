/**
 * proxyCore.js — ядро встроенного прокси на базе sing-box.
 *
 * Назначение: превратить ссылку/подписку/JSON в локальный прокси-сервер, который
 * поднимает sing-box (SOCKS5 + HTTP inbound на 127.0.0.1). Никакого внешнего GUI
 * не запускается — работает только консольный движок.
 *
 * Слой разбора и генерации конфига полностью чистый (без процессов и сети), его
 * проверяет tests/proxyCore.test.ts. Жизненный цикл движка (поиск/установка/запуск)
 * повторяет проверенные приёмы server/proxy.js.
 *
 * Поддержанные протоколы: VLESS, VMess, Trojan, Hysteria2, TUIC, Shadowsocks, SSH.
 * Поддержанные входные форматы: одиночный URI, base64-подписка, список URI,
 * raw JSON/YAML → см. parseSubscription().
 */
import config from "./config";
import path from "path";
import logger from "./logger";
import fs from "fs";
import { spawn, execFileSync } from "child_process";
import { parseUri } from "./proxyUri";
import { detectEngine } from "./proxyEngine";
import { buildSingBoxConfig, isNodeSupported } from "./proxyConfig";
import { isPortOpen, sleep, waitCoreReady, waitPortFree } from "./proxyProbe";
export { SUPPORTED_PROTOCOLS, parseUri, parseSubscription } from "./proxyUri";
export {
  buildOutbound,
  buildSingBoxConfig,
  isNodeSupported,
  SUPPORTED_TRANSPORTS,
  nodeFromJsonOutbound,
  nodeFromXrayOutbound,
  nodeFromSingBoxOutbound,
} from "./proxyConfig";
export { detectEngine, installEngine, installStatus } from "./proxyEngine";
export {
  testLatency,
  classifyLatency,
  requestThroughProxy,
  requestThroughProxyOn,
  fetchText,
  pingNode,
  PING_SOCKS_PORT,
  PING_HTTP_PORT,
  PING_TARGETS,
  PING_DEFAULT_TIMEOUT,
  isPortOpen,
  canConnectTo,
} from "./proxyProbe";

const { DIRS } = config;

// --- Константы движка ---

const ENGINE_ID = "sing-box";
const ENGINE_VER = "1.11.0";
// Держать в синхроне со scripts/fetch-engines.js (SB_VER).
const ENGINE_URL = `https://github.com/SagerNet/sing-box/releases/download/v${ENGINE_VER}/sing-box-${ENGINE_VER}-windows-amd64.zip`;

const DEFAULT_SOCKS_PORT = 10808;
const DEFAULT_HTTP_PORT = 10809;
export const PROXY_HOST = "127.0.0.1";

// Пользовательский каталог движка (вне asar), вендор-комплект инсталлятора и
// extraResources-пути `resources/bin/proxy-core/`, `resources/bin/singbox/`.
// На Linux/macOS движок без .exe: config.binName/config.vendorBin сами
// подбирают правильное расширение и подпапку (vendor/<engine>/linux/sing-box
// на не-Windows — эту сборку нужно положить туда вручную перед первой Linux-сборкой).
const SINGBOX_BIN_NAME = config.binName("sing-box");
export const CORE_DIR = path.join(DIRS.storage, "proxyCore");
export const BUNDLED_BIN = path.join(CORE_DIR, SINGBOX_BIN_NAME);
export const VENDOR_BIN = config.vendorBin("proxy-core", "sing-box");
// Легаси-точки: sing-box из комплекта инсталлятора (его кладёт
// scripts/fetch-engines.js) и то, что успела скачать старая панель «Прокси».
// Ядро ОБЯЗАНО их видеть: иначе на свежей сборке UI пишет «движок не найден»
// при том, что sing-box физически лежит рядом.
export const VENDOR_LEGACY_BIN = config.vendorBin("singbox", "sing-box");
export const BUNDLED_LEGACY_BIN = path.join(DIRS.storage, "singbox", SINGBOX_BIN_NAME);

/** Кандидаты из resources/ (собранный Electron-инсталлятор). */
export function resourcesBins() {
  const out = [];
  try {
    if (process.resourcesPath) {
      out.push(path.join(process.resourcesPath, "bin", "proxy-core", SINGBOX_BIN_NAME));
      out.push(path.join(process.resourcesPath, "bin", "singbox", SINGBOX_BIN_NAME));
      out.push(path.join(process.resourcesPath, "singbox", SINGBOX_BIN_NAME));
    }
  } catch {
    /* не Electron — resourcesPath отсутствует */
  }
  return out;
}

// --- Запуск / остановка процесса ---

// Единственный активный процесс ядра. Состояние намеренно не персистится:
// после рестарта приложения прокси всегда выключен.
export let CORE: Record<string, any> = {
  running: false,
  enabled: false,
  child: null,
  node: null,
  socksPort: DEFAULT_SOCKS_PORT,
  httpPort: DEFAULT_HTTP_PORT,
  socksReady: false,
  httpReady: false,
  error: "",
  childPid: null,
};

/** Текущее состояние ядра (для API/UI). */
function getCoreStatus() {
  return {
    running: CORE.running,
    enabled: CORE.enabled,
    error: CORE.error,
    socksPort: CORE.socksPort,
    httpPort: CORE.httpPort,
    // Раздельная готовность: SOCKS нужен yt-dlp/агенту, HTTP — TMDB/LLM/fetch.
    // running=true означает "готовы оба", но UI может показать точнее, что
    // именно сломалось, если когда-нибудь один из портов не поднимется.
    socksReady: CORE.socksReady,
    httpReady: CORE.httpReady,
    node: CORE.node
      ? {
          protocol: CORE.node.protocol,
          tag: CORE.node.tag,
          server: CORE.node.server,
          port: CORE.node.port,
        }
      : null,
    childPid: CORE.childPid,
  };
}

/** socks5://127.0.0.1:PORT если ядро активно, иначе null (для yt-dlp/agent). */
function getCoreProxyUrl() {
  if (!CORE.running || !CORE.enabled) return null;
  return `socks5://${PROXY_HOST}:${CORE.socksPort}`;
}

/** http://127.0.0.1:PORT если ядро активно, иначе null (для Node fetch/Chromium). */
function getCoreHttpProxyUrl() {
  if (!CORE.running || !CORE.enabled) return null;
  return `http://${PROXY_HOST}:${CORE.httpPort}`;
}

/**
 * Остановить ядро.
 *
 * Дожидаемся РЕАЛЬНОГО выхода процесса: `child.kill()` без ожидания оставлял
 * sing-box висеть и держать порт 10808 — следующее включение прокси падало
 * молча (в UI это выглядело как «включил, а ничего не произошло»).
 */
async function stopCore() {
  const child = CORE.child;
  CORE = { ...CORE, child: null, childPid: null, running: false, enabled: false, error: "" };
  await stopChild(child);
  clearCorePid();
  logger.info("proxyCore.stopped");
  return getCoreStatus();
}

/**
 * Запуск ядра по узлу (или по сырому входу — тогда узел разбирается первым).
 * Возвращает состояние. Готовность определяется реальной пробой, а не эвристикой
 * по stderr: pollUntilReady вызывается отдельно (см. checkCoreReady).
 */
async function startCore(input: any, opts: Record<string, any> = {}) {
  const node = typeof input === "string" ? parseUri(input) : input;
  if (!node || !node.server) {
    CORE = { ...CORE, running: false, enabled: false, error: "Invalid proxy node" };
    return getCoreStatus();
  }
  const engine = await detectEngine();
  if (!engine.found) {
    CORE = { ...CORE, running: false, enabled: false, error: "sing-box not found" };
    return getCoreStatus();
  }
  // Прибираем прошлый процесс и ждём, пока он РЕАЛЬНО умрёт: иначе новый sing-box
  // не сможет занять порты, а отказ выглядел бы как «ничего не произошло».
  const prev = CORE.child;
  CORE = { ...CORE, child: null };
  await stopChild(prev);
  // Плюс прибиваем процесс, оставшийся от прошлого запуска приложения (свой PID
  // в файле), — иначе порт занят и старт молча падал.
  killStaleCoreProcess();

  // Два движка не могут делить порты 10808/10809 — гасим legacy VLESS-прокси.
  try {
    (require("./proxy") as typeof import("./proxy")).stopProxy();
  } catch {
    /* legacy не загружен */
  }

  const cfg = buildSingBoxConfig(node, { socksPort: opts.socksPort, httpPort: opts.httpPort });
  if (!cfg) {
    // Явно различаем «протокол не наш» и «транспорт не умеет движок» (xhttp и т.п.):
    // иначе пользователь видит только непонятную ошибку соединения.
    const why = isNodeSupported(node)
      ? "Unsupported protocol: " + node.protocol
      : `unsupported_transport:${node.network || node.protocol}`;
    CORE = { ...CORE, running: false, enabled: false, error: why };
    return getCoreStatus();
  }

  const cfgDir = path.join(CORE_DIR, "configs");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, "core.json");
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e: any) {
    CORE = { ...CORE, running: false, enabled: false, error: "Config write failed: " + e.message };
    return getCoreStatus();
  }

  // Порт занят чужой программой (другой прокси, прошлый экземпляр, VPN) — это
  // надо сказать явно, иначе sing-box просто не стартует и UI молчит.
  const wantSocks = cfg.inbounds[0].listen_port;
  const wantHttp = cfg.inbounds[1].listen_port;
  await waitPortFree(wantSocks);
  if (await isPortOpen(wantSocks)) {
    CORE = { ...CORE, running: false, enabled: false, error: `port_busy:${wantSocks}` };
    return getCoreStatus();
  }
  if (await isPortOpen(wantHttp)) {
    CORE = { ...CORE, running: false, enabled: false, error: `port_busy:${wantHttp}` };
    return getCoreStatus();
  }

  const child = spawn(engine.path, ["run", "-c", cfgPath, "--disable-color"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const socksPort = cfg.inbounds[0].listen_port;
  const httpPort = cfg.inbounds[1].listen_port;
  CORE = {
    running: false,
    enabled: false,
    child,
    node,
    socksPort,
    httpPort,
    error: "",
    childPid: child.pid,
  };

  // Логи копим только для диагностики ошибок: sing-box при warn-уровне молчит,
  // поэтому по ним НЕЛЬЗЯ судить об успехе (в старой версии строка про
  // "inbound ... bind: address already in use" принималась за успешный старт).
  let logTail = "";
  const collect = (d: any) => {
    logTail = (logTail + d.toString()).slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (e) => {
    if (CORE.child === child) CORE = { ...CORE, running: false, enabled: false, error: e.message };
  });
  child.on("close", (code) => {
    if (CORE.child !== child) return; // процесс заменён другим запуском/остановкой
    CORE = {
      ...CORE,
      running: false,
      enabled: false,
      child: null,
      childPid: null,
      error: CORE.error || logTail.trim().slice(-300) || `sing-box exited with code ${code}`,
    };
    clearCorePid();
  });

  logger.info("proxyCore.start", { protocol: node.protocol, pid: child.pid });
  writeCorePid(child.pid);

  // Ждём реального старта ОБОИХ inbound'ов, чтобы ответ API отражал правду,
  // а не «спавнится» и не «только SOCKS поднялся».
  const ready = await waitCoreReady(child, socksPort, httpPort, 8000);
  if (ready.ok) {
    CORE = { ...CORE, running: true, enabled: true, error: "", socksReady: true, httpReady: true };
    logger.info("proxyCore.ready", { pid: child.pid, socksPort, httpPort, ms: 0 });
  } else if (CORE.child === child) {
    CORE = {
      ...CORE,
      running: false,
      enabled: false,
      socksReady: ready.socksReady,
      httpReady: ready.httpReady,
      error:
        ready.reason === "exited"
          ? logTail.trim().slice(-300) || `sing-box exited with code ${child.exitCode}`
          : !ready.httpReady && ready.socksReady
            ? "core_http_inbound_timeout"
            : "core_start_timeout",
    };
    if (child.exitCode == null) await stopChild(child);
    logger.warn("proxyCore.notReady", { reason: ready.reason, log: logTail.slice(-300) });
  }
  return getCoreStatus();
}

// --- Реальный пинг через локальный SOCKS5 (TTFB) ---

// socks-proxy-agent — ESM, грузим динамически (как в server/proxy.js).
export async function getSocksAgent() {
  const mod = await import("socks-proxy-agent");
  return mod.SocksProxyAgent;
}

/**
 * Ждём открытия SOCKS-порта временного ядра (TCP-connect, без трафика).
 * Выходим сразу, если процесс упал — иначе висели бы весь таймаут.
 */
export async function waitPortReady(port: any, childState: any, timeoutMs: any) {
  const net = require("net") as typeof import("net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = childState();
    if (st.spawnErr) return { ok: false, error: st.spawnErr };
    if (st.exitCode != null) return { ok: false, error: `core_exited_${st.exitCode}` };
    const connected = await new Promise<any>((resolve) => {
      const sock = net.connect({ host: PROXY_HOST, port });
      const done = (v: any) => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      };
      sock.setTimeout(400, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
    if (connected) return { ok: true, error: "" };
    await sleep(120);
  }
  return { ok: false, error: "core_not_started" };
}

/** Погасить временный процесс и ДОЖДАТЬСЯ выхода (иначе порт останется занят). */
async function stopChild(child: any) {
  if (!child || child.exitCode != null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        resolve();
      }
    };
    const t = setTimeout(done, 1200);
    child.once("close", done);
    try {
      child.kill();
    } catch {
      done();
    }
  });
  // Не вышел за отведённое время — добиваем принудительно, иначе процесс
  // останется висеть и займёт SOCKS-порт для следующего узла.
  if (child.exitCode == null) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* ignore */
    }
    await sleep(200);
  }
}

// --- Защита от «зависшего» ядра прошлого запуска ---
// Если приложение упало/было убито, sing-box мог остаться жить и держать порт.
// Тогда следующее включение прокси молча не работало. Свой PID пишем в файл,
// чтобы при следующем старте прибить ИМЕННО свой (чужой sing-box не трогаем).
const CORE_PID_FILE = path.join(CORE_DIR, "core.pid");

function writeCorePid(pid: any) {
  try {
    fs.writeFileSync(CORE_PID_FILE, String(pid), "utf8");
  } catch {
    /* не критично */
  }
}
function clearCorePid() {
  try {
    fs.rmSync(CORE_PID_FILE, { force: true });
  } catch {
    /* уже удалён */
  }
}

/** Прибить осиротевший процесс ядра от прошлого запуска приложения. */
function killStaleCoreProcess() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(CORE_PID_FILE, "utf8").trim());
  } catch {
    /* файла нет — процесса тоже */
  }
  if (pid > 0) {
    try {
      process.kill(pid, 0); // процесс ещё жив?
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      logger.warn("proxyCore.stale.killed", { pid });
    } catch {
      /* процесса уже нет — это норма */
    }
  }
  clearCorePid();
}
export {
  ENGINE_ID,
  ENGINE_VER,
  ENGINE_URL,
  DEFAULT_SOCKS_PORT,
  DEFAULT_HTTP_PORT,
  startCore,
  stopCore,
  getCoreStatus,
  getCoreProxyUrl,
  getCoreHttpProxyUrl,
  stopChild,
};
