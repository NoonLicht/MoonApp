"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const settings = require("./settings");
const logger = require("./logger");

// socks-proxy-agent — ESM, загружается динамически
async function getSocksAgent() {
  const mod = await import("socks-proxy-agent");
  return mod.SocksProxyAgent;
}

// --- Константы ---

const BIN_DIR = path.join(DIRS.storage, "singbox");
const BUNDLED_BIN = path.join(BIN_DIR, "sing-box.exe");
// Бинарь из комплекта инсталлятора: server/vendor/singbox/sing-box.exe
// (в собранной сборке — app.asar.unpacked, см. build.asarUnpack).
const VENDOR_BIN = path.join(__dirname, "vendor", "singbox", "sing-box.exe");
const SB_VER = "1.11.0";
const SB_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box-${SB_VER}-windows-amd64.zip`;
const DEF_PORT = 10808;
let PS = {
  enabled: false,
  port: DEF_PORT,
  running: false,
  child: null,
  pingMs: null,
  country: null,
  error: "",
};

// --- Парсинг VLESS-ссылки ---

function parseVlessLink(link) {
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
    const p = {};
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
function jsonNodeToParts(o) {
  if (!o || typeof o !== "object") return null;
  const uuid = o.uuid || (o.user && o.user.uuid);
  const server = o.server || o.address || o.host;
  const port =
    o.port !== undefined
      ? Number(o.port)
      : o.server_port !== undefined
        ? Number(o.server_port)
        : NaN;
  if (!uuid || !server || !Number.isFinite(port)) return null;
  const params = {};
  if (o.flow) params.flow = o.flow;
  if (o.network) params.network = o.network;
  if (o.packet_encoding) params.packetEncoding = o.packet_encoding;
  const tls = o.tls;
  if (tls && typeof tls === "object") {
    if (tls.reality) {
      params.security = "reality";
      if (tls.reality.public_key) params.pbk = tls.reality.public_key;
      if (tls.reality.short_id) params.sid = tls.reality.short_id;
    } else if (tls.enabled === false) {
      params.security = "none";
    } else {
      params.security = "tls";
    }
    if (tls.server_name) params.sni = tls.server_name;
    if (tls.utls && tls.utls.fingerprint) params.fp = tls.utls.fingerprint;
  }
  return { uuid, server, port, params };
}

/**
 * Разбор профиля: vless://-ссылка ИЛИ JSON из буфера.
 * Поддерживается: полный конфиг sing-box (с outbounds[]) и одиночная нода.
 * → null | { type:"node", parts:{uuid,server,port,params} } | { type:"full", cfg:<конфиг> }
 */
function parseProfile(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    let o;
    try {
      o = JSON.parse(s);
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

function inputIsValid(profile) {
  return !!parseProfile(profile);
}

/** Гарантия, что в конфиге пользователя есть socks-инбаунд. */
function ensureSocks(cfg, port) {
  if (!cfg || typeof cfg !== "object") return cfg;
  if (!Array.isArray(cfg.inbounds)) cfg.inbounds = [];
  if (!cfg.inbounds.some((i) => i && i.type === "socks")) {
    cfg.inbounds.push({ type: "socks", tag: "socks-in", listen: "127.0.0.1", listen_port: port });
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
function profileName(raw) {
  const r = String(raw || "").trim();
  const prof = parseProfile(r);
  if (!prof) return "Unnamed";
  if (prof.type === "full") return prof.cfg?.tag || "Profile";
  const p = prof.parts.params;
  const rem = decodeURIComponent(String(p.remark || p.ps || ""));
  return rem || prof.parts.server;
}
// --- Генерация конфига ---

function buildSBConfig({ uuid, server, port, params, proxyPort }) {
  const pPort = proxyPort || DEF_PORT;
  // sing-box умеет только xtls-rprx-vision (Reality/Vision); остальные Xray-флоу (xtls-rprx-direct/…) — нет
  const rawFlow = params.flow || "";
  const allowedFlow =
    rawFlow === "xtls-rprx-vision" ? rawFlow : rawFlow.startsWith("xtls-rprx-") ? "" : rawFlow;
  // Если flow xtls, а security не задан — TLS включается по умолчанию
  const needsTls =
    params.security === "tls" || params.security === "reality" || rawFlow.startsWith("xtls-");
  const ob = {
    type: "vless",
    tag: "proxy",
    server,
    server_port: port,
    uuid,
    flow: allowedFlow,
    packet_encoding: "xudp",
  };
  if (needsTls) {
    const tls = { enabled: true };
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
function normalizeConfig(cfg) {
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

let dc = null,
  da = 0;
function sbCand() {
  return [BUNDLED_BIN, VENDOR_BIN, "sing-box"];
}
function runSBVer(b) {
  return new Promise((r) => {
    const { execFile } = require("child_process");
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
async function detectSB() {
  const n = Date.now();
  if (dc && n - da < 12000) return dc;
  let res = { found: false, path: null, version: null };
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

function getStatus() {
  const cfg = settings.get("proxy") || {};
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
function saveCfg(p) {
  const cur = settings.get("proxy") || {};
  settings.set({ proxy: { ...cur, ...p } });
}
// --- Запуск / остановка ---

async function startProxy(profileArg) {
  const raw = String(profileArg || "").trim();
  saveCfg({ vlessLink: raw });
  const prof = parseProfile(raw);
  if (!prof) {
    PS = { ...PS, enabled: false, running: false, error: "Invalid profile (link or JSON)" };
    return getStatus();
  }
  const bin = await detectSB();
  if (!bin.found) {
    PS = { ...PS, enabled: false, running: false, error: "sing-box not found" };
    return getStatus();
  }
  if (PS.child) {
    try {
      PS.child.kill();
    } catch {}
    PS.child = null;
  }
  // Порт 10808 один: при запуске legacy-прокси гасим встроенное ядро sing-box.
  try {
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
  let cfg;
  if (prof.type === "full") {
    cfg = ensureSocks(normalizeConfig(JSON.parse(JSON.stringify(prof.cfg))), port);
  } else {
    cfg = buildSBConfig({ ...prof.parts, proxyPort: port });
  }
  try {
    fs.writeFileSync(cPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    PS = { ...PS, error: "Config write failed" };
    return getStatus();
  }
  return new Promise((r) => {
    const child = spawn(bin.path, ["run", "-c", cPath, "--disable-color"], {
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

function stopProxy() {
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
const PING_SERVICES = [
  { url: "https://ipwho.is/", pick: (d) => d && (d.country || d.country_name) },
  { url: "https://ipinfo.io/json", pick: (d) => d && d.country },
  { url: "https://ipapi.co/json/", pick: (d) => d && (d.country_name || d.country) },
  { url: "http://ip-api.com/json/?fields=query,country,countryCode", pick: (d) => d && d.country },
];

async function pingProxy(timeout = 8000) {
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
      const data = await res.json();
      const country = svc.pick(data);
      if (country) {
        PS.pingMs = Date.now() - start;
        PS.country = country;
        return { pingMs: PS.pingMs, country: PS.country };
      }
    } catch (e) {
      lastErr = e.message;
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

let is = { state: "idle", progress: 0, phase: "", error: "" };
function instStat() {
  return { ...is, installed: fs.existsSync(BUNDLED_BIN) || fs.existsSync(VENDOR_BIN) };
}
async function installSB() {
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
    for await (const chunk of res.body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rcvd += b.length;
      is.progress = declared ? Math.min(100, Math.round((100 * rcvd) / declared)) : 0;
      if (!ws.write(b)) await new Promise((r) => ws.once("drain", r));
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    is.phase = "extract";
    is.progress = 0;
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zp);
    const exePath = path.join(BIN_DIR, "sing-box.exe");
    const tmpDir = path.join(BIN_DIR, "_tmp_extract");
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);
    const findExe = (dir) => {
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
    is = { state: "error", progress: 0, phase: "", error: e.message };
    logger.error("singbox.install.error", { error: e.message });
  }
  return instStat();
}

// --- Прокси-хелперы ---

async function getProxyAgent() {
  if (!PS.running || !PS.enabled) return null;
  const Agent = await getSocksAgent();
  return new Agent(`socks5://127.0.0.1:${PS.port}`);
}

