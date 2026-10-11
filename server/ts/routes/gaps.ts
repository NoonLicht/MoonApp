/**
 * Карта белых пятен (логика — в knowledgeGaps.ts).
 *
 *  GET  /api/gaps          — { topics, dangling } по заметкам: частые темы и вики-ссылки без заметки
 *  POST /api/gaps/suggest  — { topic } → { topic, covered, items[] } связанные подтемы и их покрытие
 */
import express from "express";
import * as corpus from "../vaultCorpus";
import * as gaps from "../knowledgeGaps";
import { askModel } from "../llmOnce";

const router = express.Router();

const docs = (): gaps.GapDoc[] =>
  corpus.collectNotes().map((n) => ({ ref: n.ref, title: n.title, text: n.text }));

router.get("/", (_req, res) => {
  try {
    const d = docs();
    res.json({
      notes: d.length,
      topics: gaps.topTopics(d, { topN: 24, minDocs: 3 }),
      dangling: gaps.danglingLinks(d).slice(0, 30),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/suggest", async (req, res) => {
  try {
    const topic = String(req.body?.topic ?? "").trim().slice(0, 80);
    if (!topic) return res.status(400).json({ error: "empty_topic" });
    const d = docs();
    const answer = await askModel(
      "Ты помогаешь выстроить карту знаний. Отвечаешь только списком тем.",
      gaps.buildSuggestPrompt(topic, gaps.topTopics(d, { topN: 12, minDocs: 3 })),
      { appPage: req.appPage, maxTokens: 300, temperature: 0.4 },
    );
    res.json(gaps.gapReport(topic, gaps.parseSuggestions(answer), d));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
