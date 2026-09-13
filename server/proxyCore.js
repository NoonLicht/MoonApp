"use strict";

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

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");

// --- Константы движка ---

const ENGINE_ID = "sing-box";
const ENGINE_VER = "1.11.0";
// Держать в синхроне со scripts/fetch-engines.js (SB_VER).
const ENGINE_URL = `https://github.com/SagerNet/sing-box/releases/download/v${ENGINE_VER}/sing-box-${ENGINE_VER}-windows-amd64.zip`;

const DEFAULT_SOCKS_PORT = 10808;
const DEFAULT_HTTP_PORT = 10809;
const PROXY_HOST = "127.0.0.1";

// Пользовательский каталог движка (вне asar), вендор-комплект инсталлятора и
// extraResources-пути `resources/bin/proxy-core/`, `resources/bin/singbox/`.
const CORE_DIR = path.join(DIRS.storage, "proxyCore");
const BUNDLED_BIN = path.join(CORE_DIR, "sing-box.exe");
const VENDOR_BIN = path.join(__dirname, "vendor", "proxy-core", "sing-box.exe");
// Легаси-точки: sing-box из комплекта инсталлятора (его кладёт
// scripts/fetch-engines.js) и то, что успела скачать старая панель «Прокси».
// Ядро ОБЯЗАНО их видеть: иначе на свежей сборке UI пишет «движок не найден»
// при том, что sing-box физически лежит рядом.
const VENDOR_LEGACY_BIN = path.join(__dirname, "vendor", "singbox", "sing-box.exe");
const BUNDLED_LEGACY_BIN = path.join(DIRS.storage, "singbox", "sing-box.exe");

/** Кандидаты из resources/ (собранный Electron-инсталлятор). */
function resourcesBins() {
  const out = [];
  try {
    if (process.resourcesPath) {
      out.push(path.join(process.resourcesPath, "bin", "proxy-core", "sing-box.exe"));
      out.push(path.join(process.resourcesPath, "bin", "singbox", "sing-box.exe"));
      out.push(path.join(process.resourcesPath, "singbox", "sing-box.exe"));
    }
  } catch { /* не Electron — resourcesPath отсутствует */ }
  return out;
}

const SUPPORTED_PROTOCOLS = ["vless", "vmess", "trojan", "hysteria2", "tuic", "shadowsocks", "ssh"];

// --- Общие хелперы разбора ---

/** Безопасный decodeURIComponent: битая последовательность не роняет разбор. */
function dec(s) {
  try { return decodeURIComponent(String(s == null ? "" : s)); } catch { return String(s == null ? "" : s); }
}

/** Разбор query-строки в объект (значения декодируются). */
function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of String(qs).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : "";
    out[dec(k)] = dec(v);
  }
  return out;
}

/** true/false из «1/true/yes/on». */
function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
}

