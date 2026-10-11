/**
 * Дополнительные инструменты заметок (чистые функции):
 *  - подсказка тегов «по смыслу»: берём теги самых похожих по словам заметок;
 *  - шаблоны заметок с подстановкой {{date}}, {{time}}, {{title}};
 *  - сравнение двух конспектов: общее и то, что есть только в одном из них.
 */
import { tokenize } from "./hybridRank";

/* ------------------------------ Теги по смыслу ------------------------------ */

export interface TaggedNote {
  path: string;
  content: string;
  tags: string[];
}

export interface TagSuggestion {
  tag: string;
  score: number;
  /** Заметки, из-за которых предложен тег. */
  from: string[];
}

const stem = (w: string): string => (w.length > 5 ? w.slice(0, 5) : w);

function vector(text: string): Map<string, number> {
  const v = new Map<string, number>();
  for (const tok of tokenize(text)) {
    if (tok.length < 3) continue;
    const s = stem(tok);
    v.set(s, (v.get(s) ?? 0) + 1);
  }
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) {
    const w = idf.get(k) ?? 1;
    na += (x * w) ** 2;
    const y = b.get(k);
    if (y) dot += x * w * y * w;
  }
  for (const [k, y] of b) nb += (y * (idf.get(k) ?? 1)) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Подсказывает теги тексту: сходство (TF-IDF, косинус) с заметками, у которых
 * уже есть теги; тег получает сумму сходств соседей. Уже имеющиеся теги пропускаются.
 */
export function suggestTags(
  text: string,
  notes: TaggedNote[],
  opts: { have?: string[]; limit?: number; selfPath?: string } = {},
): TagSuggestion[] {
  const have = new Set((opts.have ?? []).map((t) => t.toLowerCase()));
  const pool = notes.filter((n) => n.tags.length && n.path !== opts.selfPath);
  if (!pool.length) return [];
  const vecs = pool.map((n) => vector(n.content));
  const df = new Map<string, number>();
  for (const v of vecs) for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [k, d] of df) idf.set(k, Math.log(1 + pool.length / d));
  const me = vector(text);
  const score = new Map<string, TagSuggestion>();
  pool.forEach((n, i) => {
    const s = cosine(me, vecs[i], idf);
    if (s < 0.08) return;
    for (const tag of n.tags) {
      if (have.has(tag.toLowerCase())) continue;
      const cur = score.get(tag) ?? { tag, score: 0, from: [] };
      cur.score += s;
      cur.from.push(n.path);
      score.set(tag, cur);
    }
  });
  return [...score.values()]
    .map((x) => ({ ...x, score: Math.round(x.score * 1000) / 1000, from: x.from.slice(0, 3) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 8);
}

/* --------------------------------- Шаблоны --------------------------------- */

export interface NoteTemplate {
  id: string;
  title: string;
  body: string;
}

export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  {
    id: "daily",
    title: "День",
    body: "# {{date}}\n\n## План\n- [ ] \n\n## Заметки\n\n## Итоги\n",
  },
  {
    id: "meeting",
    title: "Встреча",
    body: "# {{title}}\n\n**Дата:** {{date}} {{time}}\n**Участники:** \n\n## Повестка\n\n## Решения\n\n## Задачи\n- [ ] \n",
  },
  {
    id: "lecture",
    title: "Конспект лекции",
    body: "# {{title}}\n\n*{{date}}*\n\n## Ключевые идеи\n\n## Термины\n\n## Вопросы\n\n## Кратко\n",
  },
  {
    id: "book",
    title: "Книга",
    body: "# {{title}}\n\n**Автор:** \n**Прочитано:** {{date}}\n\n## О чём\n\n## Цитаты\n\n## Что возьму себе\n",
  },
];

const pad = (n: number): string => String(n).padStart(2, "0");

/** Подставляет {{date}} (ГГГГ-ММ-ДД), {{time}} (ЧЧ:ММ), {{title}}; неизвестные поля остаются как есть. */
export function renderTemplate(body: string, ctx: { title?: string; now?: Date } = {}): string {
  const d = ctx.now ?? new Date();
  const vars: Record<string, string> = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    title: ctx.title ?? "",
  };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/* ----------------------------- Сравнение конспектов ----------------------------- */

export interface NoteComparison {
  common: string[];
  onlyA: string[];
  onlyB: string[];
  /** Доля общих утверждений (Жаккар), 0..1. */
  similarity: number;
}

function sentences(md: string): string[] {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+[.)])[ \t]+/gm, "")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/[*_`]/g, "").trim())
    .filter((s) => s.length >= 8);
}

const keyOf = (s: string): Set<string> => new Set(tokenize(s).filter((t) => t.length > 2).map(stem));

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}

/** Сравнивает два конспекта по предложениям: пара считается общей при пересечении слов ≥ порога. */
export function compareNotes(a: string, b: string, threshold = 0.6): NoteComparison {
  const sa = sentences(a);
  const sb = sentences(b);
  const ka = sa.map(keyOf);
  const kb = sb.map(keyOf);
  const usedB = new Set<number>();
  const common: string[] = [];
  const onlyA: string[] = [];
  sa.forEach((s, i) => {
    let best = -1;
    let bestScore = 0;
    kb.forEach((k, j) => {
      if (usedB.has(j)) return;
      const o = overlap(ka[i], k);
      if (o > bestScore) {
        bestScore = o;
        best = j;
      }
    });
    if (best >= 0 && bestScore >= threshold) {
      usedB.add(best);
      common.push(s);
    } else onlyA.push(s);
  });
  const onlyB = sb.filter((_s, j) => !usedB.has(j));
  const total = common.length + onlyA.length + onlyB.length;
  return { common, onlyA, onlyB, similarity: total ? Math.round((common.length / total) * 100) / 100 : 0 };
}
