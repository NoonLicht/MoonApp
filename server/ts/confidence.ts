/**
 * Градус уверенности: утверждения в заметках можно помечать «{70%: текст}» или
 * «{70% до 2026-12-01: текст}». Метки собираются в журнал; по сроку приложение
 * просит проверить, сбылось ли, а по итогам считает калибровку (насколько
 * ваша уверенность совпадает с реальностью) и счёт Бриера.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

export interface Mark {
  pct: number;
  claim: string;
  /** YYYY-MM-DD или null — срок по умолчанию. */
  due: string | null;
  index: number;
}

const MARK = /\{\s*(\d{1,3})\s*%\s*(?:до\s+(\d{4}-\d{2}-\d{2})\s*)?[:|]\s*([^{}\n]{3,300})\}/g;

export function parseMarks(text: string): Mark[] {
  const out: Mark[] = [];
  for (const m of String(text ?? "").matchAll(MARK)) {
    const pct = Number(m[1]);
    if (pct < 0 || pct > 100) continue;
    out.push({ pct, claim: m[3].trim(), due: m[2] ?? null, index: m.index ?? 0 });
  }
  return out;
}

export interface Entry {
  id: string;
  path: string;
  claim: string;
  pct: number;
  /** YYYY-MM-DD, когда стоит проверить. */
  due: string;
  createdAt: number;
  outcome: boolean | null;
  resolvedAt: number | null;
}

export const DEFAULT_DAYS = 30;

const ymd = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const entryId = (notePath: string, claim: string): string =>
  createHash("sha1").update(`${notePath}\u0000${claim.toLowerCase()}`).digest("hex").slice(0, 12);

/**
 * Добавляет новые метки из заметки в журнал. Существующие (по заметке и тексту)
 * сохраняют результат; если процент в тексте изменили до проверки — он обновляется.
 */
export function syncNote(
  entries: Entry[],
  notePath: string,
  text: string,
  now: number,
): { entries: Entry[]; added: number } {
  const marks = parseMarks(text);
  const byId = new Map(entries.map((e) => [e.id, e]));
  let added = 0;
  for (const m of marks) {
    const id = entryId(notePath, m.claim);
    const cur = byId.get(id);
    if (cur) {
      if (cur.outcome === null && (cur.pct !== m.pct || (m.due && cur.due !== m.due))) {
        byId.set(id, { ...cur, pct: m.pct, due: m.due ?? cur.due });
      }
      continue;
    }
    byId.set(id, {
      id,
      path: notePath,
      claim: m.claim,
      pct: m.pct,
      due: m.due ?? ymd(now + DEFAULT_DAYS * 86_400_000),
      createdAt: now,
      outcome: null,
      resolvedAt: null,
    });
    added++;
  }
  return { entries: [...byId.values()], added };
}

export function dueEntries(entries: Entry[], today: string): Entry[] {
  return entries.filter((e) => e.outcome === null && e.due <= today).sort((a, b) => a.due.localeCompare(b.due));
}

export function resolve(entries: Entry[], id: string, outcome: boolean, now: number): Entry[] {
  return entries.map((e) => (e.id === id ? { ...e, outcome, resolvedAt: now } : e));
}

export interface Calibration {
  resolved: number;
  /** Средний квадрат ошибки: 0 идеально, 0.25 — как «50 на 50». */
  brier: number | null;
  /** Корзины по 20 %: насколько заявленное совпало с фактическим. */
  buckets: { from: number; to: number; n: number; predicted: number; actual: number }[];
  /** >0 — переоценка себя, <0 — недооценка (в процентных пунктах). */
  bias: number | null;
}

export function calibration(entries: Entry[]): Calibration {
  const done = entries.filter((e) => e.outcome !== null);
  if (!done.length) return { resolved: 0, brier: null, buckets: [], bias: null };
  let brier = 0;
  let predSum = 0;
  let hit = 0;
  const bins: { n: number; pred: number; hit: number }[] = Array.from({ length: 5 }, () => ({
    n: 0,
    pred: 0,
    hit: 0,
  }));
  for (const e of done) {
    const p = e.pct / 100;
    const o = e.outcome ? 1 : 0;
    brier += (p - o) ** 2;
    predSum += p;
    hit += o;
    const b = Math.min(4, Math.floor(e.pct / 20));
    bins[b].n++;
    bins[b].pred += p;
    bins[b].hit += o;
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    resolved: done.length,
    brier: r(brier / done.length),
    buckets: bins
      .map((b, i) => ({
        from: i * 20,
        to: i === 4 ? 100 : i * 20 + 19,
        n: b.n,
        predicted: b.n ? Math.round((b.pred / b.n) * 100) : 0,
        actual: b.n ? Math.round((b.hit / b.n) * 100) : 0,
      }))
      .filter((b) => b.n > 0),
    bias: Math.round((predSum / done.length - hit / done.length) * 100),
  };
}

// ---------------- хранение ----------------

function file(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "confidence.json");
}

export function load(f = file()): Entry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function save(entries: Entry[], f = file()): void {
  fs.writeFileSync(f, JSON.stringify(entries), "utf8");
}