/** Base64 → utf8 (терпит «URL-safe» алфавит и отсутствие padding). */
function b64decode(input) {
  try {
    const s = String(input || "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch { return ""; }
}

/** host:port → { server, port }. Поддерживает [ipv6]:port. */
function splitHostPort(hp) {
  const s = String(hp || "").trim();
  let server = "";
  let port = NaN;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return { server: "", port: NaN };
    server = s.slice(0, close + 1).replace(/^\[|\]$/g, ""); // без скобок
    const rest = s.slice(close + 1).replace(/^:/, "");
    port = parseInt(rest, 10);
  } else {
    const i = s.lastIndexOf(":");
    server = i >= 0 ? s.slice(0, i) : s;
    port = i >= 0 ? parseInt(s.slice(i + 1), 10) : NaN;
  }
  return { server: server.trim(), port };
}

/** Читает имя узла из #fragment. */
function fragmentTag(str, fallback) {
  const i = String(str || "").indexOf("#");
  if (i < 0) return fallback || "";
  return dec(String(str).slice(i + 1)) || fallback || "";
}


// --- Разбор URI по протоколам ---
// Каждый парсер возвращает нормализованный узел:
//   { protocol, tag, server, port, uuid?, password?, method?, flow?, security?,
//     sni?, fp?, alpn?, pbk?, sid?, spx?, network?, path?, host?, insecure?, params }
// или null, если строка не разобралась.

/** Общий «хвост» URI: [user@]host:port?query#tag → части. */
function splitAuthority(rest) {
  const hashIdx = String(rest).indexOf("#");
  const tag = fragmentTag(rest, "");
  const withoutTag = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = withoutTag.indexOf("?");
  const authority = qIdx >= 0 ? withoutTag.slice(0, qIdx) : withoutTag;
  const query = qIdx >= 0 ? withoutTag.slice(qIdx + 1) : "";
  return { authority, query, tag };
}

function parseVless(uri) {
  // vless://<uuid>@host:port?params#tag
  const { authority, query, tag } = splitAuthority(uri.slice("vless://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const uuid = dec(authority.slice(0, at));
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!uuid || !server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "vless", tag: tag || server, uuid, server, port,
    flow: p.flow || "",
    security: p.security || (p.flow && p.flow.startsWith("xtls-") ? "tls" : "none"),
    sni: p.sni || p.host || "",
    fp: p.fp || "",
    alpn: p.alpn || "",
    pbk: p.pbk || "",
    sid: p.sid || "",
    spx: p.spx || "",
    network: p.type || "tcp",
    path: p.path || "",
    host: p.host || "",
    serviceName: p.serviceName || "",
    insecure: truthy(p.allowInsecure),
    params: p,
  };
}

function parseVmess(uri) {
  // vmess://base64({ v, ps, add, port, id, aid, scy, net, host, path, tls, sni, fp })
  const raw = uri.slice("vmess://".length).trim();
  const text = raw.startsWith("{") ? raw : b64decode(raw);
  if (!text.trim().startsWith("{")) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  const server = String(o.add || o.server || "").trim();
  const port = parseInt(o.port, 10);
  const uuid = String(o.id || o.uuid || "").trim();
  if (!server || !Number.isFinite(port) || !uuid) return null;
  return {
    protocol: "vmess", tag: String(o.ps || o.remark || server), uuid, server, port,
    alterId: Number(o.aid || o.alterId || 0),
    cipher: o.scy || "auto",
    security: String(o.tls || "").toLowerCase() === "tls" ? "tls" : "none",
    sni: o.sni || o.host || "",
    fp: o.fp || "",
    network: o.net || "tcp",
    path: o.path || "",
    host: o.host || "",
    insecure: truthy(o.allowInsecure),
    params: o,
  };
}

function parseTrojan(uri) {
  // trojan://<password>@host:port?params#tag
  const { authority, query, tag } = splitAuthority(uri.slice("trojan://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const password = dec(authority.slice(0, at));
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!password || !server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "trojan", tag: tag || server, password, server, port,
    security: p.security || "tls",
    sni: p.sni || p.peer || p.host || "",
    fp: p.fp || "",
    alpn: p.alpn || "",
    network: p.type || "tcp",
    path: p.path || "",
    host: p.host || "",
    serviceName: p.serviceName || "",
    insecure: truthy(p.allowInsecure),
    params: p,
  };
}
function parseHysteria2(uri) {
  // hysteria2://<auth>@host:port?sni=&obfs=&obfs-password=&insecure=1#tag
  const schemeEnd = uri.indexOf("://") + 3;
  const { authority, query, tag } = splitAuthority(uri.slice(schemeEnd));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const password = dec(authority.slice(0, at));
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "hysteria2", tag: tag || server, password, server, port,
    sni: p.sni || p.peer || "",
    obfs: p.obfs || "",
    obfsPassword: p["obfs-password"] || "",
    security: "tls",
    alpn: p.alpn || "",
    insecure: truthy(p.insecure || p.allowInsecure),
    params: p,
  };
}

function parseTuic(uri) {
  // tuic://<uuid>:<password>@host:port?congestion_control=&sni=#tag
  const { authority, query, tag } = splitAuthority(uri.slice("tuic://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const userinfo = dec(authority.slice(0, at));
  const colon = userinfo.indexOf(":");
  const uuid = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
  const password = colon >= 0 ? userinfo.slice(colon + 1) : "";
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!uuid || !server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "tuic", tag: tag || server, uuid, password, server, port,
    congestionControl: p.congestion_control || "bbr",
    udpRelayMode: p.udp_relay_mode || "native",
    sni: p.sni || "",
    alpn: p.alpn || "",
    security: "tls",
    insecure: truthy(p.allow_insecure || p.insecure),
    params: p,
  };
}


/** ss:// — два исторических формата. */
function parseShadowsocks(uri) {
  const body = uri.slice("ss://".length);
  const { query, tag } = splitAuthority(body);
  const p = parseQuery(query);

  const hashIdx = body.indexOf("#");
  const withoutTag = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
  const qIdx = withoutTag.indexOf("?");
  const core = qIdx >= 0 ? withoutTag.slice(0, qIdx) : withoutTag;

  let method = "";
  let password = "";
  let hostport = "";

  if (core.includes("@")) {
    // ss://base64(method:password)@host:port  |  ss://method:password@host:port
    const at = core.lastIndexOf("@");
    const userinfo = core.slice(0, at);
    hostport = core.slice(at + 1);
    const decoded = userinfo.includes(":") ? dec(userinfo) : b64decode(userinfo);
    const colon = decoded.indexOf(":");
    method = colon >= 0 ? decoded.slice(0, colon) : decoded;
    password = colon >= 0 ? decoded.slice(colon + 1) : "";
  } else {
    // ss://base64(method:password@host:port)#tag
    const decoded = b64decode(core);
    const at = decoded.lastIndexOf("@");
    if (at < 0) return null;
    const userinfo = decoded.slice(0, at);
    hostport = decoded.slice(at + 1);
    const colon = userinfo.indexOf(":");
    method = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    password = colon >= 0 ? userinfo.slice(colon + 1) : "";
  }

  const { server, port } = splitHostPort(hostport);
  if (!server || !Number.isFinite(port) || !method) return null;
  return {
    protocol: "shadowsocks", tag: tag || server, server, port,
    method: method.toLowerCase(), password, params: p,
  };
}

function parseSsh(uri) {
  // ssh://<user>:<password>@host:port#tag (нестандартный, но встречается в подписках)
  const { authority, tag } = splitAuthority(uri.slice("ssh://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const userinfo = dec(authority.slice(0, at));
  const colon = userinfo.indexOf(":");
  const user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
  const password = colon >= 0 ? userinfo.slice(colon + 1) : "";
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!user || !server || !Number.isFinite(port)) return null;
  return { protocol: "ssh", tag: tag || server, user, password, server, port, params: {} };
}



// --- Точка входа разбора ---

const PARSERS = {
  vless: parseVless,
  vmess: parseVmess,
  trojan: parseTrojan,
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
  tuic: parseTuic,
  ss: parseShadowsocks,
  shadowsocks: parseShadowsocks,
  ssh: parseSsh,
};

/** Разбор одного URI. → узел | null. */
function parseUri(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = /^([a-z0-9+.-]+):\/\//i.exec(s);
  if (!m) return null;
  const parser = PARSERS[m[1].toLowerCase()];
  if (!parser) return null;
  try {
    const node = parser(s);
    return node && node.server ? node : null;
  } catch { return null; }
}

/**
 * Разбор подписки: base64 / список URI / JSON-массив / sing-box-конфиг.
 * → { format: "uri"|"json", nodes: [...], config?, raw, decoded? }
 */
function parseSubscription(input) {
  const raw = String(input || "").trim();
  if (!raw) return { format: "uri", nodes: [] };

  // 1) JSON (Xray/V2Ray или sing-box конфиг, либо массив нод) — разбираем outbounds.
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const o = JSON.parse(raw);
      if (Array.isArray(o)) return { format: "json", nodes: o.map(parseUri).filter(Boolean), raw };
      if (o && Array.isArray(o.outbounds)) {
        // Раньше здесь возвращался ПУСТОЙ список: JSON-конфиги (самый частый
        // формат экспорта) не импортировались вообще — а это и есть «ничего не
        // добавилось после импорта».
        const nodes = o.outbounds.map(nodeFromJsonOutbound).filter(Boolean);
        return { format: "json", nodes, config: o, raw };
      }
    } catch { /* падаем ниже на base64/URI */ }
  }

  // 2) base64-подписка (одна большая строка без «://»).
  if (!raw.includes("://")) {
    const decoded = b64decode(raw);
    if (decoded && decoded.includes("://")) {
      return { format: "uri", nodes: decoded.split(/[\r\n]+/).map(parseUri).filter(Boolean), raw, decoded: true };
    }
    return { format: "uri", nodes: [], raw };
  }

  // 3) Список URI (по строкам или через запятую).
  return { format: "uri", nodes: raw.split(/[\s,]+/).map(parseUri).filter(Boolean), raw };
}

// --- TLS-хелпер (общий для tls/reality-протоколов) ---

function tlsBlock(node) {
  const tls = { enabled: true };
  if (node.sni) tls.server_name = node.sni;
  if (node.alpn) tls.alpn = String(node.alpn).split(",").map((x) => x.trim()).filter(Boolean);
  if (node.insecure) tls.insecure = true;
  if (node.fp) tls.utls = { enabled: true, fingerprint: node.fp || "chrome" };
  if (node.security === "reality" || node.pbk) {
    tls.reality = { enabled: true, public_key: node.pbk || "", short_id: node.sid || "" };
  }
  return tls;
}

/** Транспорты, которые умеет движок (sing-box). xhttp/kcp он НЕ поддерживает —
 *  такие узлы импортируем, но помечаем как неподдерживаемые, чтобы UI не врал. */
const SUPPORTED_TRANSPORTS = ["", "tcp", "ws", "grpc", "http", "h2", "httpupgrade", "quic"];

/** Поддерживает ли движок этот узел (протокол + транспорт). */
function isNodeSupported(node) {
  if (!node || !SUPPORTED_PROTOCOLS.includes(node.protocol)) return false;
  return SUPPORTED_TRANSPORTS.includes(String(node.network || "").toLowerCase());
}

/** Транспорт (network/path/host) → sing-box transport-блок или undefined. */
function transportBlock(node) {
  const net = String(node.network || "").toLowerCase();
  if (net === "ws") {
    return { type: "ws", path: node.path || "/", headers: node.host ? { Host: node.host } : undefined };
  }
  if (net === "grpc") return { type: "grpc", service_name: node.serviceName || "" };
  if (net === "quic") return { type: "quic" };
  if (net === "httpupgrade") return { type: "httpupgrade", host: node.host || undefined, path: node.path || "/" };
  if (net === "http" || net === "h2") {
    return { type: "http", host: node.host ? [node.host] : undefined, path: node.path || "/" };
  }
  return undefined;
}

// --- Импорт JSON-конфигов (Xray/V2Ray и sing-box) ---

/** Осмысленное имя узла: generic-теги («proxy», «proxy-2») заменяем адресом. */
function pickTag(tag, address) {
  const t = String(tag || "").trim();
  if (!t) return address || "";
  if (/^(proxy|out|outbound|node|vless|vmess|trojan|ss|shadowsocks|direct|block)(-\d+)?$/i.test(t)) return address || t;
  return t;
}

/** Транспорт + TLS из streamSettings (формат Xray/V2Ray) → поля нашего узла. */
function fromXrayStream(stream) {
  const s = stream || {};
  const net = String(s.network || "tcp").toLowerCase();
  const sec = String(s.security || "none").toLowerCase();
  const reality = s.realitySettings || {};
  const tls = s.tlsSettings || {};
  const ws = s.wsSettings || {};
  const grpc = s.grpcSettings || {};
  const xhttp = s.xhttpSettings || {};
  const http = s.httpSettings || {};
  const upg = s.httpupgradeSettings || {};
  const hostFromHeaders = ws.headers && (ws.headers.Host || ws.headers.host);
  const httpHost = Array.isArray(http.host) ? http.host[0] : http.host;

  return {
    network: net === "tcp" ? "" : net,
    security: sec,
    sni: reality.serverName || tls.serverName || "",
    fp: reality.fingerprint || tls.fingerprint || "",
    pbk: reality.publicKey || "",
    sid: reality.shortId || "",
    spx: reality.spiderX || "",
    alpn: Array.isArray(tls.alpn) ? tls.alpn.join(",") : "",
    insecure: !!tls.allowInsecure,
    path: ws.path || xhttp.path || http.path || upg.path || "",
    host: hostFromHeaders || xhttp.host || httpHost || upg.host || "",
    serviceName: grpc.serviceName || "",
  };
}

/** Один outbound Xray/V2Ray → узел или null (freedom/blackhole/неизвестное). */
function nodeFromXrayOutbound(ob) {
  const proto = String(ob.protocol || "").toLowerCase();
  const settings = ob.settings || {};
  const stream = fromXrayStream(ob.streamSettings);
  const base = { protocol: proto, ...stream };

  if (proto === "vless" || proto === "vmess") {
    const v = (settings.vnext || [])[0] || {};
    const u = (v.users || [])[0] || {};
    if (!v.address) return null;
    const node = {
      ...base,
      server: v.address,
      port: Number(v.port),
      uuid: u.id || "",
      tag: pickTag(ob.tag, v.address),
    };
    if (proto === "vless") node.flow = u.flow || "";
    else { node.alterId = Number(u.alterId) || 0; node.cipher = u.security || "auto"; }
    return node.server && Number.isFinite(node.port) ? node : null;
  }
  if (proto === "trojan" || proto === "shadowsocks") {
    const s0 = (settings.servers || [])[0] || {};
    if (!s0.address) return null;
    const node = {
      ...base,
      server: s0.address,
      port: Number(s0.port),
      password: s0.password || "",
      tag: pickTag(ob.tag, s0.address),
    };
    if (proto === "shadowsocks") node.method = s0.method || "";
    return node.server && Number.isFinite(node.port) ? node : null;
  }
  return null; // freedom, blackhole, dns, socks, http… — не узлы
}

/** Один outbound sing-box → узел или null. */
function nodeFromSingBoxOutbound(ob) {
  const type = String(ob.type || "").toLowerCase();
  if (!["vless", "vmess", "trojan", "hysteria2", "tuic", "shadowsocks", "ssh"].includes(type)) return null;
  const tls = ob.tls || {};
  const tr = ob.transport || {};
  const reality = tls.reality || {};
  const utls = tls.utls || {};
  const headers = tr.headers || {};
  const host = tr.host || headers.Host || headers.host || "";
  const node = {
    protocol: type,
    server: ob.server,
    port: Number(ob.server_port),
    tag: pickTag(ob.tag, ob.server),
    network: tr.type ? String(tr.type).toLowerCase() : "",
    security: reality.enabled ? "reality" : (tls.enabled ? "tls" : "none"),
    sni: tls.server_name || "",
    fp: utls.fingerprint || "",
    pbk: reality.public_key || "",
    sid: reality.short_id || "",
    alpn: Array.isArray(tls.alpn) ? tls.alpn.join(",") : "",
    insecure: !!tls.insecure,
    path: tr.path || "",
    host: Array.isArray(host) ? (host[0] || "") : host,
    serviceName: tr.service_name || "",
  };
  if (type === "vless") { node.uuid = ob.uuid || ""; node.flow = ob.flow || ""; }
  if (type === "vmess") { node.uuid = ob.uuid || ""; node.alterId = ob.alter_id || 0; node.cipher = ob.security || "auto"; }
  if (type === "trojan" || type === "hysteria2" || type === "shadowsocks") node.password = ob.password || "";
  if (type === "shadowsocks") node.method = ob.method || "";
  if (type === "tuic") { node.uuid = ob.uuid || ""; node.password = ob.password || ""; }
  if (type === "ssh") node.user = ob.user || "";
  if (type === "hysteria2" && ob.obfs) { node.obfs = ob.obfs.type || ""; node.obfsPassword = ob.obfs.password || ""; }
  return node.server && Number.isFinite(node.port) ? node : null;
}

/** Outbound из JSON любого формата → узел. Формат определяется по полям. */
function nodeFromJsonOutbound(ob) {
  if (!ob || typeof ob !== "object") return null;
  if (ob.protocol) return nodeFromXrayOutbound(ob);
  if (ob.type) return nodeFromSingBoxOutbound(ob);
  return null;
}

// --- Генерация outbound ---

/** Узел → sing-box outbound-объект. Неизвестный протокол → null. */
function buildOutbound(node, tag = "proxy") {
  if (!node || !node.server || !Number.isFinite(Number(node.port))) return null;
  const server = node.server;
  const server_port = Number(node.port);
  const base = { tag, server, server_port };
  const transport = transportBlock(node);

  switch (node.protocol) {
    case "vless": {
      // sing-box умеет только xtls-rprx-vision; прочие xtls-флоу недопустимы.
      const rawFlow = node.flow || "";
      const flow = rawFlow === "xtls-rprx-vision" ? rawFlow : (rawFlow.startsWith("xtls-rprx-") ? "" : rawFlow);
      const ob = { type: "vless", ...base, uuid: node.uuid, flow, packet_encoding: "xudp" };
      if (transport) ob.transport = transport;
      if (node.security === "tls" || node.security === "reality" || rawFlow.startsWith("xtls-")) ob.tls = tlsBlock(node);
      return ob;
    }
    case "vmess": {
      const ob = { type: "vmess", ...base, uuid: node.uuid, security: node.cipher || "auto", alter_id: node.alterId || 0 };
      if (transport) ob.transport = transport;
      if (node.security === "tls") ob.tls = tlsBlock(node);
      return ob;
    }
    case "trojan": {
      const ob = { type: "trojan", ...base, password: node.password };
      if (transport) ob.transport = transport;
      if (node.security !== "none") ob.tls = tlsBlock(node);
      return ob;
    }
    case "hysteria2": {
      const ob = { type: "hysteria2", ...base, password: node.password, tls: tlsBlock(node) };
      if (node.obfs) ob.obfs = { type: node.obfs, password: node.obfsPassword || "" };
      return ob;
    }
    case "tuic": {
      return {
        type: "tuic", ...base, uuid: node.uuid, password: node.password,
        congestion_control: node.congestionControl || "bbr",
        udp_relay_mode: node.udpRelayMode || "native",
        tls: tlsBlock(node),
      };
    }
    case "shadowsocks": {
      return { type: "shadowsocks", ...base, method: node.method, password: node.password };
    }
    case "ssh": {
      const ob = { type: "ssh", ...base, user: node.user };
      if (node.password) ob.password = node.password;
      return ob;
    }
    default:
      return null;
  }
}

/** Итоговый конфиг sing-box: socks5 + http inbound, один outbound, direct-роут. */
function buildSingBoxConfig(node, opts = {}) {
  // Неподдерживаемый транспорт (xhttp/kcp) нельзя «схлопнуть» в tcp по умолчанию:
  // получился бы конфиг, валидный по синтаксису, но заведомо нерабочий.
  if (!isNodeSupported(node)) return null;
  const out = buildOutbound(node, "proxy");
  if (!out) return null;
  const socksPort = Number(opts.socksPort) || DEFAULT_SOCKS_PORT;
  const httpPort = Number(opts.httpPort) || DEFAULT_HTTP_PORT;
  const inbounds = [
    { type: "socks", tag: "socks-in", listen: PROXY_HOST, listen_port: socksPort },
    { type: "http", tag: "http-in", listen: PROXY_HOST, listen_port: httpPort },
  ];
  return {
    log: { level: "warn", output: "" },
    inbounds,
    outbounds: [out, { type: "direct", tag: "direct" }],
    route: {
      auto_detect_interface: true,
      rules: [{ outbound: "direct", ip_is_private: true }],
      final: "proxy",
    },
  };
}


// --- Жизненный цикл движка ---

/** Кандидаты пути к sing-box.exe: extraResources → пользовательский → вендор → PATH. */
function binCandidates() {
  return [
    ...resourcesBins(),
    BUNDLED_BIN, VENDOR_BIN,
    VENDOR_LEGACY_BIN, BUNDLED_LEGACY_BIN,
    "sing-box",
  ];
}

/** Первый существующий путь к движку (без проверки запуском) или null. */
function existingEnginePath() {
  for (const c of binCandidates()) {
    if (c === "sing-box") continue;
    try { if (fs.existsSync(c)) return c; } catch { /* путь недоступен */ }
  }
  return null;
}

let detectCache = null;
let detectAt = 0;

function runEngineVersion(bin) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile(bin, ["version"], { timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024 }, (e, o) => {
      resolve(e ? null : (String(o || "").split(/[\r\n]+/)[0] || "unknown"));
    });
  });
}

