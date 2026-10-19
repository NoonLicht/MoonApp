/**
 * Лимиты размера JSON-тела по маршрутам и разбор ошибок body-parser.
 *
 * Раньше на всё действовал один лимит в 2 МБ (кроме досок), и превышение уходило
 * пользователю как «500: request entity too large» без объяснения. Теперь:
 *   - у маршрутов, куда законно приходят большие тексты (заметки, выписки, OPML,
 *     закладки), лимит выше;
 *   - ошибки body-parser (413, 400 «битый JSON») возвращаются со своим статусом
 *     и понятным текстом, а не общим 500.
 */

/** Лимит по умолчанию для всего остального API. */
export const DEFAULT_JSON_LIMIT = "2mb";

/** Префикс маршрута → лимит. Порядок важен: берётся первое совпадение. */
export const ROUTE_JSON_LIMITS: ReadonlyArray<{ prefix: string; limit: string }> = [
  // помощник документов: история чата, текст документа и картинки для модели
  { prefix: "/api/llamacpp/assistant", limit: "24mb" },
  // воркфлоу ComfyUI и их проверка
  { prefix: "/api/comfy", limit: "24mb" },
  // доски Canvas хранят вставленные картинки прямо в JSON
  { prefix: "/api/myspace/holst", limit: "40mb" },
  // заметки, документы и импорт хранилища
  { prefix: "/api/myspace", limit: "16mb" },
  // импорт банковских выписок CSV/OFX
  { prefix: "/api/budget", limit: "16mb" },
  // OPML-импорт и сохранение текста статей «прочитать позже»
  { prefix: "/api/rss", limit: "16mb" },
  { prefix: "/api/bookmarks", limit: "16mb" },
  // письма с вложениями (base64)
  { prefix: "/api/mail", limit: "40mb" },
  // картинки в документ идут base64 в теле команды insert.picture
  { prefix: "/api/word", limit: "40mb" },
  { prefix: "/api/sheet", limit: "40mb" },
  { prefix: "/api/diary", limit: "8mb" },
  { prefix: "/api/quicknotes", limit: "8mb" },
];

/** Лимит для пути запроса. */
export function jsonLimitFor(urlPath: string): string {
  for (const r of ROUTE_JSON_LIMITS) {
    if (urlPath === r.prefix || urlPath.startsWith(r.prefix + "/")) return r.limit;
  }
  return DEFAULT_JSON_LIMIT;
}

interface HttpishError {
  status?: number;
  statusCode?: number;
  type?: string;
  message?: string;
  limit?: number;
}

/** HTTP-статус ошибки: свой статус body-parser, иначе 500. */
export function statusOf(err: unknown): number {
  const e = (err ?? {}) as HttpishError;
  const s = e.status ?? e.statusCode;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

/** Текст для пользователя: для известных ошибок тела — понятный, иначе исходный. */
export function publicMessage(err: unknown): string {
  const e = (err ?? {}) as HttpishError;
  if (e.type === "entity.too.large") {
    const mb = e.limit ? ` (лимит ${Math.round(e.limit / 1024 / 1024)} МБ)` : "";
    return `Слишком большой запрос${mb}. Разбейте данные на части.`;
  }
  if (e.type === "entity.parse.failed") return "Некорректный JSON в теле запроса.";
  if (e.type === "request.aborted") return "Запрос прерван.";
  return e.message || "Внутренняя ошибка";
}
