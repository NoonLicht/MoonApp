/**
 * Инструменты «Мышление» для заметок.
 *
 *  POST /api/mind/contradictions        — { path, text } → прошлые утверждения, противоречащие текущим
 *  POST /api/mind/review                — { text, focus? } → вопросы рецензента (без переписывания)
 *  POST /api/mind/confidence/sync       — { path?, text? } → собрать метки «{70%: …}» (все заметки, если path не задан)
 *  GET  /api/mind/confidence            — { entries, due, calibration }
 *  POST /api/mind/confidence/:id/resolve — { outcome: boolean }
 *  POST /api/mind/provenance/record     — { path, text, origin: copied|ai } → запомнить происхождение
 *  POST /api/mind/provenance/classify   — { path, text } → абзацы с происхождением и доли
 *  GET  /api/mind/traces                — { items, due, track }
 *  POST /api/mind/traces                — { kind, ref, title, decision, reason?, reviewInDays? }
 *  PATCH /api/mind/traces/:id           — { reason?, reviewInDays? }
 *  POST /api/mind/traces/:id/review     — { verdict: right|partly|wrong, note? }
 *  DELETE /api/mind/traces/:id
 */
import express from "express";
import fs from "fs";
import path from "path";
import config from "../config";
import * as semantic from "../semantic";
import * as diary from "../diary";
import * as budget from "../budget";
import * as tm from "../timeMachine";
import * as ct from "../contradictions";
import * as conf from "../confidence";
import * as prov from "../provenance";
import * as rv from "../reviewer";
import * as dt from "../decisionTraces";
import * as corpus from "../vaultCorpus";
import { askModel } from "../llmOnce";

const router = express.Router();