/** Поиск рабочего движка (кэш 12 c). → { found, path, version } */
async function detectEngine({ force = false } = {}) {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;
  let res = { found: false, path: null, version: null };
  for (const c of binCandidates()) {
    if (c.includes("/") || c.includes("\\")) { if (!fs.existsSync(c)) continue; }
    const v = await runEngineVersion(c);
    if (v) { res = { found: true, path: c, version: v }; break; }
  }
  detectCache = res; detectAt = now;
  return res;
}

let installState = { state: "idle", progress: 0, phase: "", error: "" };

function installStatus() {
  // Полный список проверенных путей: если движка нет, UI показывает, где искали,
  // а не просто «не найден» (по этому списку сразу видно, чего не хватает).
  const candidates = binCandidates()
    .filter((c) => c !== "sing-box")
    .map((p) => ({ path: p, exists: fileExists(p) }));
  const found = candidates.find((c) => c.exists);
  return { ...installState, installed: !!found, path: found ? found.path : null, candidates };
}

/** existsSync без исключений (битый/недоступный путь не должен ронять статус). */
function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Скачивание и распаковка sing-box в пользовательский каталог (storage/proxyCore). */
async function installEngine() {
  if (installState.state === "working") return installStatus();
  // Движок уже есть (комплект инсталлятора / storage / PATH) — качать нечего.
  const already = await detectEngine({ force: true });
  if (already.found) {
    installState = { state: "done", progress: 100, phase: "bundled", error: "" };
    return installStatus();
  }
  installState = { state: "working", progress: 0, phase: "download", error: "" };
  fs.mkdirSync(CORE_DIR, { recursive: true });
  // Хвосты прошлой неудачной попытки: иначе распаковка может взять старый архив.
  try { fs.rmSync(path.join(CORE_DIR, "engine.zip"), { force: true }); } catch { /* нет файла */ }
  try { fs.rmSync(path.join(CORE_DIR, "_tmp_extract"), { recursive: true, force: true }); } catch { /* нет каталога */ }
  try {
    installState.phase = "download";
    const res = await fetch(ENGINE_URL, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    const zipPath = path.join(CORE_DIR, "engine.zip");
    let rcvd = 0;
    const ws = fs.createWriteStream(zipPath);
    ws.on("error", () => {});
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rcvd += buf.length;
      installState.progress = declared ? Math.min(100, Math.round((100 * rcvd) / declared)) : 0;
      if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));

    installState.phase = "extract";
    installState.progress = 0;
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zipPath);
    const tmpDir = path.join(CORE_DIR, "_tmp_extract");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);
    const findExe = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (findExe(p)) return true; }
        else if (e.name.toLowerCase() === "sing-box.exe") { fs.copyFileSync(p, BUNDLED_BIN); return true; }
      }
      return false;
    };
    if (!findExe(tmpDir)) throw new Error("sing-box.exe not found after extraction");
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    detectCache = null;
    installState = { state: "done", progress: 100, phase: "", error: "" };
    logger.info("proxyCore.install.done", { path: BUNDLED_BIN });
  } catch (e) {
    // GitHub может быть недоступен (блокировка, нет сети) — если движок уже есть
    // в комплекте, честнее им и воспользоваться, чем показывать ошибку.
    const fallback = existingEnginePath();
    if (fallback) {
      detectCache = null;
      installState = { state: "done", progress: 100, phase: "bundled", error: "" };
      logger.warn("proxyCore.install.fallback", { path: fallback, error: e.message });
    } else {
      // Код вместо сырого текста — UI переводит его (proxy.installFailed).
      installState = { state: "error", progress: 0, phase: "", error: "download_failed", errorDetail: e.message };
      logger.error("proxyCore.install.error", { error: e.message });
    }
  }
  return installStatus();
}

