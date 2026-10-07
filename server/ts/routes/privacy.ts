/**
 * API вкладки «Приватность» (стр. «Тюнинг ПК»).
 *
 *  GET  /api/privacy/overview       — доступные цели, права, журнал
 *  POST /api/privacy/wipe {ids}     — зачистить выбранные цели
 *  POST /api/privacy/panic          — зачистить вообще всё доступное на этой платформе
 */
import express from "express";
import * as engine from "../privacyEngine";
import { isAdmin } from "../tuningEngine";

const router = express.Router();

router.use((req, res, next) => {
  if (process.platform !== "win32" && process.platform !== "linux")
    return res.status(501).json({ error: "unsupported_platform" });
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
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];

router.get(
  "/overview",
  wrap(async () => ({
    platform: process.platform,
    admin: process.platform === "win32" ? await isAdmin() : true,
    items: engine.availableItems(),
    history: engine.historyList(),
  })),
);

router.post(
  "/wipe",
  wrap((req) => engine.wipeItems(ids(req.body?.ids))),
);
router.post(
  "/panic",
  wrap(() => engine.panicWipe()),
);

export = router;
