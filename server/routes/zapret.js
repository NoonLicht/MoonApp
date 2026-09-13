"use strict";

/**
 * API Zapret / DPI Bypass Control.
 *
 *  GET    /api/zapret/engine                — движок (dir, winws, service.bat)
 *  GET    /api/zapret/strategies            — general + ALT1..ALT13
 *  GET    /api/zapret/payloads              — fake-payload .bin из bin/
 *  GET    /api/zapret/status                — активность, PID, память, лог winws
 *  POST   /api/zapret/start                 — { strategyId, customArgs, mode }
 *  POST   /api/zapret/stop                  — остановить процесс/сервис
 *  POST   /api/zapret/service               — { action: install|remove|status }
 *  GET    /api/zapret/diagnostics           — матрица целей
 *  POST   /api/zapret/diagnostics           — прогнать проверки сейчас
 *  POST   /api/zapret/auto-tune             — 1-click «найти рабочую стратегию»
 *  GET/PUT /api/zapret/lists(/:name)        — пользовательские списки lists/
 *  GET/POST/DELETE /api/zapret/profiles      — профили (БД)
 *  POST   /api/zapret/profiles/:id/activate — применить профиль
 *  GET/POST/PATCH/DELETE /api/zapret/domains — пользовательские домены (БД)
 *  POST   /api/zapret/cleanup               — { discord: bool, dns: bool }
 *  POST   /api/zapret/gamefilter            — { tcp: bool, udp: bool }
 *  POST   /api/zapret/settings              — { customTargets, dir, mode, ... }
 *  GET    /api/zapret/check                 — консоль + огоньки последней проверки
 *  POST   /api/zapret/check                 — полная проверка конфигов (service.bat → Run Tests)
 *  POST   /api/zapret/check/stop            — остановить проверку
 *  POST   /api/zapret/service-diagnostics   — пункт 11 service.bat в консоль
 *  POST   /api/zapret/user-lists            — service.bat load_user_lists (починка списков)
 */

const express = require("express");
const zapret = require("../zapret");
const settings = require("../settings");
const { stmts } = require("../db");
const logger = require("../logger");

const router = express.Router();

router.get("/engine", (req, res) => res.json(zapret.engineStatus()));
router.get("/strategies", (req, res) => res.json(zapret.listStrategies()));
router.get("/payloads", (req, res) => res.json(zapret.listPayloads()));

/** Все .bat в каталоге движка (включая служебные) — браузер конфигов. */
router.get("/bat-files", (req, res) => res.json(zapret.listBatFiles()));

