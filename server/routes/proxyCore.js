"use strict";

/**
 * API встроенного прокси (sing-box core).
 *
 *  GET    /api/proxycore/status              — состояние ядра
 *  POST   /api/proxycore/start   { id|uri }  — запустить ядро (узел из БД или сырой URI)
 *  POST   /api/proxycore/stop                — остановить ядро
 *  GET    /api/proxycore/install             — статус движка sing-box
 *  POST   /api/proxycore/install/start       — установить sing-box
 *  GET    /api/proxycore/latency             — реальный TTFB-пинг через SOCKS5 + ipinfo
 *  GET    /api/proxycore/subscriptions       — список подписок с узлами
 *  POST   /api/proxycore/subscriptions       — { name, url } — добавить подписку
 *  POST   /api/proxycore/subscriptions/:id/refresh — перекачать узлы
 *  DELETE /api/proxycore/subscriptions/:id   — удалить подписку (и её узлы)
 *  GET    /api/proxycore/nodes               — все узлы
 *  POST   /api/proxycore/nodes/ping { subId?, ids?, onlyMissing? } — пинг всех узлов
 *  GET    /api/proxycore/nodes/ping          — прогресс пинга
 *  POST   /api/proxycore/nodes/ping/cancel   — остановить пинг
 *  POST   /api/proxycore/nodes/select { id } — выбрать активный узел
 *  DELETE /api/proxycore/nodes/:id           — убрать узел (скрыть из списка)
 *  POST   /api/proxycore/nodes/:id/restore   — вернуть скрытый узел
 *  DELETE /api/proxycore/nodes/hidden?sub=   — вернуть все скрытые узлы
 *  GET    /api/proxycore/pages               — правила «страница → прокси/direct»
 *  POST   /api/proxycore/pages { route, isProxied } — задать правило страницы
 */

const express = require("express");
const proxyCore = require("../proxyCore");
const proxySubs = require("../proxySubscriptions");
const proxyPing = require("../proxyPing");
const { stmts } = require("../db");
const logger = require("../logger");

const router = express.Router();

/**
 * Ответ со ВСЕГДА актуальным блоком install.
 * Раньше /start и /stop отдавали чистый getCoreStatus() (без install), и панель
 * после клика «Включить» теряла флаг installed → показывала «движок не найден»
 * при полностью рабочем движке.
 */
function statusPayload(status) {
  return { ...(status || proxyCore.getCoreStatus()), install: proxyCore.installStatus() };
}

/* ------------------------------- Ядро ---------------------------------- */

