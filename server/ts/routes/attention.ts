/**
 * Карта внимания (логика — в attentionMap.ts).
 *
 *  GET  /api/attention/week?end=YYYY-MM-DD  — { week, facts, insights, hasData }
 *  POST /api/attention/ask                  — { question, end? } → { answer, facts }
 *
 * Время в приложениях копится трекером (Автоматизация → «Время в приложениях»);
 * почасовая разбивка ведётся с момента обновления до этой версии.
 */
import express from "express";
import fs from "fs";
import path from "path";
import config from "../config";
import { stmts } from "../db";
import * as tracker from "../appTimeTracker";
import * as att from "../attentionMap";
import { askModel } from "../llmOnce";

const router = express.Router();

function collect(end: string) {
  const stats = tracker.hourStats(14);
  const lectures: att.LectureSpan[] = [];
  try {
    for (const l of stmts.lectureAll.all() as unknown as { started_at: string; duration_ms: number }[]) {
      const t = Date.parse(String(l.started_at));
      if (Number.isFinite(t)) lectures.push({ startMs: t, durationMs: Number(l.duration_ms) || 0 });
    }
  } catch {
    /* лекций нет */
  }
  const tasksDone: number[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.DIRS.vault, "tasks.json"), "utf8"));
    for (const t of Array.isArray(raw) ? raw : []) {
      const ts = Date.parse(String(t.updated_at ?? ""));
      if ((t.status === "completed" || t.status === "done") && Number.isFinite(ts)) tasksDone.push(ts);
    }
  } catch {
    /* задач нет */
  }
  const week = att.buildWeek({ end, stats, lectures, tasksDone });
  const facts = att.factsOf(week, stats);
  const hasData = week.days.some((d) => d.activeHours > 0);
  return { week, facts, hasData };
}

const endParam = (v: unknown): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : att.dayKey(Date.now());

router.get("/week", (req, res) => {
  try {
    const r = collect(endParam(req.query.end));
    res.json({ ...r, insights: att.insightsFrom(r.facts) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/ask", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: "empty_question" });
    const r = collect(endParam(req.body?.end));
    if (!r.hasData) return res.status(409).json({ error: "no_data" });
    const answer = await askModel(
      "Ты аналитик личной продуктивности. Отвечаешь честно и без морализаторства, не выдумываешь данных.",
      att.buildAskPrompt(question, r.week, r.facts),
      { appPage: req.appPage, maxTokens: 700, temperature: 0.3 },
    );
    res.json({ answer, facts: r.facts });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