// --- Запуск / остановка процесса ---

// Единственный активный процесс ядра. Состояние намеренно не персистится:
// после рестарта приложения прокси всегда выключен.
let CORE = {
  running: false,
  enabled: false,
  child: null,
  node: null,
  socksPort: DEFAULT_SOCKS_PORT,
  httpPort: DEFAULT_HTTP_PORT,
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
    node: CORE.node ? { protocol: CORE.node.protocol, tag: CORE.node.tag, server: CORE.node.server, port: CORE.node.port } : null,
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
async function startCore(input, opts = {}) {
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
  try { require("./proxy").stopProxy(); } catch { /* legacy не загружен */ }

  const cfg = buildSingBoxConfig(node, { socksPort: opts.socksPort, httpPort: opts.httpPort });
  if (!cfg) {
    // Явно различаем «протокол не наш» и «транспорт не умеет движок» (xhttp и т.п.):
    // иначе пользователь видит только непонятную ошибку соединения.
    const why = isNodeSupported(node) ? "Unsupported protocol: " + node.protocol
      : `unsupported_transport:${node.network || node.protocol}`;
    CORE = { ...CORE, running: false, enabled: false, error: why };
    return getCoreStatus();
  }

  const cfgDir = path.join(CORE_DIR, "configs");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, "core.json");
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
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
    running: false, enabled: false, child, node,
    socksPort, httpPort,
    error: "", childPid: child.pid,
  };

  // Логи копим только для диагностики ошибок: sing-box при warn-уровне молчит,
  // поэтому по ним НЕЛЬЗЯ судить об успехе (в старой версии строка про
  // "inbound ... bind: address already in use" принималась за успешный старт).
  let logTail = "";
  const collect = (d) => { logTail = (logTail + d.toString()).slice(-4000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (e) => {
    if (CORE.child === child) CORE = { ...CORE, running: false, enabled: false, error: e.message };
  });
  child.on("close", (code) => {
    if (CORE.child !== child) return; // процесс заменён другим запуском/остановкой
    CORE = {
      ...CORE,
      running: false, enabled: false, child: null, childPid: null,
      error: CORE.error || (logTail.trim().slice(-300) || `sing-box exited with code ${code}`),
    };
    clearCorePid();
  });

  logger.info("proxyCore.start", { protocol: node.protocol, pid: child.pid });
  writeCorePid(child.pid);

  // Ждём реального старта, чтобы ответ API отражал правду, а не «спавнится».
  const ready = await waitCoreReady(child, socksPort, 8000);
  if (ready.ok) {
    CORE = { ...CORE, running: true, enabled: true, error: "" };
    logger.info("proxyCore.ready", { pid: child.pid, socksPort, ms: 0 });
  } else if (CORE.child === child) {
    CORE = {
      ...CORE,
      running: false, enabled: false,
      error: ready.reason === "exited"
        ? (logTail.trim().slice(-300) || `sing-box exited with code ${child.exitCode}`)
        : "core_start_timeout",
    };
    if (child.exitCode == null) await stopChild(child);
    logger.warn("proxyCore.notReady", { reason: ready.reason, log: logTail.slice(-300) });
  }
  return getCoreStatus();
}

