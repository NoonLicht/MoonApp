/**
 * «Следы» решений: для важной заметки или траты сохраняется контекст «почему я
 * так решил» — собирается автоматически из окружающих записей (связанные
 * заметки, запись дневника того дня, расходы вокруг). Через полгода приложение
 * показывает след и спрашивает: «вы были правы?».
 */
import fs from "fs";
import path from "path";

export type TraceKind = "note" | "expense";
export type TraceVerdict = "right" | "partly" | "wrong";

export interface ContextBlock {
  kind: "related" | "diary" | "budget" | "text";
  title: string;
  text: string;
}

export interface Trace {
  id: string;
  kind: TraceKind;
  ref: string;
  title: string;
  /** Что решено (текст заметки или описание траты). */
  decision: string;
  /** Почему — пользовательское пояснение, можно дописать позже. */
  reason: string;
  context: ContextBlock[];
  createdAt: number;
  reviewAt: number;
  verdict: TraceVerdict | null;
  reviewNote: string;
  reviewedAt: number | null;
}

export const REVIEW_DAYS = 180;
const DAY = 86_400_000;

let seq = 0;
const makeId = (now: number): string => `${now.toString(36)}${(seq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function createTrace(
  p: {
    kind: TraceKind;
    ref: string;
    title: string;
    decision: string;
    reason?: string;
    context: ContextBlock[];
    reviewInDays?: number;
  },
  now: number,
): Trace {
  const days = p.reviewInDays && p.reviewInDays > 0 ? Math.min(p.reviewInDays, 3650) : REVIEW_DAYS;
  return {
    id: makeId(now),
    kind: p.kind,
    ref: p.ref,
    title: p.title.slice(0, 120),
    decision: p.decision.slice(0, 2000),
    reason: (p.reason ?? "").slice(0, 2000),
    context: p.context.slice(0, 8).map((c) => ({ ...c, text: c.text.slice(0, 600) })),
    createdAt: now,
    reviewAt: now + days * DAY,
    verdict: null,
    reviewNote: "",
    reviewedAt: null,
  };
}

export function due(traces: Trace[], now: number): Trace[] {
  return traces.filter((t) => t.verdict === null && t.reviewAt <= now).sort((a, b) => a.reviewAt - b.reviewAt);
}

export function review(traces: Trace[], id: string, verdict: TraceVerdict, note: string, now: number): Trace[] {
  return traces.map((t) => (t.id === id ? { ...t, verdict, reviewNote: note.slice(0, 1000), reviewedAt: now } : t));
}

export function update(traces: Trace[], id: string, patch: { reason?: string; reviewInDays?: number }): Trace[] {
  return traces.map((t) => {
    if (t.id !== id) return t;
    return {
      ...t,
      reason: patch.reason !== undefined ? patch.reason.slice(0, 2000) : t.reason,
      reviewAt:
        patch.reviewInDays && patch.reviewInDays > 0
          ? t.createdAt + Math.min(patch.reviewInDays, 3650) * DAY
          : t.reviewAt,
    };
  });
}

export interface Track {
  reviewed: number;
  right: number;
  partly: number;
  wrong: number;
  /** Доля «был прав» (partly считается за половину), 0…100; null — пока нечего считать. */
  score: number | null;
}

export function trackRecord(traces: Trace[]): Track {
  const done = traces.filter((t) => t.verdict !== null);
  const right = done.filter((t) => t.verdict === "right").length;
  const partly = done.filter((t) => t.verdict === "partly").length;
  const wrong = done.filter((t) => t.verdict === "wrong").length;
  return {
    reviewed: done.length,
    right,
    partly,
    wrong,
    score: done.length ? Math.round(((right + partly / 2) / done.length) * 100) : null,
  };
}

/** Блоки контекста из найденных связанных заметок, дневника и бюджета. */
export function contextBlocks(p: {
  related: { title: string; snippet: string }[];
  diary?: string | null;
  budget?: { balance: number; income: number; expense: number } | null;
  date: string;
}): ContextBlock[] {
  const out: ContextBlock[] = [];
  for (const r of p.related.slice(0, 3))
    out.push({ kind: "related", title: r.title, text: r.snippet.replace(/\s+/g, " ").trim() });
  if (p.diary && p.diary.trim())
    out.push({ kind: "diary", title: p.date, text: p.diary.replace(/\s+/g, " ").trim() });
  if (p.budget)
    out.push({
      kind: "budget",
      title: p.date,
      text: `balance ${p.budget.balance}; income ${p.budget.income}; expense ${p.budget.expense}`,
    });
  return out;
}

// ---------------- хранение ----------------

function file(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "decision-traces.json");
}

export function load(f = file()): Trace[] {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function save(t: Trace[], f = file()): void {
  fs.writeFileSync(f, JSON.stringify(t), "utf8");
}