/** Что установлено vs последний релиз на GitHub. */
router.get("/update", async (req, res) => {
  try { res.json(await zapret.checkUpdate()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Скачать и установить/обновить движок с GitHub (асинхронно, с прогрессом). */
router.post("/install", async (req, res) => {
  try {
    const st = zapret.installEngine(req.body || {});
    logger.action("zapret.install.start", { tag: st.tag });
    res.json(st);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** Прогресс установки/обновления (поллинг из UI). */
router.get("/install-status", (req, res) => res.json(zapret.installStatus()));

router.get("/status", async (req, res) => {
  try { res.json(await zapret.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/start", async (req, res) => {
  try { res.json(await zapret.start(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/stop", async (req, res) => {
  try { res.json(await zapret.stop()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/service", async (req, res) => {
  try { res.json(await zapret.serviceAction(String(req.body?.action || "status"), req.body?.strategyId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/diagnostics", (req, res) => res.json({ targets: zapret.targets() }));
router.post("/diagnostics", async (req, res) => {
  try { res.json(await zapret.runDiagnostics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/auto-tune", async (req, res) => {
  try { res.json(await zapret.autoTune(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* -------- Списки (lists/) -------- */

router.get("/lists", (req, res) => {
  res.json(zapret.USER_LISTS.map((name) => ({ name, content: zapret.readList(name) })));
});

router.get("/lists/:name", (req, res) => {
  try { res.json({ name: req.params.name, content: zapret.readList(req.params.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/lists/:name", (req, res) => {
  try { res.json({ ok: zapret.writeList(req.params.name, req.body?.content ?? "") }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* -------- Профили -------- */

router.get("/profiles", (req, res) => res.json(stmts.bpAll.all()));

router.post("/profiles", (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "missing_name" });
    const info = stmts.bpInsert.run(String(b.name).slice(0, 120), b.batchFilePath || "", b.customArgs || "", false, !!b.isService);
    logger.action("zapret.profile.save", { id: Number(info.lastInsertRowid), name: b.name });
    res.status(201).json(stmts.bpGet.get(Number(info.lastInsertRowid)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/profiles/:id", (req, res) => res.json({ ok: !!stmts.bpDelete.run(Number(req.params.id)).changes }));

router.post("/profiles/:id/activate", async (req, res) => {
  try {
    const p = stmts.bpGet.get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: "not_found" });
    // Имя профиля вида "auto: alt12 (process)" → strategyId.
    const strategyId = /:\s*(\S+?)\s*\(/.exec(p.name)?.[1] || zapret.listStrategies()[0]?.id || "general";
    res.json(await zapret.start({ strategyId, customArgs: p.custom_args || "", mode: p.is_service ? "service" : "process" }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* -------- Пользовательские домены -------- */

router.get("/domains", (req, res) => res.json(stmts.bcdAll.all()));

router.post("/domains", (req, res) => {
  try {
    const domain = String(req.body?.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const type = req.body?.type === "exclude" ? "exclude" : "include";
    if (!domain) return res.status(400).json({ error: "missing_domain" });
    stmts.bcdInsert.run(domain, type, req.body?.isEnabled === false ? 0 : 1);
    try { zapret.syncCustomDomains(); } catch { /* движок не развёрнут — домен останется в БД */ }
    logger.action("zapret.domain.add", { domain, type });
    res.status(201).json(stmts.bcdAll.all());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch("/domains/:id", (req, res) => {
  try {
    stmts.bcdUpdate.run(Number(req.params.id), { is_enabled: req.body?.isEnabled ? 1 : 0 });
    try { zapret.syncCustomDomains(); } catch { /* движок не развёрнут */ }
    res.json(stmts.bcdAll.all());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/domains/:id", (req, res) => {
  try {
    stmts.bcdDelete.run(Number(req.params.id));
    try { zapret.syncCustomDomains(); } catch { /* движок не развёрнут */ }
    res.json(stmts.bcdAll.all());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* -------- Очистка / GameFilter / настройки -------- */

router.post("/cleanup", async (req, res) => {
  try {
    const out = {};
    if (req.body?.discord) out.discord = zapret.clearDiscordCache();
    if (req.body?.dns) out.dns = await zapret.flushDns();
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/gamefilter", (req, res) => {
  try {
    const cur = settings.get("zapret");
    settings.set({
      zapret: {
        gameFilterTcp: typeof req.body?.tcp === "boolean" ? req.body.tcp : cur.gameFilterTcp,
        gameFilterUdp: typeof req.body?.udp === "boolean" ? req.body.udp : cur.gameFilterUdp,
      },
    });
    // Флаг читает сам движок (utils/game_filter.enabled).
    const mode = zapret.writeGameFilter();
    logger.action("zapret.gamefilter", { mode });
    res.json({ ...settings.get("zapret"), mode });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/settings", (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (typeof b.dir === "string") patch.dir = b.dir;
    if (b.mode === "process" || b.mode === "service") patch.mode = b.mode;
    if (typeof b.customTargets === "string") patch.customTargets = b.customTargets;
    if (typeof b.defaultStrategy === "string") patch.defaultStrategy = b.defaultStrategy;
    if (typeof b.autoApplyBest === "boolean") patch.autoApplyBest = b.autoApplyBest;
    settings.set({ zapret: patch });
    logger.action("zapret.settings", { keys: Object.keys(patch) });
    res.json(settings.get("zapret"));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* -------- Проверка конфигов (service.bat → Run Tests) / консоль / списки -------- */

/** Состояние консоли + огоньки конфигов (поллинг из UI). */
router.get("/check", (req, res) => res.json(zapret.checkStatus()));

/** Полная проверка конфигов (или одного — по strategyId): неинтерактивно, вывод — в консоль страницы. */
router.post("/check", async (req, res) => {
  try { res.json(await zapret.startConfigCheck({ fast: req.body?.fast !== false, strategyId: req.body?.strategyId })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/check/stop", async (req, res) => {
  try { res.json(await zapret.stopConfigCheck()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/** Пункт 11 service.bat — «Run Diagnostics» в ту же консоль. */
router.post("/service-diagnostics", async (req, res) => {
  try { res.json(await zapret.runServiceDiagnostics()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/** Починить пользовательские списки (service.bat load_user_lists) — лечит ipset-ошибку. */
router.post("/user-lists", async (req, res) => {
  try { res.json(await zapret.fixUserLists()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;