// --- Реальный пинг через локальный SOCKS5 (TTFB) ---

// socks-proxy-agent — ESM, грузим динамически (как в server/proxy.js).
async function getSocksAgent() {
  const mod = await import("socks-proxy-agent");
  return mod.SocksProxyAgent;
}

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
async function requestThroughProxyOn(socksPort, url, opts = {}) {
  const Agent = await getSocksAgent();
  const agent = new Agent(`socks5://${PROXY_HOST}:${socksPort}`);
  const u = new URL(url);
  const mod = u.protocol === "https:" ? require("https") : require("http");
  return new Promise((resolve) => {
    const started = Date.now();
    const limitMs = opts.timeout || 3000;
    let done = false;
    let hard = null;
    let req = null;
    const finish = (r) => {
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
      try { if (req) req.destroy(); } catch { /* ignore */ }
      finish({ ok: false, status: 0, ttfbMs: null, body: "", error: "timeout" });
    }, limitMs);
    req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: opts.headers || { "User-Agent": "Mozilla/5.0" },
      agent,
    }, (res) => {
      const ttfbMs = Date.now() - started; // заголовки пришли → это и есть TTFB
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ttfbMs, body, error: "" }));
    });
    req.setTimeout(limitMs, () => {
      try { req.destroy(); } catch { /* ignore */ }
      finish({ ok: false, status: 0, ttfbMs: null, body: "", error: "timeout" });
    });
    req.on("error", (e) => finish({ ok: false, status: 0, ttfbMs: null, body: "", error: e.message }));
    req.end();
  });
}

