import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Реальный пинг узла. Регресс, который закрывается: раньше на каждый узел
 * делался ОДИН запрос к Google с таймаутом 2.5 с и требовался строго 204 —
 * поэтому «работающими» оказывались только самые близкие узлы (условные
 * Япония/Польша), а рабочие дальние отметались как «блок».
 */
const require = createRequire(import.meta.url);
process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-pingmode-"));

const core = require("../server/proxyCore");
const ping = require("../server/proxyPing");

const UUID = "11111111-2222-3333-4444-555555555555";
const vless = (server: string, port: number) => ({
  protocol: "vless",
  server,
  port,
  uuid: UUID,
  tls: true,
  sni: "x.com",
  tag: "t",
});

describe("пинг узла — методика", () => {
  it("несколько целей вместо одной (иначе часть рабочих узлов = «блок»)", () => {
    expect(core.PING_TARGETS.length).toBeGreaterThan(1);
    expect(core.PING_TARGETS.some((u: string) => u.includes("cloudflare"))).toBe(true);
  });

  it("таймаут по умолчанию достаточен для холодного подключения", () => {
    expect(core.PING_DEFAULT_TIMEOUT).toBeGreaterThanOrEqual(5000);
  });

  it("недоступный TCP-порт → быстрый отказ 'unreachable', без запуска ядра", async () => {
    const t0 = Date.now();
    const r = await core.pingNode(vless("127.0.0.1", 1));
    expect(r.ok).toBe(false);
    expect(r.ttfbMs).toBeNull();
    expect(r.error).toBe("unreachable");
    // Ядро не поднимаем — отказ должен быть почти мгновенным.
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 20000);

  it("порты пинга ротируются и не пересекаются с портами активного прокси", async () => {
    expect(core.PING_SOCKS_PORT).not.toBe(core.DEFAULT_SOCKS_PORT);
    expect(core.PING_HTTP_PORT).not.toBe(core.DEFAULT_HTTP_PORT);
    // Диапазоны SOCKS и HTTP не должны пересекаться между собой.
    expect(core.PING_HTTP_PORT - core.PING_SOCKS_PORT).toBeGreaterThanOrEqual(16);
  });
});

describe("proxyPing — состояние после прогона", () => {
  it("после прогона прогресс закрыт, а результаты содержат причину", async () => {
    const sub = require("../server/db").stmts.psubInsert.run("p", "https://example.com/p", 1);
    const stmts = require("../server/db").stmts;
    stmts.pnodeInsert.run(
      sub.lastInsertRowid,
      "n1",
      "vless",
      JSON.stringify(vless("127.0.0.1", 1)),
    );

    ping.start({
      subId: sub.lastInsertRowid,
      pinger: async () => ({
        ok: false,
        ttfbMs: null,
        country: null,
        state: "blocked",
        error: "unreachable",
      }),
    });
    await ping.awaitCurrent();
    const st = ping.getStatus();
    expect(st.running).toBe(false);
    expect(st.failed).toBe(1);
    expect(st.results[0].error).toBe("unreachable");
  }, 20000);
});
