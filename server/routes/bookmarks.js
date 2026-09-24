"use strict";

/**
 * API закладок.
 *
 *  GET    /api/bookmarks          — список
 *  POST   /api/bookmarks          — создать { title?, url, notes?, tags?, folder?, saveForLater? }
 *  PUT    /api/bookmarks/:id      — обновить { title?, notes?, tags?, folder? }
 *  DELETE /api/bookmarks/:id      — удалить
 */

const express = require("express");
const bookmarks = require("../bookmarks");

const router = express.Router();

router.get("/", (req, res) => {
  try {
    res.json(bookmarks.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { title, url, notes, tags, folder, saveForLater } = req.body || {};
    if (!url) return res.status(400).json({ error: "missing_url" });
    const entry = await bookmarks.create({ title, url, notes, tags, folder, saveForLater });
    res.status(201).json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", (req, res) => {
  try {
    const entry = bookmarks.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const ok = bookmarks.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