/** Запрос через активное ядро (порт берётся из его состояния). */
function requestThroughProxy(url, opts = {}) {
  return requestThroughProxyOn(CORE.socksPort, url, opts);
}

// --- Пинг отдельного узла (для «пропинговать все») ---

// Отдельные порты: пинг не должен занимать порты активного прокси (10808/10809).
// Диапазоны SOCKS и HTTP НЕ пересекаются, а между пингами порты ротируются:
// иначе «залипший» слушатель от прошлого узла заставил бы измерить следующий узел
// через чужое ядро (результаты пинга тогда не соответствуют узлам).
const PING_SOCKS_PORT = 10818;
const PING_HTTP_PORT = 10918;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Цели для пинга. Их НЕСКОЛЬКО намеренно: часть рабочих узлов не ходит в Google
 * (география/DNS/фильтры), и единственная цель давала ложные «блок».
 */
const PING_TARGETS = [
  "https://www.google.com/generate_204",
  "https://cp.cloudflare.com/generate_204",
  "https://www.gstatic.com/generate_204",
];

/** Стандартный бюджет одного узла: ОДИН запрос на 2.5 с ловил только ближние
 *  узлы (первое подключение через свежее ядро = DNS + TCP + TLS + reality). */
const PING_DEFAULT_TIMEOUT = 6000;
const PING_TOTAL_BUDGET = 15000;