/** Текст заметки из хранилища; путь не выходит за пределы папки заметок. */
function readNote(rel: string): string {
  const root = path.resolve(config.DIRS.vaultNotes);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

const today = (): string => tm.dateKey(Date.now());

// ---------------- противоречия ----------------

router.post("/contradictions", async (req, res) => {
  try {
    const self = String(req.body?.path ?? "");
    const text = String(req.body?.text ?? "").slice(0, 30_000);
    const claims = ct.extractClaims(text, 10);
    if (!claims.length) return res.json({ claims: 0, findings: [], model: "skipped" });

    const pairs: (ct.Pair & { ref: string; heuristic: ReturnType<typeof ct.heuristicConflict> })[] = [];
    const seen = new Set<string>();
    for (const c of claims) {
      const hits = await semantic.search(c.text, { sources: ["note"], limit: 5 });
      for (const h of hits) {
        if (h.ref === self) continue;
        const passage = ct.bestPassage(readNote(h.ref) || h.snippet, c.text);
        const key = `${c.text}\u0000${h.ref}`;
        if (!passage || seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          claim: c.text,
          source: h.title,
          ref: h.ref,
          passage,
          heuristic: ct.heuristicConflict(c.text, passage),
        });
        if (pairs.length >= 24) break;
      }
      if (pairs.length >= 24) break;
    }
    if (!pairs.length) return res.json({ claims: claims.length, findings: [], model: "skipped" });

    // Модели отдаём пары с эвристическим признаком, остальное добираем до 16.
    const batch = [...pairs.filter((p) => p.heuristic), ...pairs.filter((p) => !p.heuristic)].slice(0, 16);

    let model: "ok" | "failed" = "ok";
    let judged: ct.Judged[] = [];
    try {
      const raw = await askModel(
        "Ты внимательный логик. Отвечаешь строго в заданном JSON-формате.",
        ct.buildJudgePrompt(batch),
        { appPage: req.appPage, maxTokens: 900, temperature: 0, feature: "notes.mind" },
      );
      judged = ct.parseVerdicts(raw, batch.length);
    } catch {
      model = "failed";
    }
    const verdictOf = new Map(judged.map((j) => [j.n, j]));

    const findings = batch
      .map((p, i) => {
        const j = verdictOf.get(i + 1);
        const byModel = j?.verdict === "contradiction";
        const byHeuristic = model === "failed" && !!p.heuristic;
        if (!byModel && !byHeuristic) return null;
        return {
          claim: p.claim,
          source: p.source,
          ref: p.ref,
          passage: p.passage,
          why: j?.why || (p.heuristic === "negation" ? "negation" : "number"),
          by: byModel ? ("model" as const) : ("heuristic" as const),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    res.json({ claims: claims.length, findings, model });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------------- рецензент ----------------

router.post("/review", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (text.length < 40) return res.status(400).json({ error: "text_too_short" });
    const focus = (["general", "evidence", "audience", "logic"] as const).includes(req.body?.focus)
      ? (req.body.focus as rv.ReviewFocus)
      : "general";
    const raw = await askModel(
      "Ты рецензент. Только вопросы, никаких переписываний и советов.",
      rv.buildReviewPrompt(text, focus),
      { appPage: req.appPage, maxTokens: 700, temperature: 0.4, feature: "notes.mind" },
    );
    res.json({ questions: rv.parseQuestions(raw) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------------- градус уверенности ----------------

router.post("/confidence/sync", (req, res) => {
  try {
    const now = Date.now();
    let entries = conf.load();
    let added = 0;
    const single = String(req.body?.path ?? "");
    const notes = single
      ? [{ ref: single, text: String(req.body?.text ?? "") }]
      : corpus.collectNotes().map((n) => ({ ref: n.ref, text: n.text }));
    for (const n of notes) {
      const r = conf.syncNote(entries, n.ref, n.text, now);
      entries = r.entries;
      added += r.added;
    }
    conf.save(entries);
    res.json({ added, total: entries.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/confidence", (_req, res) => {
  const entries = conf.load();
  res.json({
    entries: entries.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
    due: conf.dueEntries(entries, today()),
    calibration: conf.calibration(entries),
  });
});

router.post("/confidence/:id/resolve", (req, res) => {
  const entries = conf.load();
  if (!entries.some((e) => e.id === req.params.id)) return res.status(404).json({ error: "not_found" });
  conf.save(conf.resolve(entries, req.params.id, req.body?.outcome === true, Date.now()));
  res.json({ ok: true });
});

// ---------------- автор мысли ----------------

router.post("/provenance/record", (req, res) => {
  const origin = req.body?.origin === "ai" ? "ai" : req.body?.origin === "copied" ? "copied" : null;
  const notePath = String(req.body?.path ?? "");
  const text = String(req.body?.text ?? "").slice(0, 100_000);
  if (!origin || !notePath || !text.trim()) return res.status(400).json({ error: "bad_params" });
  prov.save(prov.record(prov.load(), notePath, text, origin, Date.now()));
  res.json({ ok: true });
});

router.post("/provenance/classify", (req, res) => {
  const notePath = String(req.body?.path ?? "");
  const text = String(req.body?.text ?? "").slice(0, 200_000);
  const paras = prov.classify(prov.load(), notePath, text);
  res.json({
    paragraphs: paras.map((p) => ({ start: p.start, end: p.end, words: p.words, origin: p.origin })),
    summary: prov.summarize(paras),
  });
});

// ---------------- следы решений ----------------

router.get("/traces", (_req, res) => {
  const all = dt.load();
  res.json({
    items: all.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
    due: dt.due(all, Date.now()),
    track: dt.trackRecord(all),
  });
});

router.post("/traces", async (req, res) => {
  try {
    const kind = req.body?.kind === "expense" ? "expense" : "note";
    const title = String(req.body?.title ?? "").trim();
    const decision = String(req.body?.decision ?? "").trim();
    if (!title || !decision) return res.status(400).json({ error: "bad_params" });
    const now = Date.now();
    const date = tm.dateKey(now);

    const related = (await semantic.search(`${title}\n${decision}`.slice(0, 600), { sources: ["note"], limit: 5 }))
      .filter((h) => h.ref !== String(req.body?.ref ?? ""))
      .slice(0, 3)
      .map((h) => ({ title: h.title, snippet: h.snippet }));
    let diaryText: string | null = null;
    try {
      const e = diary.readEntry(date);
      diaryText = e.exists ? e.content.slice(0, 500) : null;
    } catch {
      /* дневника за сегодня нет */
    }
    let bud: { balance: number; income: number; expense: number } | null = null;
    try {
      const b = tm.budgetAsOf(budget.list(), date);
      bud = { balance: b.balance, income: b.income, expense: b.expense };
    } catch {
      /* бюджета нет */
    }
    const trace = dt.createTrace(
      {
        kind,
        ref: String(req.body?.ref ?? ""),
        title,
        decision,
        reason: String(req.body?.reason ?? ""),
        reviewInDays: Number(req.body?.reviewInDays) || undefined,
        context: dt.contextBlocks({ related, diary: diaryText, budget: bud, date }),
      },
      now,
    );
    dt.save([...dt.load(), trace]);
    res.json(trace);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.patch("/traces/:id", (req, res) => {
  const all = dt.load();
  if (!all.some((t) => t.id === req.params.id)) return res.status(404).json({ error: "not_found" });
  const patch: { reason?: string; reviewInDays?: number } = {};
  if (typeof req.body?.reason === "string") patch.reason = req.body.reason;
  if (Number(req.body?.reviewInDays) > 0) patch.reviewInDays = Number(req.body.reviewInDays);
  dt.save(dt.update(all, req.params.id, patch));
  res.json({ ok: true });
});

router.post("/traces/:id/review", (req, res) => {
  const v = req.body?.verdict;
  if (v !== "right" && v !== "partly" && v !== "wrong") return res.status(400).json({ error: "bad_verdict" });
  const all = dt.load();
  if (!all.some((t) => t.id === req.params.id)) return res.status(404).json({ error: "not_found" });
  dt.save(dt.review(all, req.params.id, v, String(req.body?.note ?? ""), Date.now()));
  res.json({ ok: true });
});

router.delete("/traces/:id", (req, res) => {
  dt.save(dt.load().filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

export = router;
