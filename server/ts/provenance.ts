/**
 * «Автор мысли»: происхождение абзацев заметки — своё, скопированное или
 * написанное ИИ. Приложение запоминает фрагменты, пришедшие из ИИ или вставкой
 * (по «отпечаткам» из 4-словных шинглов), а абзацы заметки сверяет с ними: если
 * хотя бы половина шинглов совпадает — абзац считается чужим. Правки поверх
 * вставленного не обнуляют метку, пока осталась половина текста.
 * Всё, чего нет в журнале, считается своим.
 */
import fs from "fs";
import path from "path";
import { tokenize } from "./hybridRank";

export type Origin = "own" | "copied" | "ai";

export interface Record_ {
  o: "copied" | "ai";
  /** Хэши шинглов (base36). */
  sig: string[];
  at: number;
}

export type Store = Record<string, Record_[]>;

const SHINGLE = 4;
const MAX_SIG = 800;
const MAX_RECORDS = 80;
const THRESHOLD = 0.5;

function h32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Множество шинглов текста; короткий текст даёт один шингл из всех слов. */
export function shingles(text: string): Set<string> {
  const w = tokenize(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < SHINGLE) {
    out.add(h32(w.join(" ")));
    return out;
  }
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(h32(w.slice(i, i + SHINGLE).join(" ")));
  return out;
}

export function record(store: Store, notePath: string, text: string, o: "copied" | "ai", now: number): Store {
  const sig = [...shingles(text)].slice(0, MAX_SIG);
  if (sig.length === 0) return store;
  const list = [...(store[notePath] ?? []), { o, sig, at: now }].slice(-MAX_RECORDS);
  return { ...store, [notePath]: list };
}

export interface Paragraph {
  start: number;
  end: number;
  text: string;
  words: number;
  origin: Origin;
}

/** Абзацы по пустым строкам, с позициями в исходном тексте. */
export function paragraphs(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

export function classify(store: Store, notePath: string, text: string): Paragraph[] {
  const recs = (store[notePath] ?? []).map((r) => ({ o: r.o, set: new Set(r.sig) }));
  return paragraphs(text).map((p) => {
    // заголовки, код и чистые списки ссылок не классифицируем
    const body = p.text.replace(/^\s*#{1,6}\s.*$/gm, "").trim();
    const words = tokenize(body).length;
    let origin: Origin = "own";
    if (words >= 4 && recs.length) {
      const mine = shingles(body);
      let best: { o: "copied" | "ai"; c: number } | null = null;
      for (const r of recs) {
        let hit = 0;
        for (const s of mine) if (r.set.has(s)) hit++;
        const c = mine.size ? hit / mine.size : 0;
        if (c >= THRESHOLD && (!best || c > best.c)) best = { o: r.o, c };
      }
      if (best) origin = best.o;
    }
    return { start: p.start, end: p.end, text: p.text, words, origin };
  });
}

export interface Summary {
  own: number;
  copied: number;
  ai: number;
  /** Доли по числу слов, 0…100. */
  pct: { own: number; copied: number; ai: number };
}

export function summarize(paras: Paragraph[]): Summary {
  const s = { own: 0, copied: 0, ai: 0 };
  for (const p of paras) s[p.origin] += p.words;
  const total = s.own + s.copied + s.ai || 1;
  return {
    ...s,
    pct: {
      own: Math.round((s.own / total) * 100),
      copied: Math.round((s.copied / total) * 100),
      ai: Math.round((s.ai / total) * 100),
    },
  };
}

// ---------------- хранение ----------------

function file(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "provenance.json");
}

export function load(f = file()): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function save(s: Store, f = file()): void {
  fs.writeFileSync(f, JSON.stringify(s), "utf8");
}

/** Переименование/удаление заметки: перенос или очистка журнала. */
export function move(store: Store, from: string, to: string | null): Store {
  if (!store[from]) return store;
  const next = { ...store };
  const v = next[from];
  delete next[from];
  if (to) next[to] = v;
  return next;
}
