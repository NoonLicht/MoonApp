/**
 * Выделено из proxyCore.ts при разбиении крупного файла (поведение не менялось).
 */
import { SUPPORTED_PROTOCOLS } from "./proxyUri";
import { DEFAULT_HTTP_PORT, DEFAULT_SOCKS_PORT, PROXY_HOST } from "./proxyCore";

// --- TLS-хелпер (общий для tls/reality-протоколов) ---

function tlsBlock(node: any) {
  const tls: Record<string, any> = { enabled: true };
  if (node.sni) tls.server_name = node.sni;
  if (node.alpn)
    tls.alpn = String(node.alpn)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  if (node.insecure) tls.insecure = true;
  if (node.fp) tls.utls = { enabled: true, fingerprint: node.fp || "chrome" };
  if (node.security === "reality" || node.pbk) {
    tls.reality = { enabled: true, public_key: node.pbk || "", short_id: node.sid || "" };
  }
  return tls;
}

/** Транспорты, которые умеет движок (sing-box). xhttp/kcp он НЕ поддерживает —
 *  такие узлы импортируем, но помечаем как неподдерживаемые, чтобы UI не врал. */
export const SUPPORTED_TRANSPORTS = ["", "tcp", "ws", "grpc", "http", "h2", "httpupgrade", "quic"];

/** Поддерживает ли движок этот узел (протокол + транспорт). */
export function isNodeSupported(node: any) {
  if (!node || !SUPPORTED_PROTOCOLS.includes(node.protocol)) return false;
  return SUPPORTED_TRANSPORTS.includes(String(node.network || "").toLowerCase());
}

/** Транспорт (network/path/host) → sing-box transport-блок или undefined. */
function transportBlock(node: any) {
  const net = String(node.network || "").toLowerCase();
  if (net === "ws") {
    return {
      type: "ws",
      path: node.path || "/",
      headers: node.host ? { Host: node.host } : undefined,
    };
  }
  if (net === "grpc") return { type: "grpc", service_name: node.serviceName || "" };
  if (net === "quic") return { type: "quic" };
  if (net === "httpupgrade")
    return { type: "httpupgrade", host: node.host || undefined, path: node.path || "/" };
  if (net === "http" || net === "h2") {
    return { type: "http", host: node.host ? [node.host] : undefined, path: node.path || "/" };
  }
  return undefined;
}

// --- Импорт JSON-конфигов (Xray/V2Ray и sing-box) ---

/** Осмысленное имя узла: generic-теги («proxy», «proxy-2») заменяем адресом. */
function pickTag(tag: any, address: any) {
  const t = String(tag || "").trim();
  if (!t) return address || "";
  if (/^(proxy|out|outbound|node|vless|vmess|trojan|ss|shadowsocks|direct|block)(-\d+)?$/i.test(t))
    return address || t;
  return t;
}

