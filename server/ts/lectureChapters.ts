/**
 * Главы лекции: запись делится на смысловые части по расшифровке — без модели.
 *
 * Скользящие окна из соседних отрывков сравниваются по словам (косинус);
 * граница ставится там, где сходство окон «до» и «после» заметно падает
 * (локальный минимум ниже порога), и/или после долгой паузы. Название главы —
 * самые частые значимые слова части.
 */
import { tokenize, stem } from "./hybridRank";

export interface ChapterChunk {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface Chapter {
  startMs: number;
  endMs: number;
  title: string;
  /** Сколько отрывков расшифровки вошло в главу. */
  chunks: number;
}

const WINDOW = 3;
const MIN_CHAPTER_MS = 60_000;
const LONG_PAUSE_MS = 8_000;

function vec(chunks: ChapterChunk[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const c of chunks)
    for (const t of tokenize(c.text)) {
      if (t.length < 4) continue;
      const s = stem(t);
      v.set(s, (v.get(s) ?? 0) + 1);
    }
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) {
    na += x * x;
    const y = b.get(k);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Самые частые слова части (в исходной форме первого вхождения). */
export function keywords(chunks: ChapterChunk[], n = 3): string[] {
  const count = new Map<string, { w: string; c: number }>();
  for (const ch of chunks)
    for (const t of tokenize(ch.text)) {
      if (t.length < 5) continue;
      const s = stem(t);
      const cur = count.get(s) ?? { w: t, c: 0 };
      cur.c++;
      count.set(s, cur);
    }
  return [...count.values()]
    .sort((a, b) => b.c - a.c || a.w.localeCompare(b.w))
    .slice(0, n)
    .map((x) => x.w);
}

export function buildChapters(input: ChapterChunk[], opts: { minMs?: number; threshold?: number } = {}): Chapter[] {
  const chunks = input
    .filter((c) => String(c.text || "").trim())
    .sort((a, b) => a.start_ms - b.start_ms);
  if (!chunks.length) return [];
  const minMs = opts.minMs ?? MIN_CHAPTER_MS;
  const threshold = opts.threshold ?? 0.12;

  // кандидаты в границы: индекс отрывка, с которого начинается новая глава
  const cuts: number[] = [];
  let lastCut = 0;
  for (let i = 1; i < chunks.length; i++) {
    const left = vec(chunks.slice(Math.max(lastCut, i - WINDOW), i));
    const right = vec(chunks.slice(i, i + WINDOW));
    const sim = cosine(left, right);
    const gap = chunks[i].start_ms - chunks[i - 1].end_ms;
    const longEnough = chunks[i].start_ms - chunks[lastCut].start_ms >= minMs;
    if (longEnough && (sim < threshold || (gap >= LONG_PAUSE_MS && sim < threshold * 2))) {
      cuts.push(i);
      lastCut = i;
    }
  }

  const bounds = [0, ...cuts, chunks.length];
  const out: Chapter[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const part = chunks.slice(bounds[k], bounds[k + 1]);
    out.push({
      startMs: part[0].start_ms,
      endMs: part[part.length - 1].end_ms,
      title: keywords(part).join(", ") || String(k + 1),
      chunks: part.length,
    });
  }
  return out;
}
