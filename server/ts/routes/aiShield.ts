/**
 * Щит для ИИ и журнал отправок (логика — в aiShield.ts).
 *
 *  GET    /api/ai-shield/audit    — ?limit= → { items, summary } (новые первыми)
 *  DELETE /api/ai-shield/audit    — очистить журнал
 *  POST   /api/ai-shield/preview  — { text } → { text, found } что будет скрыто (без отправки)
 */
import express from "express";
import settings from "../settings";
import * as shield from "../aiShield";

const router = express.Router();

router.get("/audit", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const all = shield.loadAudit(Infinity);
  res.json({ items: all.slice(-limit).reverse(), summary: shield.summarize(all) });
});

router.delete("/audit", (_req, res) => {
  shield.clearAudit();
  res.json({ ok: true });
});

router.post("/preview", (req, res) => {
  const cfg = settings.get("aiShield") ?? {};
  const r = shield.shieldText(String(req.body?.text ?? "").slice(0, 50_000), { pii: !!cfg.pii });
  res.json({ text: r.text, found: r.found });
});

export = router;
