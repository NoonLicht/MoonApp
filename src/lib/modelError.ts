/**
 * Разбор ошибки провайдера AI-чата про имя модели.
 *
 * Живая жалоба со страницы лекций:
 *
 *   api error 400: {"error":{"message":"The supported API model names are
 *   deepseek-flash, deepseek-v4-pro, but you passed depseek-flash."...}}
 *
 * Причина была в опечатке в сохранённой модели, но пользователь видел сырой
 * JSON: ни что случилось, ни какие имена сервис принимает. Парсер вытаскивает
 * из ответа имена моделей, чтобы интерфейс предложил их чипсами и сохранил
 * выбор в настройках конспекта (кнопка «Провайдер и модель»).
 *
 * Разбор нарочно не привязан к одному вендору: OpenAI-совместимые шлюзы
 * отвечают по-разному («Model Not Exist», «The model 'x' does not exist»,
 * «supported API model names are …»), а UI должен показать хоть что-то
 * осмысленное в любом из этих случаев.
 */

export interface ModelNameError {
  /** Имя, которое отправили ("" — сервис его не назвал). */
  model: string;
  /** Имена, которые сервис принимает (пусто — он их не перечислил). */
  names: string[];
}

/** «The supported API model names are A, B, but you passed C.» */
const SUPPORTED = /supported API model names are\s+([^;]*?)\s*,?\s*but you passed\s+([^\s"'.]+)/i;
/** «Model Not Exist» / «The model `x` does not exist» / «model x not_found». */
const NOT_EXIST = /model\s*["'`]?([^"'`\s]+)["'`]?\s*["'`]?\s*(?:does not exist|not exist|not found|not_found)/i;
/** «you passed C» (когда список имён не перечислен). */
const PASSED = /you passed\s+["'`]?([^"'`\s,.]+)/i;
/** «supported model names are A, B.» — без части «but you passed». */
const NAMES_ONLY = /(?:supported|allowed|valid|available)\s+(?:API\s+)?model names? are\s+([^;.]*)/i;
/** Признак, что ошибка вообще про модель (иначе не стоит ничего предлагать). */
const MODEL_CONTEXT = /model/i;

/** Разбить строку «A, B or C» на имена без кавычек и мусорных пробелов. */
export function splitModelNames(raw: unknown): string[] {
  return String(raw || "")
    .split(/,|\s+or\s+|\s+and\s+/i)
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, "").trim())
    .filter((s) => s && /^[\w.:/-]+$/.test(s) && !/^(but|you|passed)$/i.test(s));
}

/**
 * Разобрать текст ошибки. null — это не ошибка про имя модели.
 */
export function parseModelNameError(message: unknown): ModelNameError | null {
  const msg = String(message || "");
  if (!msg || !MODEL_CONTEXT.test(msg)) return null;

  const supported = msg.match(SUPPORTED);
  if (supported) return { names: splitModelNames(supported[1]), model: supported[2] || "" };

  const namesOnly = msg.match(NAMES_ONLY);
  if (namesOnly) {
    const names = splitModelNames(namesOnly[1]);
    if (names.length) return { names, model: msg.match(PASSED)?.[1] || "" };
  }

  const notExist = msg.match(NOT_EXIST);
  if (notExist) return { names: [], model: notExist[1] || "" };
  // «Model Not Exist» без имени модели: сказать нечего, но это всё ещё ошибка
  // про модель — интерфейс покажет кнопку выбора провайдера/модели.
  if (/model\s+not\s+exist/i.test(msg)) return { names: [], model: "" };
  return null;
}
