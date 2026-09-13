import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Тесты узлов подписки и миграции схемы.
 *
 * storage задаём ДО require: db читает data.json на загрузке. Специально пишем
 * СТАРЫЙ формат (proxy_nodes без колонки is_excluded) — так проверяем, что
 * миграция колонок реально работает, а не только свежая установка.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mig-"));
process.env.MOONAPP_STORAGE = STORAGE;

const legacyData = {
  proxy_subscriptions: {
    cols: ["name", "url", "last_updated", "auto_update_enabled"],
    rows: [{ id: 7, name: "old", url: "https://example.com/s", last_updated: "", auto_update_enabled: 1 }],
    seq: 7,
  },
  proxy_nodes: {
    cols: ["sub_id", "name", "protocol", "config_json", "ping_ms", "country_code", "is_selected"],
    rows: [{
      id: 1, sub_id: 7, name: "legacy", protocol: "vless",
      config_json: JSON.stringify({ protocol: "vless", server: "1.1.1.1", port: 443 }),
      ping_ms: null, country_code: "", is_selected: 1,
    }],
    seq: 1,
  },
};
fs.writeFileSync(path.join(STORAGE, "data.json"), JSON.stringify(legacyData), "utf8");

const require = createRequire(import.meta.url);
const { stmts } = require("../server/db");
const subs = require("../server/proxySubscriptions");

const VLESS = "vless://11111111-2222-3333-4444-555555555555@1.1.1.1:443?security=tls#One";
const TROJAN = "trojan://pw@2.2.2.2:443#Two";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const serverOf = (row: any) => JSON.parse(row.config_json).server;

describe("db — миграция схемы", () => {
  it("добавляет is_excluded к таблице из старого файла, не ломая позиции колонок", () => {
    const before = stmts.pnodeGet.get(1);
    expect(before.sub_id).toBe(7);
    expect(before.name).toBe("legacy");

    const ins = stmts.pnodeInsert.run(7, "new", "trojan", JSON.stringify({ protocol: "trojan", server: "2.2.2.2", port: 443 }));
    const row = stmts.pnodeGet.get(ins.lastInsertRowid);
    expect(row.sub_id).toBe(7);
    expect(row.name).toBe("new");
    expect(row.protocol).toBe("trojan");
    expect(row.is_excluded).toBe(0);
  });
});

describe("узлы — скрытие и возврат", () => {
  it("скрытие снимает выбор, возврат отменяет скрытие", () => {
    const target = stmts.pnodeForSub.all(7).find((n: any) => n.name === "new");
    stmts.pnodeUpdate.run(target.id, { is_selected: 1 });

    stmts.pnodeExclude.run(target.id);
    const hidden = stmts.pnodeGet.get(target.id);
    expect(hidden.is_excluded).toBe(1);
    expect(hidden.is_selected).toBe(0);
    expect(stmts.pnodeExcludedForSub.all(7).some((n: any) => n.id === target.id)).toBe(true);

    stmts.pnodeRestore.run(target.id);
    expect(stmts.pnodeGet.get(target.id).is_excluded).toBe(0);
    expect(stmts.pnodeExcludedForSub.all(7)).toHaveLength(0);
  });
});

describe("подписка — скрытые узлы", () => {
  it("узел остаётся скрытым после перекачки подписки", async () => {
    const fetchText = async () => b64([VLESS, TROJAN].join("\n"));
    await subs.refreshSubscription(7, { fetchText });

    const nodes = stmts.pnodeForSub.all(7);
    expect(nodes).toHaveLength(2);

    const trojan = nodes.find((n: any) => serverOf(n) === "2.2.2.2");
    stmts.pnodeExclude.run(trojan.id);

    const res = await subs.refreshSubscription(7, { fetchText });
    expect(res.hidden).toBe(1);

    const after = stmts.pnodeForSub.all(7);
    const stillHidden = after.filter((n: any) => n.is_excluded);
    expect(stillHidden).toHaveLength(1);
    expect(serverOf(stillHidden[0])).toBe("2.2.2.2");
  });

  it("nodeKey устойчив к перезаписи и различает узлы", () => {
    expect(subs.nodeKey({ protocol: "vless", server: "a", port: 443 }))
      .toBe(subs.nodeKey({ protocol: "vless", server: "a", port: 443 }));
    expect(subs.nodeKey({ protocol: "vless", server: "a", port: 443 }))
      .not.toBe(subs.nodeKey({ protocol: "vless", server: "a", port: 8443 }));
  });
});