/** Открыт ли TCP-порт (по умолчанию — локальный хост). */
function isPortOpen(port, timeoutMs = 400, host = PROXY_HOST) {
  return new Promise((resolve) => {
    const net = require("net");
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Быстрая проверка доступности сервера узла (TCP). Ложное «нет» исключено:
 *  если TCP до узла не открывается, sing-box тоже не подключится. */
function canConnectTo(host, port, timeoutMs = 2500) {
  return isPortOpen(Number(port), timeoutMs, host);
}

/**
 * Ждём готовности ядра: пока не откроется SOCKS-порт.
 *
 * Почему не по логам: при `log.level = "warn"` sing-box не пишет вообще ничего,
 * поэтому определять запуск по тексту stderr нельзя — именно из-за этого ядро
 * работало, а приложение показывало «ничего не произошло». Открытый порт —
 * объективный признак, он же снимает путаницу «ошибка поиска inbound» = «старт».
 */
async function waitCoreReady(child, socksPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ok: false, reason: "exited" };
    if (await isPortOpen(socksPort)) return { ok: true, reason: "" };
    await sleep(100);
  }
  return { ok: false, reason: "timeout" };
}

/** Дождаться освобождения порта (после гашения прошлого процесса). */
async function waitPortFree(port, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(100);
  }
  return !(await isPortOpen(port));
}

/** Диагностика фаз пинга (включается MOONAPP_PING_DEBUG=1). */
function pingDebug(label, extra) {
  if (process.env.MOONAPP_PING_DEBUG) {
    try { console.error(`[pingNode] ${label}${extra ? " " + JSON.stringify(extra) : ""}`); } catch { /* ignore */ }
  }
}

/**
 * Реальный пинг ОДНОГО узла: поднимаем временное ядро на свободных портах,
 * ждём первый успешный TTFB (это и есть задержка канала) и гасим его.
 *
 * Активное ядро не трогаем вообще — иначе «пропинговать все» рвало бы текущее
 * соединение пользователя.
 */
async function pingNode(node, opts = {}) {
  const timeout = Number(opts.timeout) || PING_DEFAULT_TIMEOUT;
  const tcpCheck = opts.tcpCheck !== false;
  // Порты по умолчанию подбираются динамически (ротация + пропуск занятых).
  const ports = (opts.socksPort != null && opts.httpPort != null)
    ? { socksPort: opts.socksPort, httpPort: opts.httpPort }
    : await pickPingPorts();
  const { socksPort, httpPort } = ports;
  const tStart = Date.now();
  const engine = await detectEngine();
  if (!engine.found) return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "engine_missing" };
  pingDebug("engine", { ms: Date.now() - tStart, path: engine.path });

  // Транспорт, который движок не умеет (xhttp/kcp) — сразу честная причина,
  // а не «timeout» после запуска ядра.
  if (!isNodeSupported(node)) {
    return { ok: false, state: "blocked", ttfbMs: null, country: null, error: `unsupported_transport:${node.network || node.protocol}` };
  }

  // Быстрый фильтр: если TCP до сервера узла не открывается, sing-box всё равно
  // не подключится. Не тратим секунды на запуск ядра ради заведомо мёртвого узла.
  if (tcpCheck) {
    const up = await canConnectTo(node.server, node.port, Math.min(2500, timeout));
    pingDebug("tcp", { ms: Date.now() - tStart, up });
    if (!up) return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "unreachable" };
  }

  const cfg = buildSingBoxConfig(node, { socksPort, httpPort });
  if (!cfg) return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "unsupported_protocol" };

  const cfgDir = path.join(CORE_DIR, "configs");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, `ping-${process.pid}-${Date.now().toString(36)}.json`);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    return { ok: false, state: "blocked", ttfbMs: null, country: null, error: "config_write_failed: " + e.message };
  }

  let child = null;
  try {
    child = spawn(engine.path, ["run", "-c", cfgPath, "--disable-color"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnErr = "";
    child.on("error", (e) => { spawnErr = e.message; });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});

    // Фаза 1: ждём, пока ядро откроет SOCKS-порт. Это дешёвый TCP-коннект, а не
    // проба через прокси: иначе «мёртвый» узел заставлял бы ждать полный таймаут.
    const ready = await waitPortReady(socksPort, () => ({ spawned: child != null, exitCode: child.exitCode, spawnErr }), 5000);
    pingDebug("ready", { ms: Date.now() - tStart, ok: ready.ok, error: ready.error });
    if (!ready.ok) {
      return { ok: false, state: "blocked", ttfbMs: null, country: null, error: ready.error };
    }

    // Фаза 2: замер. Перебираем цели и делаем повторы: первое подключение через
    // только что поднятое ядро часто не успевает (DNS + TCP + TLS/REALITY), а
    // одиночная попытка на 2.5 с отбрасывала рабочие дальние узлы.
    const targets = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : PING_TARGETS;
    const deadline = Date.now() + PING_TOTAL_BUDGET;
    let lastErr = "timeout";
    for (const target of targets) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await requestThroughProxyOn(socksPort, target, { timeout });
        pingDebug("ttfb", { ms: Date.now() - tStart, target, attempt, ok: r.ok, status: r.status, error: r.error, ttfbMs: r.ttfbMs });
        if (r.ok && r.status < 400) {
          const state = classifyLatency(true, r.ttfbMs);
          return { ok: true, state, ttfbMs: r.ttfbMs, country: await bestEffortCountry(socksPort), error: "" };
        }
        lastErr = r.error || `HTTP ${r.status}`;
        if (Date.now() > deadline) return { ok: false, state: "blocked", ttfbMs: null, country: null, error: lastErr };
        await sleep(250);
      }
    }
    return { ok: false, state: "blocked", ttfbMs: null, country: null, error: lastErr };
  } finally {
    const tStop = Date.now();
    await stopChild(child);
    pingDebug("stopped", { ms: Date.now() - tStop, totalMs: Date.now() - tStart });
    try { fs.rmSync(cfgPath, { force: true }); } catch { /* уже удалён */ }
  }
}

