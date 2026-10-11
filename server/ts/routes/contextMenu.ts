/**
 * Меню Проводника Windows (логика — в contextMenu.ts).
 *
 *  GET    /api/context-menu          — { supported, installed }
 *  POST   /api/context-menu/install  — { labels: { note, folder } } → добавить пункты (HKCU)
 *  DELETE /api/context-menu          — убрать пункты
 */
import express from "express";
import * as cm from "../contextMenu";

const router = express.Router();

router.get("/", async (_req, res) => {
  res.json({ supported: process.platform === "win32", installed: await cm.isInstalled() });
});

router.post("/install", async (req, res) => {
  try {
    const labels = {
      note: String(req.body?.labels?.note ?? "MoonApp").slice(0, 80),
      folder: String(req.body?.labels?.folder ?? "MoonApp").slice(0, 80),
    };
    await cm.install(process.execPath, labels);
    res.json({ installed: true });
  } catch (e) {
    const msg = (e as Error).message;
    res.status(/dev_build|windows_only/.test(msg) ? 400 : 500).json({ error: msg });
  }
});

router.delete("/", async (_req, res) => {
  try {
    await cm.uninstall();
    res.json({ installed: false });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
