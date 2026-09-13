import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * «Пропинговать все»: очередь, фильтры, прогресс и запись результата в БД.
 * Реальный пинг инъектируется (pinger) — тесты не запускают sing-box и не ходят
 * в сеть.
 */
const require = createRequire(import.meta.url);
process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-ping-"));

const { stmts } = require("../server/db");
const ping = require("../server/proxyPing");

const nodeJson = (server: string) => JSON.stringify({ protocol: "vless", server, port: 443 });

/** Пингер-заглушка: ok для серверов, начинающихся на "good". */
const stubPinger = async (node: any) => (
  String(node.server).startsWith("good")
    ? { ok: true, ttfbMs: 123, country: "NL", state: "online", error: "" }
    : { ok: false, ttfbMs: null, country: null, state: "blocked", error: "timeout" }
);

let subA = 0;
let subB = 0;

beforeAll(() => {
  subA = stmts.psubInsert.run("A", "https://example.com/a", 1).lastInsertRowid;
  subB = stmts.psubInsert.run("B", "https://example.com/b", 1).lastInsertRowid;
  stmts.pnodeInsert.run(subA, "good-1", "vless", nodeJson("good-1.example"));
  stmts.pnodeInsert.run(subA, "bad-1", "vless", nodeJson("bad-1.example"));
  stmts.pnodeInsert.run(subB, "good-2", "vless", nodeJson("good-2.example"));
});

afterAll(() => { try { stmts.psubDelete.run(subA); stmts.psubDelete.run(subB); } catch { /* noop */ } });

describe("proxyPing — выбор узлов", () => {
  it("фильтрует по подписке и никогда не берёт скрытые", () => {
    const all = ping.selectNodes({});
    expect(all.length).toBeGreaterThanOrEqual(3);

    const onlyB = ping.selectNodes({ subId: subB });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].name).toBe("good-2");

    const target = stmts.pnodeForSub.all(subA).find((n: any) => n.name === "bad-1");
    stmts.pnodeExclude.run(target.id);
    const afterHide = ping.selectNodes({ subId: subA });
    expect(afterHide.map((n: any) => n.name)).not.toContain("bad-1");
    stmts.pnodeRestore.run(target.id);
  });

  it("onlyMissing отбирает только узлы без результата", () => {
    const rows = stmts.pnodeForSub.all(subA);
    stmts.pnodeUpdate.run(rows[0].id, { ping_ms: 42 });
    const missing = ping.selectNodes({ subId: subA, onlyMissing: true });
    expect(missing.map((n: any) => n.id)).not.toContain(rows[0].id);
  });

  it("пустой список ids = ничего не выбрано (а не «все узлы»)", () => {
    expect(ping.selectNodes({ ids: [] })).toHaveLength(0);
    expect(ping.selectNodes({}).length).toBeGreaterThan(0);
  });
});

describe("proxyPing — прогон", () => {
  it("пингует узлы подписки, пишет ping_ms и страну, отдаёт прогресс", async () => {
    const st = ping.start({ subId: subA, pinger: stubPinger });
    expect(st.running).toBe(true);
    expect(st.total).toBe(2);

    await ping.awaitCurrent();
    const done = ping.getStatus();
    expect(done.running).toBe(false);
    expect(done.done).toBe(2);
    expect(done.ok).toBe(1);
    expect(done.failed).toBe(1);
    expect(done.total).toBe(2);

    const nodes = stmts.pnodeForSub.all(subA);
    const good = nodes.find((n: any) => n.name === "good-1");
    const bad = nodes.find((n: any) => n.name === "bad-1");
    expect(good.ping_ms).toBe(123);
    expect(good.country_code).toBe("NL");
    // Неудачный пинг обнуляет прежнее значение, а не оставляет кэш.
    expect(bad.ping_ms).toBeNull();
  });

  it("повторный запуск во время пинга игнорируется", () => {
    ping.start({ subId: subA, pinger: stubPinger });
    const again = ping.start({ subId: subB, pinger: stubPinger });
    expect(again.running).toBe(true);
    expect(again.total).toBe(2); // остался прежний прогон по subA
    ping.cancel();
  });
});
