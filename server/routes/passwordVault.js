"use strict";

/**
 * API менеджера паролей.
 *
 *  GET    /api/passwords              — список (без паролей)
 *  GET    /api/passwords/:id/reveal   — одна запись с расшифрованным паролем
 *  POST   /api/passwords              — создать запись
 *  PUT    /api/passwords/:id          — обновить запись
 *  DELETE /api/passwords/:id          — удалить запись
 *  POST   /api/passwords/generate     — сгенерировать пароль { length, digits, symbols, upper }
 */

const express = require("express");
const vault = require("../passwordVault");

const router = express.Router();

router.get("/", (req, res) => {
  try {
    res.json(vault.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/reveal", (req, res) => {
  try {
    const entry = vault.reveal(req.params.id);
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req, res) => {
  try {
    const { title, username, password, url, notes, tags } = req.body || {};
    if (!password) return res.status(400).json({ error: "missing_password" });
    res.status(201).json(vault.create({ title, username, password, url, notes, tags }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", (req, res) => {
  try {
    const entry = vault.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = vault.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/generate", (req, res) => {
  try {
    const { length, digits, symbols, upper } = req.body || {};
    res.json({ password: vault.generatePassword({ length, digits, symbols, upper }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
