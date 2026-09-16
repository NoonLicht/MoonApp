import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

// Изолируем storage для тестов (как в tests/bypass.test.ts).
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-proxycore-"));
});

const VLESS =
  "vless://3ebae9d2-bd2b-4582-98cc-39ae43161937@217.69.167.94:43000" +
  "?flow=xtls-rprx-vision&encryption=none&security=reality&fp=chrome" +
  "&pbk=Xz8YkyWe2RC7jeze47EjerXXdEKiJ38OGR8kW9VLdS8&sid=58c837b6&spx=%2F&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20NL";
const TROJAN = "trojan://pass123@example.com:443?sni=example.com&type=ws&path=%2Fws#TR";
const HY2 = "hysteria2://secret@1.2.3.4:8443?sni=bing.com&obfs=salamander&obfs-password=abc#HY2";
const TUIC =
  "tuic://11111111-2222-3333-4444-555555555555:pass@5.6.7.8:443?congestion_control=bbr&sni=x.com#TUIC";
const SS = "ss://YWVzLTI1Ni1nY206cGFzcw==@9.9.9.9:8388#SS"; // aes-256-gcm:pass
const SSH = "ssh://root:toor@10.0.0.1:22#SSH";
const VMESS =
  "vmess://" +
  Buffer.from(
    JSON.stringify({
      v: "2",
      ps: "VM",
      add: "2.2.2.2",
      port: "443",
      id: "11111111-2222-3333-4444-555555555555",
      aid: "0",
      scy: "auto",
      net: "ws",
      host: "a.com",
      path: "/p",
      tls: "tls",
      sni: "a.com",
    }),
  ).toString("base64");

async function core() {
  return await import("../server/proxyCore");
}

describe("proxyCore — разбор ссылок", () => {
  it("разбирает VLESS+Reality", async () => {
    const c = await core();
    const n = c.parseUri(VLESS);
    expect(n).toBeTruthy();
    expect(n.protocol).toBe("vless");
    expect(n.server).toBe("217.69.167.94");
    expect(n.port).toBe(43000);
    expect(n.flow).toBe("xtls-rprx-vision");
    expect(n.security).toBe("reality");
    expect(n.fp).toBe("chrome");
    expect(n.pbk).toHaveLength(43);
    expect(n.sid).toBe("58c837b6");
    expect(n.tag).toContain("NL");
  });

  it("разбирает VMess (base64 JSON)", async () => {
    const c = await core();
    const n = c.parseUri(VMESS);
    expect(n.protocol).toBe("vmess");
    expect(n.server).toBe("2.2.2.2");
    expect(n.network).toBe("ws");
    expect(n.security).toBe("tls");
  });

  it("разбирает Trojan/Hysteria2/TUIC/Shadowsocks/SSH", async () => {
    const c = await core();
    expect(c.parseUri(TROJAN)).toMatchObject({
      protocol: "trojan",
      server: "example.com",
      port: 443,
      network: "ws",
    });
    expect(c.parseUri(HY2)).toMatchObject({
      protocol: "hysteria2",
      obfs: "salamander",
      obfsPassword: "abc",
    });
    expect(c.parseUri(TUIC)).toMatchObject({ protocol: "tuic", congestionControl: "bbr" });
    expect(c.parseUri(SS)).toMatchObject({
      protocol: "shadowsocks",
      method: "aes-256-gcm",
      password: "pass",
    });
    expect(c.parseUri(SSH)).toMatchObject({ protocol: "ssh", user: "root", password: "toor" });
  });

  it("возвращает null на мусор и неподдержанные схемы", async () => {
    const c = await core();
    expect(c.parseUri("ftp://nope")).toBeNull();
    expect(c.parseUri("random text")).toBeNull();
    expect(c.parseUri("")).toBeNull();
    expect(c.parseUri("vless://no-at-sign")).toBeNull();
  });
});