router.get("/status", (req, res) => {
  try { res.json(statusPayload(proxyCore.getCoreStatus())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/start", async (req, res) => {
  try {
    const { id, uri } = req.body || {};
    let node = null;
    if (id != null) {
      const row = stmts.pnodeGet.get(Number(id));
      if (!row) return res.status(404).json({ error: "node_not_found" });
      try { node = JSON.parse(row.config_json); } catch { node = null; }
      if (!node) return res.status(400).json({ error: "node_config_corrupt" });
      stmts.pnodeClearSelected.run();
      stmts.pnodeUpdate.run(row.id, { is_selected: 1 });
    } else if (uri) {
      node = uri;
    } else {
      return res.status(400).json({ error: "id_or_uri_required" });
    }
    const status = await proxyCore.startCore(node);
    logger.action("proxycore.start", { protocol: status.node ? status.node.protocol : null });
    res.json(statusPayload(status));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/stop", async (req, res) => {
  try { res.json(statusPayload(await proxyCore.stopCore())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/install", (req, res) => {
  try { res.json(proxyCore.installStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/install/start", async (req, res) => {
  try { res.json(await proxyCore.installEngine()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/latency", async (req, res) => {
  try {
    const timeout = Number(req.query.timeout) || 3000;
    res.json(await proxyCore.testLatency({ timeout }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------------- Подписки --------------------------------- */

router.get("/subscriptions", (req, res) => {
  try {
    const subs = stmts.psubAll.all().map((s) => ({
      ...s,
      nodes: stmts.pnodeForSub.all(s.id).map(summarizeNode),
    }));
    res.json(subs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/subscriptions", async (req, res) => {
  try {
    const { name, url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: "invalid_url" });
    const r = stmts.psubInsert.run(name || "", url, 1);
    const id = r.lastInsertRowid;
    const refresh = await proxySubs.refreshSubscription(id).catch((e) => ({ error: e.message, added: 0 }));
    res.json({ id, refresh });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/subscriptions/:id/refresh", async (req, res) => {
  try { res.json(await proxySubs.refreshSubscription(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/subscriptions/:id", (req, res) => {
  try { res.json(stmts.psubDelete.run(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------ Пинг всех ------------------------------- */

/**
 * POST /nodes/ping { subId?, ids?, onlyMissing? } — пингует узлы по очереди.
 * Возвращает стартовый статус сразу; прогресс — через GET /nodes/ping.
 */
router.post("/nodes/ping", (req, res) => {
  try {
    const { subId, ids, onlyMissing, timeout } = req.body || {};
    const st = proxyPing.start({
      subId: subId != null ? Number(subId) : null,
      ids: Array.isArray(ids) ? ids : null,
      onlyMissing: !!onlyMissing,
      timeout: Number(timeout) || undefined,
    });
    logger.action("proxycore.ping.request", { subId: subId ?? null, total: st.total });
    res.json(st);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/nodes/ping", (req, res) => {
  try { res.json(proxyPing.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/nodes/ping/cancel", (req, res) => {
  try { res.json(proxyPing.cancel()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------- Узлы ---------------------------------- */

router.get("/nodes", (req, res) => {
  try { res.json(stmts.pnodeAll.all().map(summarizeNode)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/nodes/select", (req, res) => {
  try {
    const id = Number((req.body || {}).id);
    const node = stmts.pnodeGet.get(id);
    if (!node) return res.status(404).json({ error: "node_not_found" });
    if (node.is_excluded) return res.status(409).json({ error: "node_hidden" });
    stmts.pnodeClearSelected.run();
    stmts.pnodeUpdate.run(id, { is_selected: 1 });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /nodes/hidden?sub=<id> — снять скрытие со всех узлов (или одной подписки). */
router.delete("/nodes/hidden", (req, res) => {
  try {
    const sub = req.query.sub != null ? Number(req.query.sub) : null;
    const rows = stmts.pnodeAll.all().filter((n) => n.is_excluded && (sub == null || n.sub_id === sub));
    for (const n of rows) stmts.pnodeRestore.run(n.id);
    res.json({ ok: true, restored: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /nodes/:id — убрать узел из списка.
 * Физически не удаляем, а помечаем скрытым: иначе ближайшее обновление подписки
 * (ручное или фоновое раз в 6 ч) вернуло бы узел обратно.
 */
router.delete("/nodes/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!stmts.pnodeGet.get(id)) return res.status(404).json({ error: "node_not_found" });
    stmts.pnodeExclude.run(id);
    logger.action("proxycore.node.hide", { id });
    res.json({ ok: true, id, hidden: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /nodes/:id/restore — вернуть ранее скрытый узел в список. */
router.post("/nodes/:id/restore", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!stmts.pnodeGet.get(id)) return res.status(404).json({ error: "node_not_found" });
    stmts.pnodeRestore.run(id);
    logger.action("proxycore.node.restore", { id });
    res.json({ ok: true, id, hidden: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --------------------------- Правила страниц ---------------------------- */

router.get("/pages", (req, res) => {
  try { res.json(stmts.pprAll.all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/pages", (req, res) => {
  try {
    const { route, isProxied } = req.body || {};
    if (!route || typeof route !== "string") return res.status(400).json({ error: "route_required" });
    stmts.pprSet.run(route.slice(0, 64), !!isProxied);
    res.json({ ok: true, route, isProxied: !!isProxied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------ Хелперы -------------------------------- */

/** Узел из БД → компактная запись для UI (без тяжёлого config_json). */
function summarizeNode(row) {
  let parsed = null;
  try { parsed = JSON.parse(row.config_json); } catch { parsed = null; }
  return {
    id: row.id,
    subId: row.sub_id,
    name: row.name,
    protocol: row.protocol,
    server: parsed ? parsed.server : null,
    port: parsed ? parsed.port : null,
    pingMs: row.ping_ms,
    country: row.country_code || "",
    isSelected: !!row.is_selected,
    isExcluded: !!row.is_excluded,
  };
}

module.exports = router;
