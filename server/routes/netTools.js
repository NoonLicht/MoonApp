"use strict";

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

const express = require("express");
const net = require("../netTools");

const router = express.Router();

router.get("/ping", async (req, res) => {
  try {
    res.json(await net.ping(String(req.query.host || "")));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/traceroute", async (req, res) => {
  try {
    res.json(await net.traceroute(String(req.query.host || "")));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/portscan", async (req, res) => {
  try {
    const from = parseInt(String(req.query.from || "1"), 10);
    const to = parseInt(String(req.query.to || "1024"), 10);
    res.json(await net.portScan(String(req.query.host || ""), from, to));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/publicip", async (req, res) => {
  try {
    res.json(await net.publicIp());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/interfaces", (req, res) => {
  try {
    res.json(net.localInterfaces());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/wifi/networks", async (req, res) => {
  try {
    res.json(await net.wifiNetworks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/wifi/current", async (req, res) => {
  try {
    res.json(await net.wifiCurrent());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/speedtest", async (req, res) => {
  try {
    res.json(await net.speedTest());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
