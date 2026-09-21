import { spawn, execFile } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
// Тип тянется из ESM-пакета в CommonJS-файл, поэтому нужен resolution-mode.
import type { SocksProxyAgent } from "socks-proxy-agent" with { "resolution-mode": "import" };
import config from "./config";
import settings from "./settings";
import logger from "./logger";

const { DIRS } = config;

/** Части VLESS-ноды: адрес, порт и параметры (`?security=reality&sni=…`). */
export interface VlessParts {
  uuid: string;
  server: string;
  port: number;
  params: Record<string, string>;
}

/** Разобранный профиль: одиночная нода либо полный конфиг sing-box. */
export type ParsedProfile =
  { type: "node"; parts: VlessParts } | { type: "full"; cfg: Record<string, unknown> };

/** Результат поиска бинарника sing-box. */
export interface SbDetection {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** Состояние установки sing-box (панель показывает прогресс и фазу). */
export interface InstallState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
}

/** Состояние установки + признак «бинарник уже на диске». */
export interface InstallStatus extends InstallState {
  installed: boolean;
}

/** Статус прокси для UI (getStatus). */
export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  pingMs: number | null;
  country: string | null;
  error: string;
  vlessLink: string;
  validLink: boolean;
  installed: boolean;
  singBoxVersion: string | null;
  childPid: number | null;
}

/** Ответ socksFetch: fetch-подобный, но без dispatcher (любой http.Agent). */
export interface SocksResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Опции socksFetch: подмножество fetch, которое реально используется. */
interface SocksOpts {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  body?: string | Buffer;
}

/** Сохранённый VLESS-профиль (список в настройках прокси). */
export interface SavedVless {
  id: string;
  link: string;
  name: string;
  updatedAt: string;
}

/** Что модуль читает из настроек прокси (значения приводит сам). */
interface ProxyConfig {
  vlessLink?: unknown;
  savedVless?: SavedVless[];
}

/** Полный конфиг sing-box из буфера: поля читаем и чистим по имени. */
interface SbConfigObject {
  hosts?: unknown;
  dns?: SbConfigObject;
  experimental?: SbConfigObject;
  [key: string]: unknown;
}

/**
 * Нода из JSON (диалекты Xray/sing-box): имена полей у них различаются
 * (uuid/user.uuid, server/address/host, port/server_port), поэтому все значения
 * приходят unknown и приводятся к строке по месту.
 */
interface SbNodeObject {
  uuid?: unknown;
  user?: { uuid?: unknown } | null;
  server?: unknown;
  address?: unknown;
  host?: unknown;
  port?: unknown;
  server_port?: unknown;
  flow?: unknown;
  network?: unknown;
  packet_encoding?: unknown;
  tls?: {
    reality?: { public_key?: unknown; short_id?: unknown } | null;
    enabled?: unknown;
    server_name?: unknown;
    utls?: { fingerprint?: unknown } | null;
  } | null;
}

/** Живое состояние прокси (в него пишут обработчики процесса sing-box). */
interface ProxyState {
  enabled: boolean;
  port: number;
  running: boolean;
  child: ChildProcess | null;
  pingMs: number | null;
  country: string | null;
  error: string;
}

/** Сервис определения страны по внешнему IP (PING_SERVICES). */
interface PingService {
  url: string;
  /** Достаёт название страны из ответа: форма у каждого сервиса своя. */
  pick: (d: Record<string, unknown>) => unknown;
}

// socks-proxy-agent — ESM, загружается динамически
async function getSocksAgent(): Promise<typeof SocksProxyAgent> {
  const mod = await import("socks-proxy-agent");
  return mod.SocksProxyAgent;
}

// --- Константы ---