describe("proxyCore — подписки", () => {
  it("декодирует base64-подписку в список узлов", async () => {
    const c = await core();
    const sub = Buffer.from([VLESS, TROJAN, HY2].join("\n")).toString("base64");
    const r = c.parseSubscription(sub);
    expect(r.format).toBe("uri");
    expect(r.decoded).toBe(true);
    expect(r.nodes.map((n) => n.protocol)).toEqual(["vless", "trojan", "hysteria2"]);
  });

  it("распознаёт sing-box конфиг как format=json", async () => {
    const c = await core();
    const cfg = { outbounds: [{ type: "direct", tag: "direct" }] };
    const r = c.parseSubscription(JSON.stringify(cfg));
    expect(r.format).toBe("json");
    expect(r.config).toEqual(cfg);
  });

  it("список URI по строкам тоже работает", async () => {
    const c = await core();
    expect(c.parseSubscription(VLESS + "\n" + TROJAN).nodes).toHaveLength(2);
  });
});

describe("proxyCore — генерация конфига sing-box", () => {
  it("поднимает socks5 + http inbound на локалхосте", async () => {
    const c = await core();
    const cfg = c.buildSingBoxConfig(c.parseUri(VLESS));
    expect(cfg.inbounds.map((i) => i.type)).toEqual(["socks", "http"]);
    expect(cfg.inbounds.every((i) => i.listen === "127.0.0.1")).toBe(true);
    expect(cfg.outbounds.map((o) => o.type)).toEqual(["vless", "direct"]);
    // приватные адреса не идут в прокси
    expect(cfg.route.rules[0]).toMatchObject({ outbound: "direct", ip_is_private: true });
  });

  it("гасит недопустимый Xray-флоу (кроме vision) и включает reality", async () => {
    const c = await core();
    const legacy = c.parseUri(VLESS.replace("xtls-rprx-vision", "xtls-rprx-direct"));
    const cfgDirect = c.buildSingBoxConfig(legacy);
    expect(cfgDirect.outbounds[0].flow).toBe("");
    // reality-флоу с xtls всё равно включает TLS
    expect(cfgDirect.outbounds[0].tls).toBeTruthy();
    expect(cfgDirect.outbounds[0].tls.reality.public_key).toHaveLength(43);
  });

  it("пробрасывает transport для ws/grpc и параметры протоколов", async () => {
    const c = await core();
    const ws = c.buildSingBoxConfig(c.parseUri(TROJAN)).outbounds[0];
    expect(ws.transport).toMatchObject({ type: "ws", path: "/ws" });
    const hy2 = c.buildSingBoxConfig(c.parseUri(HY2)).outbounds[0];
    expect(hy2.tls).toMatchObject({ enabled: true, server_name: "bing.com" });
    expect(hy2.obfs).toEqual({ type: "salamander", password: "abc" });
    const ssh = c.buildSingBoxConfig(c.parseUri(SSH)).outbounds[0];
    expect(ssh).toMatchObject({ type: "ssh", user: "root", password: "toor" });
  });

  it("неизвестный узел → null", async () => {
    const c = await core();
    expect(c.buildSingBoxConfig(null)).toBeNull();
    expect(c.buildOutbound({ protocol: "wireguard", server: "x", port: 1 })).toBeNull();
  });
});

describe("proxyCore — классификация задержки (TTFB)", () => {
  it("online при <300ms, degraded выше, blocked без ответа", async () => {
    const c = await core();
    expect(c.classifyLatency(true, 120)).toBe("online");
    expect(c.classifyLatency(true, 300)).toBe("online");
    expect(c.classifyLatency(true, 301)).toBe("degraded");
    expect(c.classifyLatency(true, 1500)).toBe("degraded");
    expect(c.classifyLatency(false, null)).toBe("blocked");
    expect(c.classifyLatency(true, null)).toBe("blocked");
    expect(c.classifyLatency(false, 50)).toBe("blocked");
  });

  it("testLatency без запущенного ядра → offline", async () => {
    const c = await core();
    const r = await c.testLatency();
    expect(r.state).toBe("offline");
    expect(r.latencyMs).toBeNull();
    expect(r.targets).toEqual([]);
  });
});
