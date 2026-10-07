/**
 * API сетевых утилит (страница Bypass).
 *
 *  GET  /api/nettools/ping?host=...
 *  GET  /api/nettools/traceroute?host=...
 *  GET  /api/nettools/portscan?host=...&from=1&to=1024
 *  GET  /api/nettools/publicip
 *  GET  /api/nettools/interfaces
 *  GET  /api/nettools/wifi/networks
 *  GET  /api/nettools/wifi/current
 *  GET  /api/nettools/speedtest
 */

import express from "express";
import * as net from "../netTools";

const router = express.Router();

router.get("/ping", async (req, res) => {
  try {
    res.json(await net.ping(String(req.query.host || "")));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/traceroute", async (req, res) => {
  try {
    res.json(await net.traceroute(String(req.query.host || "")));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/portscan", async (req, res) => {
  try {
    const from = parseInt(String(req.query.from || "1"), 10);
    const to = parseInt(String(req.query.to || "1024"), 10);
    res.json(await net.portScan(String(req.query.host || ""), from, to));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/publicip", async (req, res) => {
  try {
    res.json(await net.publicIp());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/interfaces", (req, res) => {
  try {
    res.json(net.localInterfaces());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/wifi/networks", async (req, res) => {
  try {
    res.json(await net.wifiNetworks());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/wifi/current", async (req, res) => {
  try {
    res.json(await net.wifiCurrent());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/speedtest", async (req, res) => {
  try {
    res.json(await net.speedTest());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export = router;