const BIN_DIR = path.join(DIRS.storage, "singbox");
const BUNDLED_BIN = path.join(BIN_DIR, "sing-box.exe");
// Бинарь из комплекта инсталлятора: server/vendor/singbox/sing-box.exe
// (в собранной сборке — app.asar.unpacked, см. build.asarUnpack).
const VENDOR_BIN = config.vendorPath("singbox", "sing-box.exe");
const SB_VER = "1.11.0";
const SB_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box-${SB_VER}-windows-amd64.zip`;
const DEF_PORT = 10808;
let PS: ProxyState = {
  enabled: false,
  port: DEF_PORT,
  running: false,
  child: null,
  pingMs: null,
  country: null,
  error: "",
};

// --- Парсинг VLESS-ссылки ---

function parseVlessLink(link: unknown): VlessParts | null {
  try {
    const s = String(link || "").trim();
    if (!s.startsWith("vless://")) return null;
    const a = s.slice(8);
    const [ui, ...rr] = a.split("@");
    if (!ui || !rr.length) return null;
    const uuid = decodeURIComponent(ui);
    const hpq = rr.join("@");
    // #fragment (имя/флаг) отрезается, чтобы он не просочился в параметры
    const [hp, rest] = hpq.split("?");
    const qs = rest ? rest.split("#")[0] : "";
    const [sv, ps] = hp.split(":");
    const port = parseInt(ps, 10);
    if (!uuid || !sv || !port) return null;
    const p: Record<string, string> = {};
    if (qs)
      for (const pair of qs.split("&")) {
        const [k, v] = pair.split("=");
        if (k) p[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
      }
    return { uuid, server: sv, port, params: p };
  } catch {
    return null;
  }
}
// --- Профили: ссылка ИЛИ JSON, скопированный из буфера ---

/** Из JSON-ноды sing-box (server/server_port/uuid/tls/reality) достаются части.
    → { uuid, server, port, params } или null. */
function jsonNodeToParts(o: unknown): VlessParts | null {
  if (!o || typeof o !== "object") return null;
  const n = o as SbNodeObject;
  const uuid = n.uuid || (n.user && n.user.uuid);
  const server = n.server || n.address || n.host;
  const port =
    n.port !== undefined
      ? Number(n.port)
      : n.server_port !== undefined
        ? Number(n.server_port)
        : NaN;
  if (!uuid || !server || !Number.isFinite(port)) return null;
  const params: Record<string, string> = {};
  // Значения из чужого JSON приводим к строке: sing-box ждёт строки, а
  // «числовой flow» упал бы позже на .startsWith() внутри buildSBConfig.
  if (n.flow) params.flow = String(n.flow);
  if (n.network) params.network = String(n.network);
  if (n.packet_encoding) params.packetEncoding = String(n.packet_encoding);
  const tls = n.tls;
  if (tls && typeof tls === "object") {
    if (tls.reality) {
      params.security = "reality";
      if (tls.reality.public_key) params.pbk = String(tls.reality.public_key);
      if (tls.reality.short_id) params.sid = String(tls.reality.short_id);
    } else if (tls.enabled === false) {
      params.security = "none";
    } else {
      params.security = "tls";
    }
    if (tls.server_name) params.sni = String(tls.server_name);
    if (tls.utls && tls.utls.fingerprint) params.fp = String(tls.utls.fingerprint);
  }
  return { uuid: String(uuid), server: String(server), port, params };
}

/**
 * Разбор профиля: vless://-ссылка ИЛИ JSON из буфера.
 * Поддерживается: полный конфиг sing-box (с outbounds[]) и одиночная нода.
 * → null | { type:"node", parts:{uuid,server,port,params} } | { type:"full", cfg:<конфиг> }
 */
function parseProfile(raw: unknown): ParsedProfile | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    let o: SbConfigObject;
    try {
      o = JSON.parse(s) as SbConfigObject;
    } catch {
      return null;
    }
    if (Array.isArray(o.outbounds)) return { type: "full", cfg: o };
    const parts = jsonNodeToParts(o);
    if (parts) return { type: "node", parts };
    return null;
  }
  const parts = parseVlessLink(s);
  if (parts) return { type: "node", parts };
  return null;
}

function inputIsValid(profile: unknown): boolean {
  return !!parseProfile(profile);
}

/** Гарантия, что в конфиге пользователя есть socks-инбаунд. */
function ensureSocks(
  cfg: Record<string, unknown> | null | undefined,
  port: number,
): Record<string, unknown> | null | undefined {
  if (!cfg || typeof cfg !== "object") return cfg;
  // Массив приводим к типу явно: Array.isArray сужает только на одну строку,
  // а inbounds нужен и в проверке, и в push ниже.
  const inbounds = Array.isArray(cfg.inbounds) ? (cfg.inbounds as Record<string, unknown>[]) : [];
  cfg.inbounds = inbounds;
  if (!inbounds.some((i) => i && i.type === "socks")) {
    inbounds.push({ type: "socks", tag: "socks-in", listen: "127.0.0.1", listen_port: port });
  }
  if (!Array.isArray(cfg.outbounds)) cfg.outbounds = [{ type: "direct", tag: "direct" }];
  if (!cfg.route)
    cfg.route = {
      auto_detect_interface: true,
      rules: [{ outbound: "direct", ip_is_private: true }],
    };
  return cfg;
}

/** Имя профиля, под которым он сохраняется (из ссылки или JSON). */
function profileName(raw: unknown): string {
  const r = String(raw || "").trim();
  const prof = parseProfile(r);
  if (!prof) return "Unnamed";
  if (prof.type === "full") {
    const tag = prof.cfg?.tag;
    return tag ? String(tag) : "Profile";
  }
  const p = prof.parts.params;
  const rem = decodeURIComponent(String(p.remark || p.ps || ""));
  return rem || prof.parts.server;
}
// --- Генерация конфига ---

function buildSBConfig({
  uuid,
  server,
  port,
  params,
  proxyPort,
}: VlessParts & { proxyPort?: number }): Record<string, unknown> {
  const pPort = proxyPort || DEF_PORT;
  // sing-box умеет только xtls-rprx-vision (Reality/Vision); остальные Xray-флоу (xtls-rprx-direct/…) — нет
  const rawFlow = params.flow || "";
  const allowedFlow =
    rawFlow === "xtls-rprx-vision" ? rawFlow : rawFlow.startsWith("xtls-rprx-") ? "" : rawFlow;
  // Если flow xtls, а security не задан — TLS включается по умолчанию
  const needsTls =
    params.security === "tls" || params.security === "reality" || rawFlow.startsWith("xtls-");
  const ob: Record<string, unknown> = {
    type: "vless",
    tag: "proxy",
    server,
    server_port: port,
    uuid,
    flow: allowedFlow,
    packet_encoding: "xudp",
  };
  if (needsTls) {
    const tls: Record<string, unknown> = { enabled: true };
    if (params.fp) tls.utls = { enabled: true, fingerprint: params.fp || "chrome" };
    if (params.security === "reality" || params.pbk)
      tls.reality = { enabled: true, public_key: params.pbk || "", short_id: params.sid || "" };
    if (params.sni) tls.server_name = params.sni;
    ob.tls = tls;
  }
  return {
    log: { level: "warn", output: "" },
    inbounds: [{ type: "socks", tag: "socks-in", listen: "127.0.0.1", listen_port: pPort }],
    outbounds: [ob, { type: "direct", tag: "direct" }],
    route: { auto_detect_interface: true, rules: [{ outbound: "direct", ip_is_private: true }] },
  };
}

/**
 * Приведение пользовательского (полного) конфига sing-box к схеме той версии,
 * что реально лежит у нас (bundled sing-box 1.11.0).
 *
 * В 1.11 статический «hosts»-маппинг не поддерживается ни на верхнем уровне,
 * ни в dns (появился позже). Если оставить его — sing-box упадёт с FATAL …
 * json: unknown field "hosts". Такие поля удаляются, чтобы конфиг запарсился.
 */
function normalizeConfig(
  cfg: SbConfigObject | null | undefined,
): SbConfigObject | null | undefined {
  if (!cfg || typeof cfg !== "object") return cfg;
  const dns = cfg.dns;
  if (dns && typeof dns === "object" && "hosts" in dns) delete dns.hosts;
  if ("hosts" in cfg) delete cfg.hosts;
  // В старых конфигах попадалась deprecated-обёртка experimental.dns -> dns
  if (
    !cfg.dns &&
    cfg.experimental &&
    typeof cfg.experimental === "object" &&
    cfg.experimental.dns
  ) {
    cfg.dns = cfg.experimental.dns;
    delete cfg.experimental.dns;
    if (Object.keys(cfg.experimental).length === 0) delete cfg.experimental;
  }
  return cfg;
}

// --- Детекция sing-box ---

let dc: SbDetection | null = null,
  da = 0;
function sbCand(): string[] {
  return [BUNDLED_BIN, VENDOR_BIN, "sing-box"];
}
function runSBVer(b: string): Promise<string | null> {
  return new Promise<string | null>((r) => {
    execFile(
      b,
      ["version"],
      { timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024 },
      (e, o) => {
        r(e ? null : String(o || "").split(/[\r\n]+/)[0] || "unknown");
      },
    );
  });
}
async function detectSB(): Promise<SbDetection> {
  const n = Date.now();
  if (dc && n - da < 12000) return dc;
  let res: SbDetection = { found: false, path: null, version: null };
  for (const c of sbCand()) {
    if (c.includes("/") || c.includes("\\")) {
      if (!fs.existsSync(c)) continue;
    }
    const v = await runSBVer(c);
    if (v) {
      res = { found: true, path: c, version: v };
      break;
    }
  }
  dc = res;
  da = n;
  return res;
}

// --- Статус / сохранение ---

function getStatus(): ProxyStatus {
  const cfg = (settings.get("proxy") || {}) as ProxyConfig;
  const vl = String(cfg.vlessLink || "").trim();
  const parsed = vl ? inputIsValid(vl) : false;
  const det = dc || { found: false, path: null, version: null };
  return {
    enabled: PS.enabled,
    running: PS.running,
    port: PS.port,
    pingMs: PS.pingMs,
    country: PS.country,
    error: PS.error,
    vlessLink: vl,
    validLink: !!parsed,
    installed: fs.existsSync(BUNDLED_BIN) || fs.existsSync(VENDOR_BIN) || !!det.found,
    singBoxVersion: det.version || null,
    childPid: PS.child?.pid || null,
  };
}
function saveCfg(p: Record<string, unknown>): void {
  const cur = (settings.get("proxy") || {}) as Record<string, unknown>;
  settings.set({ proxy: { ...cur, ...p } });
}
// --- Запуск / остановка ---

async function startProxy(profileArg: unknown): Promise<ProxyStatus> {
  const raw = String(profileArg || "").trim();
  saveCfg({ vlessLink: raw });
  const prof = parseProfile(raw);
  if (!prof) {
    PS = { ...PS, enabled: false, running: false, error: "Invalid profile (link or JSON)" };
    return getStatus();
  }
  const bin = await detectSB();
  if (!bin.found || !bin.path) {
    PS = { ...PS, enabled: false, running: false, error: "sing-box not found" };
    return getStatus();
  }
  // Локальная копия: сужение свойства не переживает выход в колбэки spawn ниже.
  const binPath = bin.path;
  if (PS.child) {
    try {
      PS.child.kill();
    } catch {}
    PS.child = null;
  }
  // Порт 10808 один: при запуске legacy-прокси гасим встроенное ядро sing-box.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await require("./proxyCore").stopCore();
  } catch {
    /* ядро не загружено */
  }
  const cDir = path.join(BIN_DIR, "configs");
  fs.mkdirSync(cDir, { recursive: true });
  // Сносятся старые конфиги, если есть
  try {
    const olds = fs.readdirSync(cDir).filter((f) => f.endsWith(".json"));
    for (const f of olds) fs.unlinkSync(path.join(cDir, f));
  } catch {}
  const cPath = path.join(cDir, "proxy.json");
  const port = DEF_PORT;
  let cfg: Record<string, unknown> | null | undefined;
  if (prof.type === "full") {
    cfg = ensureSocks(normalizeConfig(JSON.parse(JSON.stringify(prof.cfg))), port);
  } else {
    cfg = buildSBConfig({ ...prof.parts, proxyPort: port });
  }
  try {
    fs.writeFileSync(cPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    PS = { ...PS, error: "Config write failed" };
    return getStatus();
  }
  return new Promise<ProxyStatus>((r) => {
    const child = spawn(binPath, ["run", "-c", cPath, "--disable-color"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    PS.child = child;
    PS.port = port;
    PS.running = false;
    PS.enabled = false;
    PS.error = "";
    let bo = "";
    const bt = setTimeout(() => {
      if (!PS.running && !PS.error) {
        PS.running = true;
        PS.enabled = true;
        logger.info("proxy.started", { port, pid: child.pid });
        r(getStatus());
      }
    }, 3000);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => {
      bo += d.toString();
      if (bo.includes("start") || bo.includes("inbound") || bo.includes("socks")) {
        PS.running = true;
        PS.enabled = true;
        clearTimeout(bt);
        r(getStatus());
      }
    });
    child.on("error", (e) => {
      clearTimeout(bt);
      PS = { ...PS, running: false, enabled: false, error: e.message };
      r(getStatus());
    });
    child.on("close", (code) => {
      clearTimeout(bt);
      if (PS.running) {
        PS.running = false;
        PS.enabled = false;
        PS.child = null;
      } else {
        PS.error = bo.slice(-500) || `sing-box exited with code ${code}`;
        if (!PS.enabled) r(getStatus());
      }
    });
  });
}

function stopProxy(): ProxyStatus {
  if (PS.child) {
    try {
      PS.child.kill();
    } catch {}
    PS.child = null;
  }
  PS = { ...PS, enabled: false, running: false, error: "", pingMs: null, country: null };
  logger.info("proxy.stopped.manual");
  return getStatus();
}

// --- Пинг ---

// Пробуются сервисы определения страны/внешнего IP по приоритету.
// HTTPS в приоритете: голый HTTP через socks часто рвётся на handshake
// (отсюда и наша ошибка «socket hang up»).
const PING_SERVICES: PingService[] = [
  { url: "https://ipwho.is/", pick: (d) => d && (d.country || d.country_name) },
  { url: "https://ipinfo.io/json", pick: (d) => d && d.country },
  { url: "https://ipapi.co/json/", pick: (d) => d && (d.country_name || d.country) },
  { url: "http://ip-api.com/json/?fields=query,country,countryCode", pick: (d) => d && d.country },
];

async function pingProxy(timeout = 8000): Promise<{
  pingMs: number | null;
  country: string | null;
  error?: string;
}> {
  if (!PS.running || !PS.enabled) {
    PS.pingMs = null;
    PS.country = null;
    return { pingMs: null, country: null, error: "Not running" };
  }
  const start = Date.now();
  let lastErr = "";
  for (const svc of PING_SERVICES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await socksFetch(svc.url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const country = svc.pick(data);
      if (country) {
        PS.pingMs = Date.now() - start;
        PS.country = String(country);
        return { pingMs: PS.pingMs, country: PS.country };
      }
    } catch (e) {
      lastErr = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
  PS.pingMs = null;
  PS.country = null;
  const friendly = /hang up|ECONNRESET|socket/i.test(lastErr)
    ? "Connection failed (proxy unreachable)"
    : lastErr || "Ping failed";
  return { pingMs: null, country: null, error: friendly };
}

// --- Установка ---

let is: InstallState = { state: "idle", progress: 0, phase: "", error: "" };
function instStat(): InstallStatus {
  return { ...is, installed: fs.existsSync(BUNDLED_BIN) || fs.existsSync(VENDOR_BIN) };
}
async function installSB(): Promise<InstallStatus> {
  if (is.state === "working") return instStat();
  is = { state: "working", progress: 0, phase: "download", error: "" };
  fs.mkdirSync(BIN_DIR, { recursive: true });
  try {
    is.phase = "download";
    const res = await fetch(SB_URL, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    const zp = path.join(BIN_DIR, "sb.zip");
    let rcvd = 0;
    const ws = fs.createWriteStream(zp);
    ws.on("error", () => {});
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rcvd += b.length;
      is.progress = declared ? Math.min(100, Math.round((100 * rcvd) / declared)) : 0;
      if (!ws.write(b)) await new Promise<void>((r) => ws.once("drain", () => r()));
    }
    await new Promise<void>((resolve) => ws.end(() => resolve()));
    is.phase = "extract";
    is.progress = 0;
    // adm-zip без своих типов: модуль тянется лениво, поэтому require + отключение
    // правила (тот же приём, что для JS-зависимостей в server/ts/config.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zp);
    const exePath = path.join(BIN_DIR, "sing-box.exe");
    const tmpDir = path.join(BIN_DIR, "_tmp_extract");
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);
    const findExe = (dir: string): boolean => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const r2 = findExe(p);
          if (r2) return r2;
        } else if (e.name.toLowerCase() === "sing-box.exe") {
          fs.copyFileSync(p, exePath);
          return true;
        }
      }
      return false;
    };
    if (!findExe(tmpDir)) throw new Error("sing-box.exe not found after extraction");
    try {
      fs.rmSync(zp, { force: true });
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    dc = null;
    is = { state: "done", progress: 100, phase: "", error: "" };
    logger.info("singbox.install.done", { path: BUNDLED_BIN });
  } catch (e) {
    is = { state: "error", progress: 0, phase: "", error: (e as Error).message };
    logger.error("singbox.install.error", { error: (e as Error).message });
  }
  return instStat();
}

// --- Прокси-хелперы ---

async function getProxyAgent(): Promise<SocksProxyAgent | null> {
  if (!PS.running || !PS.enabled) return null;
  const Agent = await getSocksAgent();
  return new Agent(`socks5://127.0.0.1:${PS.port}`);
}

