import express from "express";
import * as proxy from "../proxy";

const router = express.Router();

// GET /api/proxy/status
router.get("/status", (req, res) => {
  try {
    res.json(proxy.getStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/proxy/start { vlessLink }
router.post("/start", async (req, res) => {
  try {
    const { vlessLink } = req.body || {};
    if (!vlessLink) return res.status(400).json({ error: "vlessLink required" });
    const result = await proxy.startProxy(vlessLink);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/proxy/stop
router.post("/stop", (req, res) => {
  try {
    res.json(proxy.stopProxy());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/proxy/ping
router.post("/ping", async (req, res) => {
  try {
    const result = await proxy.pingProxy();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/proxy/install — статус установки sing-box
router.get("/install", (req, res) => {
  try {
    res.json(proxy.installStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/proxy/install/start — установить sing-box
router.post("/install/start", async (req, res) => {
  try {
    res.json(await proxy.installSingBox());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Сохранённые VLESS

// GET /api/proxy/vless — список
router.get("/vless", (req, res) => {
  try {
    res.json(proxy.getSavedVless());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/proxy/vless/save { link, name? } — сохранить
router.post("/vless/save", (req, res) => {
  try {
    const { link, name } = req.body || {};
    if (!link) return res.status(400).json({ error: "link required" });
    res.json(proxy.saveVless(link, name));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/proxy/vless/:id — удалить
router.delete("/vless/:id", (req, res) => {
  try {
    res.json(proxy.deleteVless(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export = router;