/** Транспорт + TLS из streamSettings (формат Xray/V2Ray) → поля нашего узла. */
function fromXrayStream(stream: any) {
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
export function nodeFromXrayOutbound(ob: any) {
  const proto = String(ob.protocol || "").toLowerCase();
  const settings = ob.settings || {};
  const stream = fromXrayStream(ob.streamSettings);
  const base = { protocol: proto, ...stream };

  if (proto === "vless" || proto === "vmess") {
    const v = (settings.vnext || [])[0] || {};
    const u = (v.users || [])[0] || {};
    if (!v.address) return null;
    const node: Record<string, any> = {
      ...base,
      server: v.address,
      port: Number(v.port),
      uuid: u.id || "",
      tag: pickTag(ob.tag, v.address),
    };
    if (proto === "vless") node.flow = u.flow || "";
    else {
      node.alterId = Number(u.alterId) || 0;
      node.cipher = u.security || "auto";
    }
    return node.server && Number.isFinite(node.port) ? node : null;
  }
  if (proto === "trojan" || proto === "shadowsocks") {
    const s0 = (settings.servers || [])[0] || {};
    if (!s0.address) return null;
    const node: Record<string, any> = {
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
export function nodeFromSingBoxOutbound(ob: any) {
  const type = String(ob.type || "").toLowerCase();
  if (!["vless", "vmess", "trojan", "hysteria2", "tuic", "shadowsocks", "ssh"].includes(type))
    return null;
  const tls = ob.tls || {};
  const tr = ob.transport || {};
  const reality = tls.reality || {};
  const utls = tls.utls || {};
  const headers = tr.headers || {};
  const host = tr.host || headers.Host || headers.host || "";
  const node: Record<string, any> = {
    protocol: type,
    server: ob.server,
    port: Number(ob.server_port),
    tag: pickTag(ob.tag, ob.server),
    network: tr.type ? String(tr.type).toLowerCase() : "",
    security: reality.enabled ? "reality" : tls.enabled ? "tls" : "none",
    sni: tls.server_name || "",
    fp: utls.fingerprint || "",
    pbk: reality.public_key || "",
    sid: reality.short_id || "",
    alpn: Array.isArray(tls.alpn) ? tls.alpn.join(",") : "",
    insecure: !!tls.insecure,
    path: tr.path || "",
    host: Array.isArray(host) ? host[0] || "" : host,
    serviceName: tr.service_name || "",
  };
  if (type === "vless") {
    node.uuid = ob.uuid || "";
    node.flow = ob.flow || "";
  }
  if (type === "vmess") {
    node.uuid = ob.uuid || "";
    node.alterId = ob.alter_id || 0;
    node.cipher = ob.security || "auto";
  }
  if (type === "trojan" || type === "hysteria2" || type === "shadowsocks")
    node.password = ob.password || "";
  if (type === "shadowsocks") node.method = ob.method || "";
  if (type === "tuic") {
    node.uuid = ob.uuid || "";
    node.password = ob.password || "";
  }
  if (type === "ssh") node.user = ob.user || "";
  if (type === "hysteria2" && ob.obfs) {
    node.obfs = ob.obfs.type || "";
    node.obfsPassword = ob.obfs.password || "";
  }
  return node.server && Number.isFinite(node.port) ? node : null;
}

/** Outbound из JSON любого формата → узел. Формат определяется по полям. */
export function nodeFromJsonOutbound(ob: any) {
  if (!ob || typeof ob !== "object") return null;
  if (ob.protocol) return nodeFromXrayOutbound(ob);
  if (ob.type) return nodeFromSingBoxOutbound(ob);
  return null;
}

// --- Генерация outbound ---

/** Узел → sing-box outbound-объект. Неизвестный протокол → null. */
export function buildOutbound(node: any, tag = "proxy") {
  if (!node || !node.server || !Number.isFinite(Number(node.port))) return null;
  const server = node.server;
  const server_port = Number(node.port);
  const base = { tag, server, server_port };
  const transport = transportBlock(node);

  switch (node.protocol) {
    case "vless": {
      // sing-box умеет только xtls-rprx-vision; прочие xtls-флоу недопустимы.
      const rawFlow = node.flow || "";
      const flow =
        rawFlow === "xtls-rprx-vision" ? rawFlow : rawFlow.startsWith("xtls-rprx-") ? "" : rawFlow;
      const ob: Record<string, any> = {
        type: "vless",
        ...base,
        uuid: node.uuid,
        flow,
        packet_encoding: "xudp",
      };
      if (transport) ob.transport = transport;
      if (node.security === "tls" || node.security === "reality" || rawFlow.startsWith("xtls-"))
        ob.tls = tlsBlock(node);
      return ob;
    }
    case "vmess": {
      const ob: Record<string, any> = {
        type: "vmess",
        ...base,
        uuid: node.uuid,
        security: node.cipher || "auto",
        alter_id: node.alterId || 0,
      };
      if (transport) ob.transport = transport;
      if (node.security === "tls") ob.tls = tlsBlock(node);
      return ob;
    }
    case "trojan": {
      const ob: Record<string, any> = { type: "trojan", ...base, password: node.password };
      if (transport) ob.transport = transport;
      if (node.security !== "none") ob.tls = tlsBlock(node);
      return ob;
    }
    case "hysteria2": {
      const ob: Record<string, any> = {
        type: "hysteria2",
        ...base,
        password: node.password,
        tls: tlsBlock(node),
      };
      if (node.obfs) ob.obfs = { type: node.obfs, password: node.obfsPassword || "" };
      return ob;
    }
    case "tuic": {
      return {
        type: "tuic",
        ...base,
        uuid: node.uuid,
        password: node.password,
        congestion_control: node.congestionControl || "bbr",
        udp_relay_mode: node.udpRelayMode || "native",
        tls: tlsBlock(node),
      };
    }
    case "shadowsocks": {
      return { type: "shadowsocks", ...base, method: node.method, password: node.password };
    }
    case "ssh": {
      const ob: Record<string, any> = { type: "ssh", ...base, user: node.user };
      if (node.password) ob.password = node.password;
      return ob;
    }
    default:
      return null;
  }
}

/** Итоговый конфиг sing-box: socks5 + http inbound, один outbound, direct-роут. */
export function buildSingBoxConfig(node: any, opts: Record<string, any> = {}) {
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
