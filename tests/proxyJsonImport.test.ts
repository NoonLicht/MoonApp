import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Импорт JSON-конфигов (Xray/V2Ray `protocol`/`settings`/`streamSettings` и
 * sing-box `type`/`server`/`tls`/`transport`).
 *
 * Регресс: раньше JSON-конфиг импортировался как ПУСТОЙ список узлов
 * (`nodes: []`), т.е. после импорта не появлялось ничего.
 * Фикстуры повторяют реальный экспорт v2rayN (reality + vision, xhttp, grpc).
 */
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-json-"));
});

async function core() {
  return await import("../server/proxyCore");
}

const UUID = "10de7dbf-0235-4930-a20a-31ad4c65e40e";

const vlessOut = (address: string, port: number, flow: string, stream: any) => ({
  protocol: "vless",
  settings: { vnext: [{ address, port, users: [{ encryption: "none", flow, id: UUID }] }] },
  streamSettings: stream,
  tag: "proxy",
});

/** Реальный экспорт Xray/V2Ray (сокращённый до характерных вариантов). */
const XRAY_CONFIG = {
  log: { loglevel: "warning" },
  inbounds: [{ listen: "127.0.0.1", port: 10808, protocol: "socks", settings: {}, tag: "socks" }],
  outbounds: [
    vlessOut("node1.example.com", 443, "xtls-rprx-vision", {
      network: "tcp",
      security: "reality",
      tcpSettings: {},
      realitySettings: {
        fingerprint: "firefox",
        publicKey: "PUBKEY_1",
        serverName: "node1.example.com",
      },
    }),
    vlessOut("node2.example.com", 443, "xtls-rprx-vision", {
      network: "tcp",
      security: "reality",
      tcpSettings: {},
      realitySettings: {
        fingerprint: "safari",
        publicKey: "PUBKEY_2",
        serverName: "node2.example.com",
        shortId: "2ef160ff49f7ea57",
      },
    }),
    vlessOut("node3.example.com", 444, "", {
      network: "xhttp",
      security: "reality",
      realitySettings: {
        fingerprint: "safari",
        publicKey: "PUBKEY_3",
        serverName: "node3.example.com",
        shortId: "34109b0d30255f9e",
      },
      xhttpSettings: { host: "", mode: "packet-up", path: "/api/v1/events" },
    }),
    vlessOut("node4.example.com", 6437, "", {
      network: "grpc",
      security: "reality",
      realitySettings: {
        fingerprint: "safari",
        publicKey: "PUBKEY_4",
        serverName: "node4.example.com",
        shortId: "34109b0d30255f9e",
      },
      grpcSettings: { authority: "", mode: false, serviceName: "grpc" },
    }),
    { protocol: "freedom", tag: "direct" },
    { protocol: "blackhole", tag: "block" },
  ],
};
describe("импорт JSON — Xray/V2Ray", () => {
  it("импортирует все узлы, а служебные outbounds пропускает", async () => {
    const c = await core();
    const parsed = c.parseSubscription(JSON.stringify(XRAY_CONFIG));
    expect(parsed.format).toBe("json");
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.nodes.map((n: any) => n.server)).toEqual([
      "node1.example.com",
      "node2.example.com",
      "node3.example.com",
      "node4.example.com",
    ]);
  });

  it("переносит reality/vision и подменяет generic-теги адресом", async () => {
    const c = await core();
    const n = c.parseSubscription(JSON.stringify(XRAY_CONFIG)).nodes[0];
    expect(n.protocol).toBe("vless");
    expect(n.uuid).toBe(UUID);
    expect(n.flow).toBe("xtls-rprx-vision");
    expect(n.security).toBe("reality");
    expect(n.pbk).toBe("PUBKEY_1");
    expect(n.sni).toBe("node1.example.com");
    expect(n.fp).toBe("firefox");
    expect(n.port).toBe(443);
    // Тег «proxy» ничего не говорит пользователю — берём адрес.
    expect(n.tag).toBe("node1.example.com");
  });

  it("переносит shortId и grpc serviceName", async () => {
    const c = await core();
    const nodes = c.parseSubscription(JSON.stringify(XRAY_CONFIG)).nodes;
    expect(nodes[1].sid).toBe("2ef160ff49f7ea57");
    expect(nodes[3].network).toBe("grpc");
    expect(nodes[3].serviceName).toBe("grpc");
  });

  it("xhttp распознаётся, но помечается неподдерживаемым", async () => {
    const c = await core();
    const nodes = c.parseSubscription(JSON.stringify(XRAY_CONFIG)).nodes;
    expect(nodes[2].network).toBe("xhttp");
    expect(c.isNodeSupported(nodes[2])).toBe(false);
    // И конфиг не строится: иначе узел молча уходил бы в plain TCP.
    expect(c.buildSingBoxConfig(nodes[2])).toBeNull();
    expect(c.isNodeSupported(nodes[0])).toBe(true);
  });

  it("работающие узлы дают валидный конфиг sing-box", async () => {
    const c = await core();
    const nodes = c.parseSubscription(JSON.stringify(XRAY_CONFIG)).nodes;
    for (const n of [nodes[0], nodes[3]]) {
      const cfg = c.buildSingBoxConfig(n, { socksPort: 10908, httpPort: 10909 });
      expect(cfg).not.toBeNull();
      expect(cfg.outbounds[0].tls.reality.public_key).toBe(n.pbk);
      if (n.network === "grpc")
        expect(cfg.outbounds[0].transport).toEqual({ type: "grpc", service_name: "grpc" });
    }
  });
});

describe("импорт JSON — sing-box формат", () => {
  it("читает outbounds sing-box (в т.ч. своё же преобразование)", async () => {
    const c = await core();
    const singbox = {
      outbounds: [
        {
          type: "vless",
          tag: "proxy",
          server: "sb.example.com",
          server_port: 8443,
          uuid: UUID,
          flow: "xtls-rprx-vision",
          tls: {
            enabled: true,
            server_name: "sb.example.com",
            utls: { enabled: true, fingerprint: "chrome" },
            reality: { enabled: true, public_key: "PBK", short_id: "ab" },
          },
          transport: { type: "ws", path: "/ws", headers: { Host: "sb.example.com" } },
        },
        { type: "direct", tag: "direct" },
        {
          type: "shadowsocks",
          tag: "ss",
          server: "ss.example.com",
          server_port: 8388,
          method: "aes-256-gcm",
          password: "pw",
        },
      ],
    };
    const parsed = c.parseSubscription(JSON.stringify(singbox));
    expect(parsed.nodes).toHaveLength(2);

    const v = parsed.nodes[0];
    expect(v.protocol).toBe("vless");
    expect(v.security).toBe("reality");
    expect(v.pbk).toBe("PBK");
    expect(v.sid).toBe("ab");
    expect(v.network).toBe("ws");
    expect(v.path).toBe("/ws");
    expect(v.host).toBe("sb.example.com");
    expect(v.flow).toBe("xtls-rprx-vision");

    const ss = parsed.nodes[1];
    expect(ss.protocol).toBe("shadowsocks");
    expect(ss.method).toBe("aes-256-gcm");
    expect(ss.password).toBe("pw");
  });
});