/** Страна выхода — best-effort: не влияет на результат пинга. */
async function bestEffortCountry(socksPort) {
  try {
    const info = await requestThroughProxyOn(socksPort, IPINFO_URL, { timeout: 2000 });
    if (info.ok && info.body) return JSON.parse(info.body).country || null;
  } catch { /* страна необязательна */ }
  return null;
}

/**
 * Ждём открытия SOCKS-порта временного ядра (TCP-connect, без трафика).
 * Выходим сразу, если процесс упал — иначе висели бы весь таймаут.
 */
async function waitPortReady(port, childState, timeoutMs) {
  const net = require("net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = childState();
    if (st.spawnErr) return { ok: false, error: st.spawnErr };
    if (st.exitCode != null) return { ok: false, error: `core_exited_${st.exitCode}` };
    const connected = await new Promise((resolve) => {
      const sock = net.connect({ host: PROXY_HOST, port });
      const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
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
async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(done, 1200);
    child.once("close", done);
    try { child.kill(); } catch { done(); }
  });
  // Не вышел за отведённое время — добиваем принудительно, иначе процесс
  // останется висеть и займёт SOCKS-порт для следующего узла.
  if (child.exitCode == null) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
    await sleep(200);
  }
}

// --- Защита от «зависшего» ядра прошлого запуска ---
// Если приложение упало/было убито, sing-box мог остаться жить и держать порт.
// Тогда следующее включение прокси молча не работало. Свой PID пишем в файл,
// чтобы при следующем старте прибить ИМЕННО свой (чужой sing-box не трогаем).
const CORE_PID_FILE = path.join(CORE_DIR, "core.pid");

function writeCorePid(pid) {
  try { fs.writeFileSync(CORE_PID_FILE, String(pid), "utf8"); } catch { /* не критично */ }
}
function clearCorePid() {
  try { fs.rmSync(CORE_PID_FILE, { force: true }); } catch { /* уже удалён */ }
}

/** Прибить осиротевший процесс ядра от прошлого запуска приложения. */
function killStaleCoreProcess() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(CORE_PID_FILE, "utf8").trim()); } catch { pid = 0; }
  if (pid > 0) {
    try {
      process.kill(pid, 0); // процесс ещё жив?
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      logger.warn("proxyCore.stale.killed", { pid });
    } catch { /* процесса уже нет — это норма */ }
  }
  clearCorePid();
}

/** Классификация: online (<300ms) | degraded (>300ms) | blocked (ошибка/таймаут). */
function classifyLatency(ok, ttfbMs) {
  if (!ok || ttfbMs == null) return "blocked";
  return ttfbMs <= 300 ? "online" : "degraded";
}

/**
 * Полная проверка активного ядра: реальные HTTP-запросы через SOCKS5,
 * TTFB, классификация и фактический выходной IP/страна/ISP через ipinfo.io.
 */
async function testLatency({ timeout = 3000 } = {}) {
  if (!CORE.running || !CORE.enabled) {
    return { state: "offline", error: "Not running", latencyMs: null, targets: [], ip: null, country: null, isp: null };
  }
  const results = [];
  let best = null;
  for (const t of LATENCY_TARGETS) {
    const r = await requestThroughProxy(t.url, { timeout });
    const state = classifyLatency(r.ok && (t.expect ? r.status === t.expect : true), r.ttfbMs);
    results.push({ url: t.url, state, status: r.status, ttfbMs: r.ttfbMs, error: r.error });
    if (state !== "blocked" && (best == null || r.ttfbMs < best)) best = r.ttfbMs;
  }
  let ip = null, country = null, isp = null;
  try {
    const info = await requestThroughProxy(IPINFO_URL, { timeout });
    if (info.ok && info.body) {
      const d = JSON.parse(info.body);
      ip = d.ip || null; country = d.country || null; isp = d.org || null;
      results.push({ url: IPINFO_URL, state: classifyLatency(true, info.ttfbMs), status: info.status, ttfbMs: info.ttfbMs, error: "" });
    }
  } catch { /* ipinfo не обязателен */ }

  const state = best == null ? "blocked" : (best <= 300 ? "online" : "degraded");
  const node = CORE.node;
  if (node) node.country = country;
  return { state, latencyMs: best, targets: results, ip, country, isp };
}

/** GET текста: через ядро, если оно активно, иначе напрямую. Нужен для подписок. */
async function fetchText(url, { timeout = 15000 } = {}) {
  if (CORE.running && CORE.enabled) {
    const r = await requestThroughProxy(url, { timeout, headers: { "User-Agent": "MoonApp" } });
    if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
    return r.body;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "MoonApp" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

module.exports = {
  // константы
  ENGINE_ID, ENGINE_VER, ENGINE_URL, SUPPORTED_PROTOCOLS,
  DEFAULT_SOCKS_PORT, DEFAULT_HTTP_PORT,
  // разбор
  parseUri, parseSubscription,
  // генерация конфига
  buildOutbound, buildSingBoxConfig,
  // движок
  detectEngine, installEngine, installStatus,
  // процесс
  startCore, stopCore, getCoreStatus, getCoreProxyUrl, getCoreHttpProxyUrl,
  // пинг/сеть
  testLatency, classifyLatency, requestThroughProxy, requestThroughProxyOn, fetchText,
  pingNode, PING_SOCKS_PORT, PING_HTTP_PORT, PING_TARGETS, PING_DEFAULT_TIMEOUT,
  // Экспортируем часть внутренних помощников для тестов запуска ядра:
  // isPortOpen — проверка готовности/занятости порта, stopChild — гарантированный стоп,
  // canConnectTo — быстрый TCP-фильтр узла.
  isPortOpen, stopChild, canConnectTo,
  // импорт JSON-конфигов
  isNodeSupported, SUPPORTED_TRANSPORTS, nodeFromJsonOutbound, nodeFromXrayOutbound, nodeFromSingBoxOutbound,
};
