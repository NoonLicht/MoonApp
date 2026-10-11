/**
 * Общие текстовые приёмы для аналитики по заметкам: стоп-слова, ключи слов
 * (грубая основа без словаря), частоты и косинус. Чистые функции.
 */
import { tokenize } from "./hybridRank";

export const STOPWORDS = new Set(
  (
    // русские служебные и частые слова
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня " +
      "еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам " +
      "ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто " +
      "чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти " +
      "мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над " +
      "больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед " +
      "иногда лучше чуть том нельзя такой им более всегда конечно всю между это этих также которые который " +
      "которая которое которых очень просто можно нужно будет надо чтобы такие такое такой так как " +
      // английские
      "the and for are but not you all any can had her was one our out has have this that with from they will " +
      "would there their what about which when your said each she how them than then these some into more other " +
      "http https www com org net html htm txt file md png jpg pdf"
  ).split(/\s+/),
);

/** Ключ слова: первые 6 букв (числа не трогаем) — «энтропия»/«энтропией» дают один ключ. */
export const stemKey = (w: string): string => (/^\p{N}+$/u.test(w) ? w : w.slice(0, 6));

export interface TermCounts {
  /** ключ → число вхождений */
  counts: Map<string, number>;
  /** ключ → самая частая исходная форма (для показа) */
  surface: Map<string, string>;
  total: number;
}

export function termCounts(text: string, minLen = 3): TermCounts {
  const counts = new Map<string, number>();
  const forms = new Map<string, Map<string, number>>();
  let total = 0;
  for (const w of tokenize(String(text ?? ""))) {
    if (w.length < minLen || STOPWORDS.has(w) || /^\p{N}+$/u.test(w)) continue;
    const k = stemKey(w);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const f = forms.get(k) ?? new Map<string, number>();
    f.set(w, (f.get(w) ?? 0) + 1);
    forms.set(k, f);
    total++;
  }
  const surface = new Map<string, string>();
  for (const [k, f] of forms) {
    let best = "";
    let n = 0;
    for (const [w, c] of f) if (c > n || (c === n && w.length < best.length)) [best, n] = [w, c];
    surface.set(k, best);
  }
  return { counts, surface, total };
}

export function mergeCounts(into: TermCounts, from: TermCounts): void {
  for (const [k, c] of from.counts) into.counts.set(k, (into.counts.get(k) ?? 0) + c);
  for (const [k, s] of from.surface) if (!into.surface.has(k)) into.surface.set(k, s);
  into.total += from.total;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) {
    nb += v * v;
    const x = a.get(k);
    if (x) dot += x * v;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
