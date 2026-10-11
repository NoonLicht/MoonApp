/**
 * Карта белых пятен: что у вас описано подробно, а что упомянуто, но не
 * раскрыто. Без модели находит «висячие» вики-ссылки ([[Тема]] без заметки) и
 * темы с большим числом заметок; с моделью — предлагает связанные подтемы,
 * для каждой считается, сколько ваших документов её затрагивают (0 — пятно).
 */
import { termCounts, stemKey } from "./textStats";
import { tokenize } from "./hybridRank";

export interface GapDoc {
  ref: string;
  title: string;
  text: string;
}

export interface TopicCoverage {
  term: string;
  docs: number;
}

/** Самые частые по числу документов слова (тема = слово, встречающееся в ≥ minDocs документах). */
export function topTopics(docs: GapDoc[], o: { topN?: number; minDocs?: number } = {}): TopicCoverage[] {
  const df = new Map<string, number>();
  const surface = new Map<string, string>();
  for (const d of docs) {
    const tc = termCounts(`${d.title}\n${d.text}`);
    for (const k of tc.counts.keys()) {
      df.set(k, (df.get(k) ?? 0) + 1);
      if (!surface.has(k)) surface.set(k, tc.surface.get(k) ?? k);
    }
  }
  const min = o.minDocs ?? 3;
  return [...df.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, o.topN ?? 20)
    .map(([k, n]) => ({ term: surface.get(k) ?? k, docs: n }));
}

export interface DanglingLink {
  target: string;
  mentions: number;
  from: string[];
}

const normTitle = (s: string): string => s.trim().toLowerCase().replace(/\.md$/i, "").replace(/\s+/g, " ");

/** Вики-ссылки на несуществующие заметки, по убыванию числа упоминаний. */
export function danglingLinks(docs: GapDoc[]): DanglingLink[] {
  const have = new Set(docs.map((d) => normTitle(d.title)));
  const byTarget = new Map<string, { display: string; from: Set<string>; n: number }>();
  for (const d of docs) {
    for (const m of d.text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const raw = m[1].trim();
      if (!raw || /^(task|canvas):/i.test(raw)) continue;
      const base = raw.split("/").pop() ?? raw;
      const key = normTitle(base);
      if (have.has(key) || have.has(normTitle(raw))) continue;
      const cur = byTarget.get(key) ?? { display: base, from: new Set<string>(), n: 0 };
      cur.n++;
      cur.from.add(d.title);
      byTarget.set(key, cur);
    }
  }
  return [...byTarget.values()]
    .map((v) => ({ target: v.display, mentions: v.n, from: [...v.from].slice(0, 5) }))
    .sort((a, b) => b.mentions - a.mentions || a.target.localeCompare(b.target));
}

/** Сколько документов затрагивают тему: все слова темы (по ключам) присутствуют в документе. */
export function coverageOf(topic: string, docs: GapDoc[]): number {
  const keys = tokenize(topic).map(stemKey);
  if (!keys.length) return 0;
  let n = 0;
  for (const d of docs) {
    const have = new Set(tokenize(`${d.title}\n${d.text}`).map(stemKey));
    if (keys.every((k) => have.has(k))) n++;
  }
  return n;
}

export function buildSuggestPrompt(topic: string, covered: TopicCoverage[]): string {
  return (
    `Пользователь ведёт заметки. Основная тема: «${topic}».\n` +
    `Темы, которые у него уже хорошо раскрыты: ${covered.map((t) => t.term).join(", ") || "—"}.\n` +
    `Назови 10 важных связанных подтем или понятий по теме «${topic}», которые обычно изучают вместе с ней. ` +
    `Только список, по одному пункту в строке, 1–4 слова, без пояснений и нумерации.`
  );
}

/** Строки ответа модели → короткие темы без маркеров и дублей. */
export function parseSuggestions(text: string, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/[«»"*_`]/g, "")
      .replace(/\s+[—–-]\s+.*$/, "")
      .trim();
    if (t.length < 2 || t.length > 60 || t.split(/\s+/).length > 5) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export interface GapReport {
  topic: string;
  covered: number;
  items: { topic: string; docs: number; gap: boolean }[];
}

export function gapReport(topic: string, suggestions: string[], docs: GapDoc[]): GapReport {
  const items = suggestions
    .map((s) => ({ topic: s, docs: coverageOf(s, docs) }))
    .map((x) => ({ ...x, gap: x.docs <= 1 }))
    .sort((a, b) => a.docs - b.docs || a.topic.localeCompare(b.topic));
  return { topic, covered: coverageOf(topic, docs), items };
}