function getProxyUrl() {
  if (!PS.running || !PS.enabled) return null;
  return `socks5://127.0.0.1:${PS.port}`;
}

/**
 * Запрос через socks5-прокси (без fetch/dispatcher — норм с любым http.Agent).
 * Возвращает fetch-подобное { ok, status, text(), json() }.
 */
async function socksFetch(url, opts = {}) {
  const agent = PS.running && PS.enabled ? await getProxyAgent() : null;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    const reqOpts = {
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
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
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
async function proxyFetch(url, opts = {}) {
  return socksFetch(url, opts);
}
// --- Сохранённые VLESS ---

/** Достаются все сохранённые VLESS-профили. */
function getSavedVless() {
  const cfg = settings.get("proxy") || {};
  return cfg.savedVless || [];
}

/** Сохраняется новый VLESS-профиль. */
function saveVless(link, name) {
  if (!link) throw new Error("link required");
  const cfg = settings.get("proxy") || {};
  const saved = cfg.savedVless || [];
  // Проверяется, нет ли уже такой ссылки
  const existing = saved.findIndex((s) => s.link === link);
  if (existing >= 0) {
    saved[existing].name = name || saved[existing].name;
    saved[existing].updatedAt = new Date().toISOString();
  } else {
    saved.push({
      id: "vl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      link,
      name: name || profileName(link),
      updatedAt: new Date().toISOString(),
    });
  }
  cfg.savedVless = saved;
  settings.set({ proxy: cfg });
  return saved[saved.length - 1] || saved[existing];
}

/** Удаление профиля по ID. */
function deleteVless(id) {
  const cfg = settings.get("proxy") || {};
  cfg.savedVless = (cfg.savedVless || []).filter((s) => s.id !== id);
  settings.set({ proxy: cfg });
  return { ok: true };
}

// --- Экспорт ---

module.exports = {
  parseVlessLink,
  parseProfile,
  buildSBConfig,
  normalizeConfig,
  detectSB,
  getStatus,
  startProxy,
  stopProxy,
  pingProxy,
  installStatus: instStat,
  installSingBox: installSB,
  getProxyAgent,
  getProxyUrl,
  proxyFetch,
  getSavedVless,
  saveVless,
  deleteVless,
};
