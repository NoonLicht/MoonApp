/**
 * Семантический «дрейф» интересов (логика — в semanticDrift.ts).
 *
 *  GET /api/drift?sources=note,bookmark,lecture,chat&months=12 — помесячные темы и сдвиги
 */
import express from "express";
import * as corpus from "../vaultCorpus";
import * as drift from "../semanticDrift";

const router = express.Router();

router.get("/", (req, res) => {
  try {
    const want = new Set(
      String(req.query.sources || "note,bookmark,lecture,chat")
        .split(",")
        .map((s) => s.trim()),
    );
    const docs = corpus.collectAll().filter((d) => want.has(d.source));
    const months = Math.min(Math.max(Number(req.query.months) || 12, 2), 60);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const recent = docs.filter((d) => d.at >= cutoff.getTime());
    const report = drift.analyzeDrift(recent.map((d) => ({ at: d.at, text: `${d.title}\n${d.text}`, source: d.source })));
    res.json({ ...report, docs: recent.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
