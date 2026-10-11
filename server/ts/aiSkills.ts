/**
 * Навыки ИИ-чата (skills) и «судья ответов» — чистая логика без сети.
 *
 *  - Навык — обычная заметка `.md` в папке «Навыки» хранилища. Название берётся
 *    из frontmatter `name` или имени файла, тело заметки — системный промпт.
 *  - Судья: ответу выставляется оценка по критериям; модель возвращает JSON,
 *    разбор терпим к обрамляющему тексту и ограждению ```json.
 */

export const SKILLS_DIR = "Навыки/";
const MAX_PROMPT = 8000;

export interface Skill {
  /** Путь заметки в хранилище. */
  path: string;
  name: string;
  description: string;
  prompt: string;
}

export function skillFrom(
  path: string,
  body: string,
  frontmatter: Record<string, string> = {},
): Skill | null {
  if (!path.startsWith(SKILLS_DIR) || !/\.md$/i.test(path)) return null;
  const prompt = String(body || "").trim().slice(0, MAX_PROMPT);
  if (!prompt) return null;
  const fileName = path.replace(/^.*\//, "").replace(/\.md$/i, "");
  return {
    path,
    name: (frontmatter.name || "").trim() || fileName,
    description: (frontmatter.description || "").trim(),
    prompt,
  };
}

/** Системный промпт из выбранных навыков: каждый — отдельным блоком с названием. */
export function combineSkills(skills: Skill[]): string {
  return skills.map((s) => `### ${s.name}\n${s.prompt}`).join("\n\n");
}

/* --------------------------------- Судья --------------------------------- */

export interface Verdict {
  /** Итоговая оценка 1..10. */
  score: number;
  accuracy: number | null;
  completeness: number | null;
  clarity: number | null;
  issues: string[];
  summary: string;
}

const clamp10 = (n: unknown): number | null => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v * 10) / 10)) : null;
};

export function judgePrompt(question: string, answer: string): string {
  return [
    "Оцени ответ ассистента на вопрос пользователя. Верни ТОЛЬКО JSON без пояснений:",
    '{"accuracy":1-10,"completeness":1-10,"clarity":1-10,"score":1-10,"issues":["…"],"summary":"одно предложение"}',
    "accuracy — фактическая точность, completeness — полнота, clarity — ясность.",
    "В issues перечисли конкретные ошибки, выдумки и пропуски (не больше 5).",
    "",
    `ВОПРОС:\n${question.slice(0, 4000)}`,
    "",
    `ОТВЕТ:\n${answer.slice(0, 12000)}`,
  ].join("\n");
}

/** Разбирает ответ модели-судьи; null — если JSON не найден или оценки нет. */
export function parseVerdict(raw: string): Verdict | null {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const accuracy = clamp10(obj.accuracy);
  const completeness = clamp10(obj.completeness);
  const clarity = clamp10(obj.clarity);
  let score = clamp10(obj.score);
  if (score === null) {
    const parts = [accuracy, completeness, clarity].filter((x): x is number => x !== null);
    if (!parts.length) return null;
    score = Math.round((parts.reduce((s, x) => s + x, 0) / parts.length) * 10) / 10;
  }
  const issues = Array.isArray(obj.issues)
    ? obj.issues.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
    : [];
  return {
    score,
    accuracy,
    completeness,
    clarity,
    issues,
    summary: String(obj.summary ?? "").trim().slice(0, 400),
  };
}
