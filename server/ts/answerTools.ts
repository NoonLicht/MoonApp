/**
 * Инструменты для ответов ИИ-чата: проверка по заметкам и сохранение ценных ответов.
 *
 * Проверка — локальная и без модели: ответ режется на утверждения, каждое
 * ищется в заметках (гибридный поиск), по оценке совпадения утверждение
 * помечается «подтверждено в заметках», «есть по теме» или «в заметках нет».
 * Это не доказательство истинности, а быстрый способ увидеть, что уже записано.
 */
import crypto from "crypto";

export interface Claim {
  text: string;
}

export type Support = "supported" | "related" | "none";

export const SUPPORTED_SCORE = 0.82;
export const RELATED_SCORE = 0.7;
const MAX_CLAIMS = 12;
const MIN_WORDS = 5;

/** Убирает блоки кода, ссылки-картинки и разметку заголовков/списков. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_~>]+/g, "");
}

/** Утверждения: предложения из пяти и более слов, не больше MAX_CLAIMS. */
export function splitClaims(answer: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const part of plain(answer).split(/(?<=[.!?…])\s+|\n+/)) {
    const text = part.replace(/\s+/g, " ").trim();
    if (text.split(" ").filter((w) => /\p{L}|\d/u.test(w)).length < MIN_WORDS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.slice(0, 400) });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

export function supportLevel(topScore: number | null): Support {
  if (topScore === null) return "none";
  if (topScore >= SUPPORTED_SCORE) return "supported";
  if (topScore >= RELATED_SCORE) return "related";
  return "none";
}

/* ----------------------- Автосохранение ценных ответов ----------------------- */

/**
 * Оценка «ценности» ответа: код, структура, объём. Порог по умолчанию — 3
 * (например, код + список + развёрнутый текст). Короткие реплики не сохраняются.
 */
export function valueScore(answer: string): number {
  const t = String(answer || "");
  let s = 0;
  if (/```[\s\S]+?```/.test(t)) s += 2;
  if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m.test(t)) s += 1;
  if (/^#{1,3}[ \t]+\S/m.test(t)) s += 1;
  if (t.length >= 500) s += 1;
  if (t.length >= 1500) s += 1;
  if (/https?:\/\/\S+/.test(t)) s += 0.5;
  if (t.length < 200) s = Math.min(s, 1);
  return s;
}

export const VALUE_THRESHOLD = 3;

const FORBIDDEN = /[<>:"\\/|?*\u0000-\u001f]/g;

export interface AnswerNote {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, string>;
}

/** Заметка из пары «вопрос — ответ». Путь стабилен для одного и того же ответа. */
export function noteFromAnswer(
  question: string,
  answer: string,
  opts: { model?: string; date?: string } = {},
): AnswerNote {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const heading = answer.match(/^#{1,3}[ \t]+(.+)$/m)?.[1];
  const raw = (heading ?? question.split(/\r?\n/)[0] ?? "").trim() || "Ответ ИИ";
  const title = raw.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Ответ ИИ";
  const hash = crypto.createHash("sha1").update(answer).digest("hex").slice(0, 6);
  const frontmatter: Record<string, string> = {
    source: "ai-chat",
    date,
    ...(opts.model ? { model: opts.model } : {}),
  };
  const q = question.trim();
  const content = (q ? `> **Вопрос:** ${q.replace(/\n/g, "\n> ")}\n\n` : "") + answer.trim() + "\n";
  return { path: `ИИ-ответы/${date}/${title} ${hash}.md`, title, content, frontmatter };
}
