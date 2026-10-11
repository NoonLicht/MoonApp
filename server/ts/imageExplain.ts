/**
 * Объяснение изображения и формулы с доски — через OCR и текстовую модель
 * (vision-модель не нужна). Здесь — подготовка запроса и разбор ответа.
 *
 *  - mode "explain": что на экране/слайде и что с этим делать;
 *  - mode "formulas": формулы с доски → список в LaTeX с подписями.
 */

export type ExplainMode = "explain" | "formulas";

const MAX_TEXT = 12_000;

/** Приводит текст OCR в порядок: пустые строки, повторные пробелы, слишком длинное. */
export function cleanOcr(text: string): string {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT);
}

/** Мало ли распознано, чтобы вообще обращаться к модели. */
export function isUsable(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3;
}

export function systemPrompt(mode: ExplainMode): string {
  return mode === "formulas"
    ? "Ты помогаешь переписать формулы с фотографии доски. Текст получен распознаванием, в нём могут быть ошибки: восстанови формулы по смыслу, не добавляй новых."
    : "Ты объясняешь содержимое экрана или слайда по распознанному тексту. Он может содержать ошибки распознавания. Отвечай по-русски кратко и по делу.";
}

export function userPrompt(mode: ExplainMode, ocr: string, question = ""): string {
  const q = question.trim().slice(0, 1000);
  if (mode === "formulas") {
    return [
      "Выпиши все формулы из распознанного текста доски. Для каждой: номер, формула в LaTeX ($...$) и подпись из одного предложения о её смысле.",
      "Если формул нет — так и скажи.",
      "",
      `РАСПОЗНАННЫЙ ТЕКСТ:\n${ocr}`,
    ].join("\n");
  }
  return [
    q ? `Вопрос пользователя: ${q}` : "Объясни, что здесь показано, и выдели главное.",
    "",
    `РАСПОЗНАННЫЙ ТЕКСТ С ЭКРАНА:\n${ocr}`,
  ].join("\n");
}

/** Формулы LaTeX из ответа модели: содержимое $...$ и $$...$$ без дублей. */
export function extractLatex(answer: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(answer).matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)) {
    const f = (m[1] ?? m[2] ?? "").trim();
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
