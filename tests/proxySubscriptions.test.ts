import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

// storage задаём ДО загрузки модулей: db читает каталог при require.
process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-psub-"));

// Единый загрузчик (native require) для db и proxySubscriptions — иначе получим
// два независимых инстанса модуля db и данные «не найдутся».
const require = createRequire(import.meta.url);
const { stmts } = require("../server/db");
const ps = require("../server/proxySubscriptions");

const VLESS = "vless://11111111-2222-3333-4444-555555555555@1.1.1.1:443?security=tls&sni=a.com#One";
const TROJAN = "trojan://pw@2.2.2.2:443?sni=b.com#Two";

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

describe("proxySubscriptions — устаревание", () => {
  it("нет даты → устарела; старая → устарела; свежая → нет", () => {
    expect(ps.isStale({ last_updated: "" }, 1000)).toBe(true);
    expect(ps.isStale({ last_updated: "2020-01-01 00:00:00" }, 1000)).toBe(true);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    expect(ps.isStale({ last_updated: now }, 60_000)).toBe(false);
  });
});

describe("proxySubscriptions — обновление подписки", () => {
  it("подтягивает узлы и восстанавливает выбор активного узла", async () => {
    const sub = stmts.psubInsert.run("test-sub", "https://example.com/sub", 1);
    const id = sub.lastInsertRowid;
    const fetchText = async () => b64([VLESS, TROJAN].join("\n"));

    const first = await ps.refreshSubscription(id, { fetchText });
    expect(first.added).toBe(2);
    expect(first.format).toBe("uri");

    const nodes = stmts.pnodeForSub.all(id);
    expect(nodes).toHaveLength(2);
    const chosen = nodes[0];
    stmts.pnodeUpdate.run(chosen.id, { is_selected: 1 });

    // Повторное обновление: тот же сервер есть в подписке → выбор сохраняется.
    const second = await ps.refreshSubscription(id, { fetchText });
    expect(second.restored).toBe(true);

    const selected = stmts.pnodeForSub.all(id).filter((n: any) => n.is_selected);
    expect(selected).toHaveLength(1);
    const prevCfg = JSON.parse(chosen.config_json);
    const nowCfg = JSON.parse(selected[0].config_json);
    expect(nowCfg.server).toBe(prevCfg.server);
    expect(nowCfg.port).toBe(prevCfg.port);
  });

  it("бросает на несуществующей подписке", async () => {
    await expect(ps.refreshSubscription(999999, { fetchText: async () => "" })).rejects.toThrow(
      "subscription_not_found",
    );
  });
});

describe("proxySubscriptions — авто-синк", () => {
  it("обновляет только подписки с auto_update_enabled", async () => {
    const manual = stmts.psubInsert.run("manual-sub", "https://example.com/manual", 0);
    let calls = 0;
    const fetchText = async () => {
      calls++;
      return b64(VLESS);
    };

    const res = await ps.syncDueSubscriptions({ force: true, fetchText });
    // Подписка с auto_update_enabled=0 не обновляется.
    expect(res.find((x: any) => x.id === manual.lastInsertRowid)).toBeUndefined();
    expect(calls).toBeGreaterThan(0);
  });
});
