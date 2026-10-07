/**
 * Выделено из proxyCore.ts при разбиении крупного файла (поведение не менялось).
 */
import { nodeFromJsonOutbound } from "./proxyConfig";

export const SUPPORTED_PROTOCOLS = [
  "vless",
  "vmess",
  "trojan",
  "hysteria2",
  "tuic",
  "shadowsocks",
  "ssh",
];

// --- Общие хелперы разбора ---

/** Безопасный decodeURIComponent: битая последовательность не роняет разбор. */
function dec(s: any) {
  try {
    return decodeURIComponent(String(s == null ? "" : s));
  } catch {
    return String(s == null ? "" : s);
  }
}

/** Разбор query-строки в объект (значения декодируются). */
function parseQuery(qs: any) {
  const out: Record<string, any> = {};
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
function truthy(v: any) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
}

/** Base64 → utf8 (терпит «URL-safe» алфавит и отсутствие padding). */
function b64decode(input: any) {
  try {
    const s = String(input || "")
      .trim()
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/\s+/g, "");
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** host:port → { server, port }. Поддерживает [ipv6]:port. */
function splitHostPort(hp: any) {
  const s = String(hp || "").trim();
  let server;
  let port;
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
function fragmentTag(str: any, fallback: any) {
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
function splitAuthority(rest: any) {
  const hashIdx = String(rest).indexOf("#");
  const tag = fragmentTag(rest, "");
  const withoutTag = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = withoutTag.indexOf("?");
  const authority = qIdx >= 0 ? withoutTag.slice(0, qIdx) : withoutTag;
  const query = qIdx >= 0 ? withoutTag.slice(qIdx + 1) : "";
  return { authority, query, tag };
}

function parseVless(uri: any) {
  // vless://<uuid>@host:port?params#tag
  const { authority, query, tag } = splitAuthority(uri.slice("vless://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const uuid = dec(authority.slice(0, at));
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!uuid || !server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "vless",
    tag: tag || server,
    uuid,
    server,
    port,
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

function parseVmess(uri: any) {
  // vmess://base64({ v, ps, add, port, id, aid, scy, net, host, path, tls, sni, fp })
  const raw = uri.slice("vmess://".length).trim();
  const text = raw.startsWith("{") ? raw : b64decode(raw);
  if (!text.trim().startsWith("{")) return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const server = String(o.add || o.server || "").trim();
  const port = parseInt(o.port, 10);
  const uuid = String(o.id || o.uuid || "").trim();
  if (!server || !Number.isFinite(port) || !uuid) return null;
  return {
    protocol: "vmess",
    tag: String(o.ps || o.remark || server),
    uuid,
    server,
    port,
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

function parseTrojan(uri: any) {
  // trojan://<password>@host:port?params#tag
  const { authority, query, tag } = splitAuthority(uri.slice("trojan://".length));
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  const password = dec(authority.slice(0, at));
  const { server, port } = splitHostPort(authority.slice(at + 1));
  if (!password || !server || !Number.isFinite(port)) return null;
  const p = parseQuery(query);
  return {
    protocol: "trojan",
    tag: tag || server,
    password,
    server,
    port,
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
function parseHysteria2(uri: any) {
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
    protocol: "hysteria2",
    tag: tag || server,
    password,
    server,
    port,
    sni: p.sni || p.peer || "",
    obfs: p.obfs || "",
    obfsPassword: p["obfs-password"] || "",
    security: "tls",
    alpn: p.alpn || "",
    insecure: truthy(p.insecure || p.allowInsecure),
    params: p,
  };
}

function parseTuic(uri: any) {
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
    protocol: "tuic",
    tag: tag || server,
    uuid,
    password,
    server,
    port,
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
function parseShadowsocks(uri: any) {
  const body = uri.slice("ss://".length);
  const { query, tag } = splitAuthority(body);
  const p = parseQuery(query);

  const hashIdx = body.indexOf("#");
  const withoutTag = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
  const qIdx = withoutTag.indexOf("?");
  const core = qIdx >= 0 ? withoutTag.slice(0, qIdx) : withoutTag;

  let method;
  let password;
  let hostport;

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
    protocol: "shadowsocks",
    tag: tag || server,
    server,
    port,
    method: method.toLowerCase(),
    password,
    params: p,
  };
}

function parseSsh(uri: any) {
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

const PARSERS: Record<string, any> = {
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
export function parseUri(input: any) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = /^([a-z0-9+.-]+):\/\//i.exec(s);
  if (!m) return null;
  const parser = PARSERS[m[1].toLowerCase()];
  if (!parser) return null;
  try {
    const node = parser(s);
    return node && node.server ? node : null;
  } catch {
    return null;
  }
}

/**
 * Разбор подписки: base64 / список URI / JSON-массив / sing-box-конфиг.
 * → { format: "uri"|"json", nodes: [...], config?, raw, decoded? }
 */
export function parseSubscription(input: any) {
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
    } catch {
      /* падаем ниже на base64/URI */
    }
  }

  // 2) base64-подписка (одна большая строка без «://»).
  if (!raw.includes("://")) {
    const decoded = b64decode(raw);
    if (decoded && decoded.includes("://")) {
      return {
        format: "uri",
        nodes: decoded
          .split(/[\r\n]+/)
          .map(parseUri)
          .filter(Boolean),
        raw,
        decoded: true,
      };
    }
    return { format: "uri", nodes: [], raw };
  }

  // 3) Список URI (по строкам или через запятую).
  return {
    format: "uri",
    nodes: raw
      .split(/[\s,]+/)
      .map(parseUri)
      .filter(Boolean),
    raw,
  };
}
