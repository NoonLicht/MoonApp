"use strict";

/**
 * API бюджета/финансов.
 *
 *  GET    /api/budget/transactions              — список операций
 *  POST   /api/budget/transactions               — добавить операцию { ..., currency? }
 *  DELETE /api/budget/transactions/:id            — удалить операцию
 *  GET    /api/budget/summary?period=month&count=6&currency=  — агрегация по дням/неделям/месяцам в валюте currency
 *  GET    /api/budget/categories                   — категории по умолчанию
 *  GET    /api/budget/currencies                   — список поддерживаемых валют
 *  POST   /api/budget/import                        — импорт CSV { csv: string }
 */

const express = require("express");
const budget = require("../budget");

const router = express.Router();

router.get("/transactions", (req, res) => {
  try {
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
    const list = budget.list();
    if (!currency) return res.json(list);
    res.json(list.map((tx) => ({ ...tx, displayAmount: budget.convertAmount(tx, currency) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/transactions", async (req, res) => {
  try {
    const { type, amount, category, note, date, currency } = req.body || {};
    const tx = await budget.create({ type, amount, category, note, date, currency });
    res.status(201).json(tx);
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
    const period = ["day", "week", "month"].includes(req.query.period) ? req.query.period : "month";
    const count = Math.max(1, Math.min(90, parseInt(req.query.count ?? req.query.months, 10) || 6));
    const currency = String(req.query.currency || "RUB").toUpperCase();
    res.json(budget.periodSummary(period, count, currency));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/categories", (req, res) => {
  res.json(budget.DEFAULT_CATEGORIES);
});

router.get("/currencies", (req, res) => {
  res.json(budget.KNOWN_CURRENCIES);
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
