/**
 * Чистые функции гибридного поиска: разбор запроса для FTS5 (BM25) и слияние
 * ранжирований (Reciprocal Rank Fusion). Без обращений к БД и модели — под тесты.
 *
 * Зачем гибрид: векторы хорошо ловят смысл («про отпуск» → «поездка на море»),
 * но промахиваются по точным словам, именам, номерам и артикулам. BM25 — наоборот.
 * RRF складывает оба списка, не требуя сопоставимых шкал оценок.
 */

/** Слова короче этого в запрос не берём («и», «в», «на»). */
const MIN_TOKEN = 2;
/** Токены длиннее этого обрезаются до основы — грубый стемминг для русского. */
const STEM_FROM = 6;
const STEM_CUT = 2;
const MAX_TOKENS = 12;

/** Токены запроса: буквы и цифры любого алфавита, нижний регистр. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= MIN_TOKEN);
}

/**
 * Грубая основа слова: у длинных слов отрезаем 2 последние буквы, чтобы
 * «заметками», «заметка», «заметки» нашлись по одному префиксу.
 * Числа и короткие слова не трогаем.
 */
export function stem(token: string): string {
  if (/^\p{N}+$/u.test(token)) return token;
  return token.length >= STEM_FROM ? token.slice(0, token.length - STEM_CUT) : token;
}

/**
 * Строка MATCH для FTS5: каждый токен — префиксный, токены через OR (BM25 сам
 * поднимет документы, где совпало больше слов). Токены заключены в кавычки,
 * поэтому спецсимволы запроса (AND, NEAR, «*», «"») не ломают синтаксис.
 * Пустая строка — искать нечего.
 */
export function ftsMatch(query: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of tokenize(query)) {
    const t = stem(raw);
    if (seen.has(t)) continue;
    seen.add(t);
    parts.push(`"${t.replace(/"/g, '""')}"*`);
    if (parts.length >= MAX_TOKENS) break;
  }
  return parts.join(" OR ");
}

export interface Ranked {
  source: string;
  ref: string;
}

const keyOf = (r: Ranked): string => `${r.source}\u0000${r.ref}`;

/**
 * Reciprocal Rank Fusion. Каждый список — уже упорядоченный по убыванию
 * релевантности. Возвращает объединённый порядок: первый встреченный
 * экземпляр документа (по порядку списков) становится представителем.
 * `weights` позволяет, например, чуть усилить вектора.
 */
export function rrf<T extends Ranked>(
  lists: T[][],
  opts: { k?: number; weights?: number[] } = {},
): { item: T; rrf: number; ranks: (number | null)[] }[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, { item: T; rrf: number; ranks: (number | null)[] }>();
  lists.forEach((list, li) => {
    const w = opts.weights?.[li] ?? 1;
    list.forEach((item, rank) => {
      const key = keyOf(item);
      let e = acc.get(key);
      if (!e) {
        e = { item, rrf: 0, ranks: lists.map(() => null) };
        acc.set(key, e);
      }
      e.rrf += w / (k + rank + 1);
      e.ranks[li] = rank + 1;
    });
  });
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}
