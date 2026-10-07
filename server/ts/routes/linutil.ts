/**
 * API Linux-инструментов страницы «Тюнинг ПК» (linutil, MIT).
 *
 *  GET  /api/linutil/overview     — каталог пунктов, подходящих этой системе
 *  POST /api/linutil/run {id}     — открыть скрипт в окне терминала
 */
import express from "express";
import { linutilOverview, linutilRun } from "../linutil";

const router = express.Router();

router.use((_req, res, next) => {
  if (process.platform !== "linux") return res.status(501).json({ error: "linux_only" });
  next();
});

router.get("/overview", (_req, res) => {
  try {
    res.json(linutilOverview());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/run", (req, res) => {
  const r = linutilRun(String(req.body?.id || ""));
  res.status(r.ok ? 200 : 400).json(r);
});

export = router;
