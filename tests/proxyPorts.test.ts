import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракты TS-портов прокси-модулей: server/ts/proxySubscriptions.ts →
 * server/proxySubscriptions.js и server/ts/proxyPing.ts → server/proxyPing.js.
 *
 * Поведение очереди и обновления подписок уже покрыто отдельными наборами
 * (proxySubscriptions/proxyPing/proxyPingModes). Здесь — то, что легко
 * потерять именно при переводе на TS: CommonJS-форма модуля (никакого
 * `default`), чистые функции разбора даты/ключа узла и жёсткий лимит
 * MAX_NODES, который защищает машину от пинга сотен узлов за раз.
 */
const req = createRequire(import.meta.url);

let subs: any;
let ping: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-proxyports-"));
  subs = req("../server/proxySubscriptions");
  ping = req("../server/proxyPing");
});

describe("server/proxySubscriptions — порт на TS", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(subs.default).toBeUndefined();
    expect(typeof subs.refreshSubscription).toBe("function");
    expect(typeof subs.startAutoSync).toBe("function");
  });

  it("parseUpdated понимает «YYYY-MM-DD HH:MM:SS» (UTC) и ISO, иначе null", () => {
    expect(subs.parseUpdated("2026-01-02 03:04:05")).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(subs.parseUpdated("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(subs.parseUpdated("")).toBeNull();
    expect(subs.parseUpdated("не дата")).toBeNull();
    expect(subs.parseUpdated(undefined)).toBeNull();
  });

  it("isStale: без даты — устарела, свежая — нет", () => {
    const now = Date.parse("2026-01-02T12:00:00Z");
    expect(subs.isStale({}, 6 * 3600 * 1000, now)).toBe(true);
    expect(subs.isStale({ last_updated: "2026-01-02 11:59:00" }, 6 * 3600 * 1000, now)).toBe(false);
    expect(subs.isStale({ last_updated: "2026-01-01 00:00:00" }, 6 * 3600 * 1000, now)).toBe(true);
  });

  it("nodeKey устойчив к перезаписи подписки: protocol|server|port", () => {
    expect(subs.nodeKey({ protocol: "vless", server: "a.b", port: 443 })).toBe("vless|a.b|443");
    expect(subs.nodeKey({ protocol: "vless", server: "a.b", port: null })).toBe("vless|a.b|");
    expect(subs.nodeKey({ server: "a.b" })).toBe("|a.b|");
    expect(subs.nodeKey(null)).toBe("");
  });

  it("nodeKey не падает на узлах без полей (объект из чужого парсера)", () => {
    expect(subs.nodeKey({})).toBe("||");
  });
});

describe("server/proxyPing — порт на TS", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(ping.default).toBeUndefined();
    expect(typeof ping.start).toBe("function");
    expect(typeof ping.getStatus).toBe("function");
  });

  it("MAX_NODES ограничивает очередь (защита от пинга всей базы)", () => {
    expect(ping.MAX_NODES).toBe(200);
  });

  it("стартовый статус описывает очередь целиком, включая хвост результатов", () => {
    const st = ping.getStatus();
    expect(st).toMatchObject({ running: false, total: 0, done: 0, ok: 0, failed: 0, error: "" });
    expect(Array.isArray(st.results)).toBe(true);
    expect(st.results.length).toBeLessThanOrEqual(12);
  });

  it("cancel без запущенного пинга просто отдаёт статус", () => {
    expect(ping.cancel()).toMatchObject({ running: false });
    expect(ping.isRunning()).toBe(false);
  });
});
