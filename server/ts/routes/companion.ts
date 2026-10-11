/**
 * Управление веб-компаньоном из самого приложения (этот роутер сидит на основном
 * API, который слушает только 127.0.0.1 и требует токен приложения). Сетевой
 * сервер компаньона с его собственной авторизацией — в server/ts/companion.ts.
 *
 *  GET    /api/companion/status                 — состояние, адреса, код сопряжения, устройства
 *  POST   /api/companion/enable { enabled, port? }
 *  POST   /api/companion/pairing                — новый одноразовый код
 *  DELETE /api/companion/devices/:id            — отозвать устройство
 *  POST   /api/companion/player-state           — окно приложения сообщает, что играет
 *  GET    /api/companion/commands               — забрать команды плееру от телефона
 */
import express from "express";
import * as companion from "../companion";

const router = express.Router();

router.get("/status", (_req, res) => res.json(companion.status()));

router.post("/enable", async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await companion.setEnabled(!!b.enabled, b.port ? Number(b.port) : undefined));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    res.status(err.code === "EADDRINUSE" ? 409 : 500).json({ error: err.code === "EADDRINUSE" ? "port_in_use" : err.message });
  }
});

router.post("/pairing", (_req, res) => {
  if (!companion.status().running) return res.status(409).json({ error: "not_running" });
  companion.newPairingCode();
  res.json(companion.status());
});

router.delete("/devices/:id", (req, res) => {
  if (!companion.revokeDevice(req.params.id)) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post("/player-state", (req, res) => {
  companion.setPlayerState(req.body && req.body.state ? req.body.state : null);
  res.json({ ok: true });
});

router.get("/commands", (_req, res) => res.json(companion.takeCommands()));

export = router;
