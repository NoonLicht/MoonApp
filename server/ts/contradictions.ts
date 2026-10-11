/**
 * Детектор противоречий: утверждения из текущей заметки сравниваются с
 * фрагментами ваших прошлых заметок. Кандидатов подбирает поиск, вердикт
 * выносит модель (по пачке пар за один запрос); без модели работает
 * эвристика: то же подлежащее + отрицание или другое число.
 */
import { tokenize } from "./hybridRank";
import { STOPWORDS, stemKey } from "./textStats";

export interface Claim {
  text: string;
  /** Позиция в исходном тексте (для подсветки). */
  index: number;
}

const ASSERT_HINT =
  /(?<![\p{L}])(?:является|есть|значит|означает|всегда|никогда|лучше|хуже|больше|меньше|должен|должна|нельзя|можно|нужно|потому что|поэтому|равно|составляет|так как|is|are|always|never|better|worse|must|should)(?![\p{L}])|\d/iu;

/** Предложения-утверждения: достаточно длинные, не вопросы, с «утвердительными» признаками. */
export function extractClaims(text: string, max = 12): Claim[] {
  const clean = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---\n/, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/[#>*_`|]/g, " ");
  const out: Claim[] = [];
  const re = /[^.!?\n]+[.!?]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) && out.length < max * 3) {
    const s = m[0].replace(/\s+/g, " ").trim();
    if (s.length < 25 || s.length > 280 || s.endsWith("?")) continue;
    if (tokenize(s).length < 4) continue;
    if (!ASSERT_HINT.test(s)) continue;
    out.push({ text: s, index: m.index });
  }
  // длинные и с числами — информативнее
  return out
    .sort((a, b) => score(b.text) - score(a.text) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
}

const score = (s: string): number => (/\d/.test(s) ? 20 : 0) + Math.min(s.length, 200) / 10;

export interface Pair {
  claim: string;
  /** Откуда фрагмент (название заметки). */
  source: string;
  passage: string;
}

export function buildJudgePrompt(pairs: Pair[]): string {
  const body = pairs
    .map((p, i) => `#${i + 1}\nА: ${p.claim}\nБ (из «${p.source}»): ${p.passage}`)
    .join("\n\n");
  return (
    `Для каждой пары определи, противоречит ли утверждение Б утверждению А.\n` +
    `Ответ — ТОЛЬКО JSON-массив вида [{"n":1,"verdict":"contradiction|consistent|unrelated","why":"кратко, до 15 слов"}].\n` +
    `contradiction — только если оба не могут быть верны одновременно об одном и том же. ` +
    `Разные темы или уточнения — unrelated или consistent.\n\n${body}`
  );
}

export type Verdict = "contradiction" | "consistent" | "unrelated";

export interface Judged {
  n: number;
  verdict: Verdict;
  why: string;
}

export function parseVerdicts(raw: string, count: number): Judged[] {
  const text = String(raw ?? "");
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  const out: Judged[] = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const o = x as Record<string, unknown>;
    const n = Number(o?.n);
    const v = String(o?.verdict ?? "");
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    if (v !== "contradiction" && v !== "consistent" && v !== "unrelated") continue;
    out.push({ n, verdict: v, why: String(o?.why ?? "").slice(0, 200) });
  }
  return out;
}

// ---------------- эвристика без модели ----------------

const NEG = /(?<![\p{L}])(?:не|нет|никогда|нельзя|без|not|never|no)(?![\p{L}])/iu;
const NUM = /\d+(?:[.,]\d+)?/g;

const content = (s: string): Set<string> =>
  new Set(
    tokenize(s)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .map(stemKey),
  );

/**
 * Возможное противоречие по признакам: утверждения говорят об одном (≥ 3 общих
 * значимых слова) и при этом различаются отрицанием или набором чисел.
 */
export function heuristicConflict(a: string, b: string): "negation" | "number" | null {
  const ca = content(a);
  const cb = content(b);
  let shared = 0;
  for (const k of ca) if (cb.has(k)) shared++;
  if (shared < 3) return null;
  const na = NEG.test(a);
  const nb = NEG.test(b);
  if (na !== nb) return "negation";
  const numsA = (a.match(NUM) ?? []).map((x) => x.replace(",", "."));
  const numsB = (b.match(NUM) ?? []).map((x) => x.replace(",", "."));
  if (numsA.length && numsB.length && !numsA.some((x) => numsB.includes(x))) return "number";
  return null;
}

/** Отрывок вокруг наиболее подходящего предложения (чтобы не слать заметку целиком). */
export function bestPassage(text: string, claim: string, width = 260): string {
  const want = content(claim);
  const sentences = String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 15);
  let best = "";
  let bestN = 0;
  for (const s of sentences) {
    let n = 0;
    for (const k of content(s)) if (want.has(k)) n++;
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  return (best || String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, width);
}
