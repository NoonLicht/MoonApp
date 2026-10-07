/**
 * API страницы «Тюнинг ПК» (только Windows).
 *
 *  GET  /api/tuning/overview            — твики со статусами, права, история
 *  POST /api/tuning/apply {ids}         — применить (перед этим — автокопия)
 *  POST /api/tuning/revert {ids}        — откатить выбранные
 *  POST /api/tuning/rollback-all        — откатить всё, что применило приложение
 *  POST /api/tuning/reg {ids, mode}     — текст .reg (apply|revert)
 *  GET/POST/DELETE /api/tuning/backups  — резервные копии, POST /backups/:id/restore
 *  POST /api/tuning/restore-point       — точка восстановления Windows
 *  GET  /api/tuning/usb | drivers | processes | bios | bench
 *  POST /api/tuning/process, /ifeo, /bench, /checklist, /open
 */
import express from "express";
import { TWEAKS } from "../tuningCatalog";
import * as engine from "../tuningEngine";
import * as tools from "../tuningTools";
import * as wu from "../winutilTools";

const router = express.Router();

router.use((req, res, next) => {
  if (process.platform !== "win32") return res.status(501).json({ error: "windows_only" });
  next();
});

type Handler = (req: express.Request, res: express.Response) => Promise<unknown> | unknown;

const wrap =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : [];

router.get(
  "/overview",
  wrap(async () => {
    const [statuses, admin] = await Promise.all([engine.statusAll(), engine.isAdmin()]);
    const st = engine.readState();
    return {
      admin,
      tweaks: TWEAKS.map((t) => ({ id: t.id, tab: t.tab, risk: t.risk, reboot: !!t.reboot })),
      statuses,
      checklist: st.checklist,
      history: st.history.slice(0, 50),
      applied: Object.keys(st.applied).length,
      backups: engine.listBackups().length,
      ifeo: tools.ifeoRules(),
    };
  }),
);

router.get(
  "/status",
  wrap(() => engine.statusAll()),
);

router.post(
  "/apply",
  wrap((req) => engine.applyBatch(ids(req.body?.ids), "apply")),
);
router.post(
  "/revert",
  wrap((req) => engine.applyBatch(ids(req.body?.ids), "revert")),
);
router.post(
  "/rollback-all",
  wrap(() => engine.rollbackAll()),
);

router.post(
  "/reg",
  wrap(async (req) => ({
    text: await engine.exportReg(
      ids(req.body?.ids),
      req.body?.mode === "revert" ? "revert" : "apply",
    ),
  })),
);

router.get(
  "/backups",
  wrap(() => engine.listBackups()),
);
router.post(
  "/backups",
  wrap((req) => engine.createBackup(String(req.body?.label || "Manual backup"), false)),
);
router.post(
  "/backups/:id/restore",
  wrap((req) => engine.restoreBackup(String(req.params.id))),
);
router.delete(
  "/backups/:id",
  wrap((req) => ({ ok: engine.deleteBackup(String(req.params.id)) })),
);
router.post(
  "/restore-point",
  wrap(() => engine.createRestorePoint()),
);

router.get(
  "/fixes",
  wrap(() => tools.FIX_IDS),
);
router.post(
  "/fix",
  wrap((req) => tools.runFix(String(req.body?.id || ""))),
);
router.get(
  "/usb",
  wrap(() => tools.usbTree()),
);
router.get(
  "/drivers",
  wrap(() => tools.driverList()),
);
router.get(
  "/processes",
  wrap(() => tools.processList()),
);
router.post(
  "/process",
  wrap((req) => {
    const b = req.body || {};
    return tools.setProcess(
      Number(b.pid),
      typeof b.priority === "string" ? b.priority : undefined,
      b.affinity === undefined ? undefined : Number(b.affinity),
    );
  }),
);
router.post(
  "/ifeo",
  wrap((req) => tools.ifeoAdd(String(req.body?.exe || ""), String(req.body?.priority || ""))),
);
router.delete(
  "/ifeo",
  wrap((req) => tools.ifeoRemove(String(req.query.exe || ""))),
);

router.get(
  "/bios",
  wrap(() => tools.biosFacts()),
);
router.post(
  "/checklist",
  wrap((req) => ({ ok: tools.checklistSet(String(req.body?.id || ""), !!req.body?.checked) })),
);
router.post(
  "/open",
  wrap((req) => tools.openTool(String(req.body?.what || ""))),
);

router.get(
  "/bench",
  wrap(() => tools.benchList()),
);
router.post(
  "/bench",
  wrap(async (req) => {
    const data = await tools.runBench();
    if (!data) return { ok: false, error: "bench_failed" };
    return { ok: true, run: tools.benchSave(String(req.body?.label || "Run"), data) };
  }),
);
router.delete(
  "/bench/:id",
  wrap((req) => {
    tools.benchDelete(String(req.params.id));
    return { ok: true };
  }),
);

// ── winutil (ChrisTitusTech/winutil, MIT) ──
router.get(
  "/wu/meta",
  wrap(async () => ({
    dns: wu.dnsProviders(),
    dnsCurrent: await wu.dnsCurrent(),
    actions: wu.WU_ACTION_IDS,
    panels: wu.panelIds(),
    winget: await wu.wingetAvailable(),
  })),
);
router.post(
  "/wu/action",
  wrap((req) => wu.runAction(String(req.body?.id || ""))),
);
router.post(
  "/wu/dns",
  wrap((req) => wu.dnsSet(String(req.body?.provider || ""))),
);
router.get(
  "/wu/features",
  wrap(() => wu.featuresStatus()),
);
router.post(
  "/wu/feature",
  wrap((req) => wu.featureSet(String(req.body?.id || ""), !!req.body?.enable)),
);
router.post(
  "/wu/panel",
  wrap((req) => wu.openPanel(String(req.body?.id || ""))),
);
router.get(
  "/wu/apps",
  wrap(() => wu.appsCatalog()),
);
router.get(
  "/wu/apps/installed",
  wrap(() => wu.appsInstalled()),
);
router.post(
  "/wu/apps",
  wrap((req) => {
    const mode = String(req.body?.mode || "install");
    if (mode !== "install" && mode !== "uninstall" && mode !== "upgrade")
      return { ok: false, failed: [], needsReboot: false, error: "bad_mode" };
    return wu.appsRun(ids(req.body?.ids), mode);
  }),
);

export = router;
