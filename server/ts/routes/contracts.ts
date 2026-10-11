/**
 * «Контракты с собой» (логика — в selfContracts.ts).
 *
 *  GET    /api/self-contracts        — { items: [{contract, value, ratio, status, unit}] }
 *  POST   /api/self-contracts        — { label, metric, target, limit }
 *  DELETE /api/self-contracts/:id
 */
import express from "express";
import * as budget from "../budget";
import * as tracker from "../appTimeTracker";
import * as sc from "../selfContracts";
import { dateKey } from "../timeMachine";

const router = express.Router();

function snapshot(): sc.Snapshot {
  const date = dateKey(Date.now());
  const txs = budget.list().map((t) => ({
    type: t.type,
    amount: budget.convertAmount(t, "RUB") ?? t.amount,
    category: t.category,
    date: t.date,
  }));
  return { appSecondsToday: sc.appSecondsFor(tracker.hourStats(2), date), ...sc.spendSnapshot(txs, date) };
}

router.get("/", (_req, res) => {
  try {
    const snap = snapshot();
    res.json({ items: sc.load().map((c) => sc.evaluate(c, snap)) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/", (req, res) => {
  const body = {
    label: String(req.body?.label ?? ""),
    metric: req.body?.metric,
    target: String(req.body?.target ?? ""),
    limit: Number(req.body?.limit),
  };
  const bad = sc.isValid(body);
  if (bad) return res.status(400).json({ error: bad });
  const c = sc.makeContract(body, Date.now());
  sc.save([...sc.load(), c]);
  res.json(c);
});

router.delete("/:id", (req, res) => {
  sc.save(sc.load().filter((c) => c.id !== req.params.id));
  res.json({ ok: true });
});

export = router;
