"use strict";

/**
 * API бюджета/финансов.
 *
 *  GET    /api/budget/transactions           — список операций
 *  POST   /api/budget/transactions            — добавить операцию
 *  DELETE /api/budget/transactions/:id         — удалить операцию
 *  GET    /api/budget/summary?months=6         — помесячная агрегация
 *  GET    /api/budget/categories                — категории по умолчанию
 *  POST   /api/budget/import                     — импорт CSV { csv: string }
 */

const express = require("express");
const budget = require("../budget");

const router = express.Router();

router.get("/transactions", (req, res) => {
  try {
    res.json(budget.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/transactions", (req, res) => {
  try {
    const { type, amount, category, note, date } = req.body || {};
    res.status(201).json(budget.create({ type, amount, category, note, date }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/transactions/:id", (req, res) => {
  try {
    const ok = budget.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/summary", (req, res) => {
  try {
    const months = Math.max(1, Math.min(24, parseInt(req.query.months, 10) || 6));
    res.json(budget.monthlySummary(months));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/categories", (req, res) => {
  res.json(budget.DEFAULT_CATEGORIES);
});

router.post("/import", (req, res) => {
  try {
    const csv = (req.body && req.body.csv) || "";
    if (!csv) return res.status(400).json({ error: "missing_csv" });
    res.json(budget.importCsv(csv));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
