/**
 * Семантический «дрейф»: как менялись интересы по месяцам. По документам с
 * датой (заметки, закладки, лекции, чаты) считает для каждого месяца самые
 * характерные слова (TF-IDF по месяцам), новые и угасающие темы и «силу сдвига»
 * относительно прошлого месяца. Лексический метод: работает без модели.
 */
import { termCounts, mergeCounts, cosine, type TermCounts } from "./textStats";

export interface DriftDoc {
  /** Момент создания/изменения, мс. */
  at: number;
  text: string;
  source: string;
}

export interface MonthTheme {
  term: string;
  score: number;
}

export interface MonthDrift {
  month: string;
  docs: number;
  bySource: Record<string, number>;
  top: MonthTheme[];
  /** Характерные слова месяца, которых не было в двух предыдущих. */
  emerging: string[];
  /** Были заметны раньше, а в этом месяце пропали. */
  fading: string[];
  /** 0…1: насколько месяц отличается от предыдущего. null — предыдущего нет. */
  shift: number | null;
}

export interface DriftReport {
  months: MonthDrift[];
  /** Слова, характерные почти для всех месяцев — «постоянные интересы». */
  persistent: string[];
  biggestShift: { month: string; shift: number } | null;
  topOverall: string | null;
}

const monthKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function analyzeDrift(
  docs: DriftDoc[],
  o: { topN?: number; minDocsPerMonth?: number } = {},
): DriftReport {
  const topN = o.topN ?? 8;
  const minDocs = o.minDocsPerMonth ?? 1;
  const byMonth = new Map<string, { tc: TermCounts; docs: number; bySource: Record<string, number> }>();
  for (const d of docs) {
    if (!d.text || !Number.isFinite(d.at)) continue;
    const k = monthKey(d.at);
    let m = byMonth.get(k);
    if (!m) byMonth.set(k, (m = { tc: { counts: new Map(), surface: new Map(), total: 0 }, docs: 0, bySource: {} }));
    // один документ вносит каждое слово с убывающим весом, чтобы длинная заметка не забивала месяц
    const tc = termCounts(d.text);
    for (const [key, c] of tc.counts) tc.counts.set(key, 1 + Math.log(c));
    mergeCounts(m.tc, tc);
    m.docs++;
    m.bySource[d.source] = (m.bySource[d.source] ?? 0) + 1;
  }
  const keys = [...byMonth.keys()].filter((k) => (byMonth.get(k)?.docs ?? 0) >= minDocs).sort();
  const n = keys.length;
  if (!n) return { months: [], persistent: [], biggestShift: null, topOverall: null };

  // IDF по месяцам: слово, которое есть в каждом месяце, не характеризует ни один из них.
  const df = new Map<string, number>();
  for (const k of keys) for (const t of byMonth.get(k)!.tc.counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5)) + 0.5;

  const vectors = new Map<string, Map<string, number>>();
  const surface = new Map<string, string>();
  for (const k of keys) {
    const m = byMonth.get(k)!;
    const v = new Map<string, number>();
    for (const [t, c] of m.tc.counts) v.set(t, c * idf(t));
    vectors.set(k, v);
    for (const [t, s] of m.tc.surface) if (!surface.has(t)) surface.set(t, s);
  }
  const name = (t: string): string => surface.get(t) ?? t;
  const topOf = (k: string): [string, number][] =>
    [...vectors.get(k)!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN);

  const months: MonthDrift[] = [];
  const inTop = new Map<string, Set<string>>();
  keys.forEach((k, i) => {
    const top = topOf(k);
    const topKeys = new Set(top.map(([t]) => t));
    inTop.set(k, topKeys);
    const prev = keys.slice(Math.max(0, i - 2), i);
    const seenBefore = new Set<string>();
    for (const p of prev) for (const t of inTop.get(p) ?? []) seenBefore.add(t);
    const emerging = i === 0 ? [] : top.map(([t]) => t).filter((t) => !seenBefore.has(t));
    const fading =
      i === 0
        ? []
        : [...(inTop.get(keys[i - 1]) ?? [])].filter((t) => !topKeys.has(t) && !(vectors.get(k)!.get(t) ?? 0));
    const m = byMonth.get(k)!;
    months.push({
      month: k,
      docs: m.docs,
      bySource: m.bySource,
      top: top.map(([t, s]) => ({ term: name(t), score: Math.round(s * 100) / 100 })),
      emerging: emerging.map(name),
      fading: fading.map(name),
      shift: i === 0 ? null : Math.round((1 - cosine(vectors.get(keys[i - 1])!, vectors.get(k)!)) * 100) / 100,
    });
  });

  // постоянные интересы: слово входит в топ минимум половины месяцев (и не менее чем 2)
  const presence = new Map<string, number>();
  for (const set of inTop.values()) for (const t of set) presence.set(t, (presence.get(t) ?? 0) + 1);
  const persistent = [...presence.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.ceil(n / 2)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => name(t));

  const shifts = months.filter((m) => m.shift !== null);
  const biggest = shifts.reduce<MonthDrift | null>((b, m) => (!b || (m.shift ?? 0) > (b.shift ?? 0) ? m : b), null);

  // общая главная тема — сумма весов по всем месяцам
  const total = new Map<string, number>();
  for (const v of vectors.values()) for (const [t, s] of v) total.set(t, (total.get(t) ?? 0) + s);
  const best = [...total.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    months,
    persistent,
    biggestShift: biggest && biggest.shift !== null ? { month: biggest.month, shift: biggest.shift } : null,
    topOverall: best ? name(best[0]) : null,
  };
}