function getProxyUrl(): string | null {
  if (!PS.running || !PS.enabled) return null;
  return `socks5://127.0.0.1:${PS.port}`;
}

/**
 * Запрос через socks5-прокси (без fetch/dispatcher — норм с любым http.Agent).
 * Возвращает fetch-подобное { ok, status, text(), json() }.
 */
async function socksFetch(url: string, opts: SocksOpts = {}): Promise<SocksResponse> {
  const agent = PS.running && PS.enabled ? await getProxyAgent() : null;
  return new Promise<SocksResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const reqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };
    if (agent) reqOpts.agent = agent;
    // Таймаут на обмен с прокси (и на CONNECT-фазу для HTTPS).
    const timeout = opts.timeout || 12000;
    const req = mod.request(reqOpts, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        // statusCode у настоящего ответа всегда есть; 0 — на синтетических объектах.
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body)),
        });
      });
    });
    req.setTimeout(timeout, () => {
      try {
        req.destroy();
      } catch {}
      reject(new Error("Proxy timeout"));
    });
    req.on("error", reject);
    // Уважаю AbortSignal
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        return reject(new Error("Aborted"));
      }
      opts.signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(new Error("Aborted"));
        },
        { once: true },
      );
    }
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// proxyFetch теперь = socksFetch (заменили fetch+dispatcher)
async function proxyFetch(url: string, opts: SocksOpts = {}): Promise<SocksResponse> {
  return socksFetch(url, opts);
}
// --- Сохранённые VLESS ---

