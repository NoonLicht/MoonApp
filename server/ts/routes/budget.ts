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

import express from "express";
import * as budget from "../budget";
import * as recurring from "../budgetRecurring";
import { parseReceipt } from "../receiptParser";
import * as insights from "../budgetInsights";
import * as hours from "../budgetHours";

const router = express.Router();

router.get("/transactions", (req, res) => {
  try {
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
    const list = budget.list();
    if (!currency) return res.json(list);
    res.json(list.map((tx) => ({ ...tx, displayAmount: budget.convertAmount(tx, currency) })));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/transactions", async (req, res) => {
  try {
    const { type, amount, category, note, date, currency } = req.body || {};
    const tx = await budget.create({ type, amount, category, note, date, currency });
    res.status(201).json(tx);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.delete("/transactions/:id", (req, res) => {
  try {
    const ok = budget.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Черновик операций из текста чека (OCR делает /api/ocr/recognize). Ничего не сохраняет.
router.post("/receipt-parse", (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 20000);
  res.json(parseReceipt(text));
});

/** Операции в единой валюте для аналитики (без снимка курса берётся исходная сумма). */
function insightTxs(currency: string): insights.Tx[] {
  return budget.list().map((t) => ({
    type: t.type,
    amount: budget.convertAmount(t, currency) ?? t.amount,
    category: t.category,
    note: t.note,
    date: t.date,
  }));
}

// Аналитика: хватит ли до зарплаты, подписки, сравнение месяцев, личная инфляция, «что если».
router.get("/insights", (req, res) => {
  try {
    const currency = String(req.query.currency || "RUB").toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const txs = insightTxs(currency);
    const out: Record<string, unknown> = {
      subscriptions: insights.findSubscriptions(txs, today),
      inflation: insights.personalInflation(txs),
    };
    const payday = String(req.query.payday || "");
    const available = Number(req.query.available);
    if (/^\d{4}-\d{2}-\d{2}$/.test(payday) && Number.isFinite(available)) {
      const days = Math.max(
        0,
        Math.ceil((Date.parse(payday) - Date.parse(today)) / 86_400_000),
      );
      const fixed = recurring
        .getUpcoming(Math.max(1, days))
        .filter((u) => u.recurring.type === "expense" && u.due <= payday)
        .reduce((s, u) => s + u.recurring.amount, 0);
      out.runway = insights.runway({ txs, available, today, payday, fixedUntilPayday: fixed, trimTop: 2 });
    }
    const a = String(req.query.monthA || "");
    const b = String(req.query.monthB || "");
    if (/^\d{4}-\d{2}$/.test(a) && /^\d{4}-\d{2}$/.test(b)) out.compare = insights.compareMonths(txs, a, b);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Оценка социального налогового вычета по тратам за все годы.
router.get("/tax-deductions", (req, res) => {
  const limit = Number(req.query.limit);
  const rate = Number(req.query.rate);
  res.json(
    insights.taxDeductions(insightTxs(String(req.query.currency || "RUB").toUpperCase()), {
      limit: limit > 0 ? limit : undefined,
      rate: rate > 0 && rate < 1 ? rate : undefined,
    }),
  );
});

// «Цена в часах»: траты месяца в рабочих часах и часах жизни по доходу.
router.get("/hours", (req, res) => {
  try {
    const currency = String(req.query.currency || "RUB").toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today.slice(0, 7);
    const txs = insightTxs(currency);
    const rates = hours.hourRates(txs, today, {
      monthlyIncome: Number(req.query.monthlyIncome) || undefined,
      workHoursPerMonth: Number(req.query.workHours) || undefined,
    });
    res.json(hours.hoursReport(txs, month, rates));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Прогноз «накопишь на X к дате».
router.get("/saving-forecast", (req, res) => {
  try {
    const target = Number(req.query.target);
    if (!(target > 0)) return res.status(400).json({ error: "bad_target" });
    const today = new Date().toISOString().slice(0, 10);
    res.json(
      hours.savingForecast(insightTxs(String(req.query.currency || "RUB").toUpperCase()), today, {
        target,
        have: Number(req.query.have) || 0,
        byDate: String(req.query.date || "") || undefined,
      }),
    );
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/what-if", (req, res) => {
  const cut: Record<string, number> = {};
  for (const [k, v] of Object.entries(req.body?.cut ?? {})) cut[String(k)] = Number(v) || 0;
  res.json(insights.whatIf(insightTxs(String(req.body?.currency || "RUB").toUpperCase()), cut));
});

router.get("/summary", (req, res) => {
  try {
    const period = ["day", "week", "month"].includes(req.query.period as string)
      ? req.query.period
      : "month";
    const count = Math.max(
      1,
      Math.min(90, parseInt((req.query.count ?? req.query.months) as string, 10) || 6),
    );
    const currency = String(req.query.currency || "RUB").toUpperCase();
    res.json(budget.periodSummary(period as any, count, currency));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
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
    res.status(500).json({ error: (e as Error).message });
  }
});

/* ----- подписки и регулярные платежи, прогноз, OFX ----- */

router.get("/recurring", (_req, res) => res.json(recurring.list()));

router.post("/recurring", (req, res) => {
  try {
    res.status(201).json(recurring.create(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.patch("/recurring/:id", (req, res) => {
  const r = recurring.update(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json(r);
});

router.delete("/recurring/:id", (req, res) => {
  if (!recurring.remove(req.params.id)) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.get("/recurring/upcoming", (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(String(req.query.days), 10) || 30));
  res.json(recurring.getUpcoming(days));
});

router.post("/recurring/:id/pay", async (req, res) => {
  try {
    const tx = await recurring.markPaid(req.params.id);
    if (!tx) return res.status(404).json({ error: "not_found" });
    res.json(tx);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/forecast", (req, res) => {
  try {
    res.json(recurring.getForecast(String(req.query.currency || "RUB")));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/import-ofx", (req, res) => {
  try {
    const ofx = (req.body && req.body.ofx) || "";
    if (!ofx) return res.status(400).json({ error: "missing_ofx" });
    const parsed = recurring.parseOfx(String(ofx));
    if (!parsed.items.length) return res.json({ imported: 0, skipped: parsed.skipped, errors: ["no_transactions"] });
    res.json(budget.importOfxItems(parsed.items, parsed.skipped));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
