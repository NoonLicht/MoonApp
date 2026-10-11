/**
 * RSVP-чтение (по слову на экране): разбиение текста на слова и расчёт
 * задержек. Слово показывается с «точкой фокуса» (ORP) — буквой чуть левее
 * центра, на которой глаз задерживается; после запятых и точек пауза длиннее.
 */

export interface RsvpWord {
  text: string;
  /** Индекс буквы-фокуса. */
  orp: number;
  /** Сколько показывать слово, мс. */
  ms: number;
}

/** Убирает разметку Markdown, оставляя читаемый текст. */
export function plainText(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_~`|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function orpIndex(word: string): number {
  const len = word.replace(/[^\p{L}\p{N}]/gu, "").length || word.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

export function rsvpWords(text: string, wpm: number): RsvpWord[] {
  const base = 60_000 / Math.max(60, Math.min(1500, wpm));
  return plainText(text)
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      let k = 1;
      const letters = w.replace(/[^\p{L}\p{N}]/gu, "").length;
      if (letters > 8) k += 0.25;
      if (letters > 12) k += 0.25;
      if (/[,;:]$/.test(w)) k += 0.5;
      if (/[.!?…]$/.test(w)) k += 1;
      return { text: w, orp: Math.min(orpIndex(w), Math.max(0, w.length - 1)), ms: Math.round(base * k) };
    });
}