/** Достаются все сохранённые VLESS-профили. */
function getSavedVless(): SavedVless[] {
  const cfg = (settings.get("proxy") || {}) as ProxyConfig;
  return cfg.savedVless || [];
}

/** Сохраняется новый VLESS-профиль. */
function saveVless(link: unknown, name?: unknown): SavedVless {
  if (!link) throw new Error("link required");
  const cfg = (settings.get("proxy") || {}) as ProxyConfig;
  const saved = cfg.savedVless || [];
  // Проверяется, нет ли уже такой ссылки
  const existing = saved.findIndex((s) => s.link === link);
  if (existing >= 0) {
    saved[existing].name = name ? String(name) : saved[existing].name;
    saved[existing].updatedAt = new Date().toISOString();
  } else {
    saved.push({
      id: "vl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      link: String(link),
      name: name ? String(name) : profileName(link),
      updatedAt: new Date().toISOString(),
    });
  }
  cfg.savedVless = saved;
  settings.set({ proxy: cfg });
  return saved[saved.length - 1] || saved[existing];
}

/** Удаление профиля по ID. */
function deleteVless(id: unknown): { ok: boolean } {
  const cfg = (settings.get("proxy") || {}) as ProxyConfig;
  cfg.savedVless = (cfg.savedVless || []).filter((s) => s.id !== id);
  settings.set({ proxy: cfg });
  return { ok: true };
}

// --- Экспорт ---

export {
  parseVlessLink,
  parseProfile,
  buildSBConfig,
  normalizeConfig,
  detectSB,
  getStatus,
  startProxy,
  stopProxy,
  pingProxy,
  instStat as installStatus,
  installSB as installSingBox,
  getProxyAgent,
  getProxyUrl,
  proxyFetch,
  getSavedVless,
  saveVless,
  deleteVless,
};
