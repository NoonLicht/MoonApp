/**
 * Рецензент текста: модель не переписывает текст, а задаёт вопросы к нему
 * («а доказательство?», «для кого это?»). Стиль автора остаётся нетронутым.
 * Здесь — подсказка и разбор ответа: из ответа оставляются только вопросы.
 */

export type ReviewFocus = "general" | "evidence" | "audience" | "logic";

const FOCUS_HINT: Record<ReviewFocus, string> = {
  general: "Охвати разные стороны: доказательства, аудитория, логика, неясные термины, пропущенные шаги.",
  evidence: "Сфокусируйся на доказательствах: чем подкреплено каждое важное утверждение, где источники и цифры.",
  audience: "Сфокусируйся на читателе: для кого текст, что он уже знает, чего ему не хватает и зачем ему это.",
  logic: "Сфокусируйся на логике: скрытые допущения, скачки в рассуждении, противоречия, причины и следствия.",
};

export function buildReviewPrompt(text: string, focus: ReviewFocus = "general", max = 8): string {
  return (
    `Ты — строгий, но доброжелательный рецензент. НЕ переписывай и НЕ исправляй текст, не предлагай готовых формулировок. ` +
    `Задай до ${max} коротких вопросов, которые заставят автора усилить текст самому. ${FOCUS_HINT[focus]}\n` +
    `Каждый вопрос — отдельной строкой, заканчивается знаком «?», по возможности укажи в начале в скобках ` +
    `3–6 слов цитаты, к которой он относится. Без вступления и выводов.\n\n=== ТЕКСТ ===\n${text.slice(0, 12_000)}`
  );
}

export interface ReviewQuestion {
  /** Цитата из текста, к которой относится вопрос (может быть пустой). */
  quote: string;
  question: string;
}

/** Оставляет только вопросы: убирает нумерацию, вступления и «советы». */
export function parseQuestions(raw: string, max = 10): ReviewQuestion[] {
  const out: ReviewQuestion[] = [];
  const seen = new Set<string>();
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    let s = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!s.endsWith("?")) continue;
    let quote = "";
    const m =
      /^\(\s*[«"“]?([^)]{3,80}?)[»"”]?\s*\)\s*[:—–-]?\s*(.+)$/.exec(s) ??
      /^[«"“]([^»"”]{3,80})[»"”]\s*[:—–-]?\s*(.+)$/.exec(s);
    if (m) {
      quote = m[1].trim();
      s = m[2].trim();
    }
    if (s.length < 8 || s.length > 300) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ quote, question: s });
    if (out.length >= max) break;
  }
  return out;
}
