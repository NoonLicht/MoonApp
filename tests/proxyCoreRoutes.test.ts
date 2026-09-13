import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Роуты встроенного прокси проверяем на РЕАЛЬНОМ express: только так ловится
 * ошибка порядка регистрации роутов. Регресс, который здесь закрыт:
 * DELETE /nodes/hidden перехватывался параметрическим DELETE /nodes/:id
 * (id="hidden" → NaN → 404 node_not_found), поэтому «вернуть все скрытые»
 * молча не работало.
 *
 * ВАЖНО про загрузку модулей: db и роутер обязаны быть в ОДНОМ инстансе.
 * `await import()` (vite-node) и native `require` дают РАЗНЫЕ экземпляры модуля,
 * из-за чего вставленные в тесте узлы «не видны» роутеру. Поэтому грузим всё
 * через createRequire.
 */
const require = createRequire(import.meta.url);

describe("proxycore routes (порядок роутов + скрытие узлов)", () => {
  let srv: any = null;
  let base = "";
  let stmts: any;

  beforeAll(async () => {
    process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-pcroutes-"));

    const express = require("express");
    stmts = require("../server/db").stmts;
    const router = require("../server/routes/proxyCore");

    const sub = stmts.psubInsert.run("t", "https://example.com/s", 1);
    const subId = sub.lastInsertRowid;
    stmts.pnodeInsert.run(subId, "a", "vless", JSON.stringify({ protocol: "vless", server: "1.1.1.1", port: 443 }));
    stmts.pnodeInsert.run(subId, "b", "trojan", JSON.stringify({ protocol: "trojan", server: "2.2.2.2", port: 443 }));

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/proxycore", router);
    await new Promise<void>((resolve) => { srv = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => { try { srv?.close(); } catch { /* noop */ } });

  it("GET /nodes отдаёт флаг isExcluded", async () => {
    const res = await fetch(`${base}/api/proxycore/nodes`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(Array.isArray(j)).toBe(true);
    expect(j[0]).toHaveProperty("isExcluded");
  });

  it("DELETE /nodes/:id скрывает узел, выбор скрытого — 409, restore возвращает", async () => {
    const target = stmts.pnodeAll.all()[0];

    const hid = await fetch(`${base}/api/proxycore/nodes/${target.id}`, { method: "DELETE" });
    expect(hid.status).toBe(200);
    const hidden = stmts.pnodeGet.get(target.id);
    expect(hidden.is_excluded).toBe(1);
    expect(hidden.is_selected).toBe(0);

    const sel = await fetch(`${base}/api/proxycore/nodes/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id }),
    });
    expect(sel.status).toBe(409);

    const restore = await fetch(`${base}/api/proxycore/nodes/${target.id}/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    expect(stmts.pnodeGet.get(target.id).is_excluded).toBe(0);
  });

  it("DELETE /nodes/hidden обрабатывается своим роутом и возвращает все скрытые", async () => {
    const all = stmts.pnodeAll.all();
    for (const n of all) stmts.pnodeExclude.run(n.id);
    expect(stmts.pnodeAll.all().filter((n: any) => n.is_excluded)).toHaveLength(all.length);

    const res = await fetch(`${base}/api/proxycore/nodes/hidden`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j).toHaveProperty("restored");
    expect(j.restored).toBe(all.length);
    expect(stmts.pnodeAll.all().filter((n: any) => n.is_excluded)).toHaveLength(0);
  });

  it("DELETE /nodes/hidden?sub=<id> работает со фильтром по подписке", async () => {
    const subId = stmts.psubAll.all()[0].id;
    const target = stmts.pnodeAll.all()[0];
    stmts.pnodeExclude.run(target.id);

    const res = await fetch(`${base}/api/proxycore/nodes/hidden?sub=${subId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.restored).toBe(1);
  });

  /**
   * Регресс «Движок sing-box не найден» при включении прокси:
   * /start и /stop отдавали getCoreStatus() БЕЗ блока install, панель заменяла
   * состояние целиком → installed становился false и загоралось ложное
   * «движок не найден» при полностью рабочем движке.
   */
  it("GET /status, POST /stop и POST /start всегда отдают блок install", async () => {
    const status = await (await fetch(`${base}/api/proxycore/status`)).json() as any;
    expect(status.install).toBeTruthy();
    expect(status.install).toHaveProperty("installed");
    expect(Array.isArray(status.install.candidates)).toBe(true);

    const stop = await (await fetch(`${base}/api/proxycore/stop`, { method: "POST" })).json() as any;
    expect(stop.install).toBeTruthy();
    expect(stop.install).toHaveProperty("installed");

    // /start с заведомо нерабочим узлом всё равно обязан вернуть install.
    const start = await (await fetch(`${base}/api/proxycore/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: "vless://11111111-2222-3333-4444-555555555555@127.0.0.1:1?security=tls#t" }),
    })).json() as any;
    expect(start.install).toBeTruthy();
    expect(start.install).toHaveProperty("installed");
    try { require("../server/proxyCore").stopCore(); } catch { /* noop */ }
  });

  it("POST /nodes/ping: пустая выборка ids не запускает пинг (герметичный тест)", async () => {
    const st = await (await fetch(`${base}/api/proxycore/nodes/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    })).json() as any;
    // Пустой список = ничего не выбрано → ни одного узла, никаких процессов.
    expect(st.total).toBe(0);
    expect(st.running).toBe(false);

    const progress = await (await fetch(`${base}/api/proxycore/nodes/ping`)).json() as any;
    expect(progress).toHaveProperty("done");
    expect(progress).toHaveProperty("results");
    await fetch(`${base}/api/proxycore/nodes/ping/cancel`, { method: "POST" });
  });
});