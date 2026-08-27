const express = require("express");
const { stmts } = require("../db");
const logger = require("../logger");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(stmts.taskAll.all());
});

router.post("/", (req, res) => {
  const { text, priority = "Med", tag = "General" } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "empty task" });
  const info = stmts.taskInsert.run(String(text).trim(), 0, priority, tag);
  const task = stmts.taskAll.all().find((t) => t.id === info.lastInsertRowid);
  logger.action("task.add", { id: task.id });
  res.status(201).json(task);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { done, priority, tag } = req.body || {};
  const existing = stmts.taskAll.all().find((t) => t.id === id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const nextDone = done != null ? (done ? 1 : 0) : existing.done;
  stmts.taskToggle.run(nextDone, id);
  logger.action("task.toggle", { id, done: !!nextDone });
  res.json({ ...existing, done: !!nextDone, priority, tag });
});

router.put("/order", (req, res) => {
  const ids = (req.body || {}).ids || [];
  ids.forEach((id, i) => stmts.taskOrder.run(i, Number(id)));
  logger.action("task.reorder", { ids });
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  stmts.taskDelete.run(id);
  logger.action("task.delete", { id });
  res.json({ ok: true });
});

module.exports = router;