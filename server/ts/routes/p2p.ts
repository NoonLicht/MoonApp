/**
 * P2P-синхронизация заметок (логика — в p2pSync.ts и p2pServer.ts).
 *
 *  GET  /api/p2p                — { listening, port, addresses, key? } (ключ — только пока слушатель включён)
 *  POST /api/p2p/enable         — { port? } → включить приём соединений из локальной сети
 *  POST /api/p2p/disable        — выключить; слушатель не сохраняется между запусками
 *  POST /api/p2p/rotate-key     — новый парный ключ (старый перестаёт работать)
 *  POST /api/p2p/sync           — { host, port, key } → синхронизироваться с другим устройством
 */
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import config from "../config";
import * as p2p from "../p2pSync";
import * as srv from "../p2pServer";

const router = express.Router();
const DEFAULT_PORT = 47813;

let running: srv.P2pServer | null = null;

const keyFile = (): string => path.join(config.DIRS.storage, "p2p.json");

function loadKey(): string {
  try {
    const k = JSON.parse(fs.readFileSync(keyFile(), "utf8")).key;
    if (typeof k === "string" && /^[0-9a-f]{64}$/.test(k)) return k;
  } catch {
    /* ключа ещё нет */
  }
  return saveKey(p2p.newPairingKey());
}

function saveKey(key: string): string {
  fs.writeFileSync(keyFile(), JSON.stringify({ key }), "utf8");
  return key;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  return out;
}

const status = () => ({
  listening: !!running,
  port: running?.port ?? null,
  addresses: running ? lanAddresses() : [],
  key: running ? loadKey() : null,
});

router.get("/", (_req, res) => res.json(status()));

router.post("/enable", async (req, res) => {
  try {
    if (!running) {
      const port = Number(req.body?.port) || DEFAULT_PORT;
      if (port < 1024 || port > 65535) return res.status(400).json({ error: "bad_port" });
      running = await srv.startServer({ root: config.DIRS.vaultNotes, secret: loadKey(), port });
    }
    res.json(status());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/disable", async (_req, res) => {
  if (running) {
    await running.close();
    running = null;
  }
  res.json(status());
});

router.post("/rotate-key", async (_req, res) => {
  const port = running?.port;
  if (running) {
    await running.close();
    running = null;
  }
  saveKey(p2p.newPairingKey());
  if (port) running = await srv.startServer({ root: config.DIRS.vaultNotes, secret: loadKey(), port });
  res.json(status());
});

router.post("/sync", async (req, res) => {
  try {
    const host = String(req.body?.host ?? "").trim();
    const port = Number(req.body?.port) || DEFAULT_PORT;
    const key = String(req.body?.key ?? "").trim();
    if (!/^[\w.-]{1,253}$/.test(host)) return res.status(400).json({ error: "bad_host" });
    if (!/^[0-9a-f]{64}$/.test(key)) return res.status(400).json({ error: "bad_key" });
    res.json(await srv.syncWith({ root: config.DIRS.vaultNotes, host, port, secret: key }));
  } catch (e) {
    const msg = (e as Error).message;
    res.status(msg === "wrong_key" ? 403 : 502).json({ error: msg });
  }
});

export = router;
