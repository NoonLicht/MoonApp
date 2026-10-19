import type { AssistantToolSpec } from "@/api/apiAssistant";

/** Итог команды ядра для помощника: ошибка приходит текстом, а не теряется. */
export interface ExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Какие возможности разрешены помощнику (кнопка «Настроить» в панели). */
export interface AssistantSettings {
  /** Выбранная модель (файл .gguf); пусто — подбирает маршрутизатор. */
  model: string;
  /** Агентный режим: модель сама вызывает инструменты в несколько шагов. */
  agent: boolean;
  /** Править документ: вставка, замена, форматирование. */
  edit: boolean;
  /** Любые команды приложения (всё, что есть на ленте). */
  commands: boolean;
  /** Выход в интернет: поиск и чтение страниц. */
  web: boolean;
  /** Генерация картинок (Qwen-Image) и вставка в документ. */
  images: boolean;
  /** Режим размышления модели (медленнее, но точнее). */
  think: boolean;
}

export type ToolGroup = "read" | "edit" | "commands" | "web" | "images";

/** Инструмент, который помощник может вызвать: описание для модели и исполнитель. */
export interface AssistantTool extends AssistantToolSpec {
  group: ToolGroup;
  /** Короткая подпись шага для чата («Читаю документ», «Ищу в интернете»). */
  label: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

/** Приложение, в котором работает помощник: Word-страница или Excel-страница. */
export interface DocAdapter {
  kind: "word" | "sheet";
  /** Описание приложения и правил работы для системного сообщения. */
  system: string;
  tools: AssistantTool[];
  /** Короткий снимок текущего состояния (выделение, активный лист…) к сообщению пользователя. */
  context: () => string;
  /** Документ или лист как текст (для режима без агента, где модель сама читать не умеет). */
  snapshot: (maxChars: number) => Promise<string>;
  /** Куда показывать сгенерированные картинки в чате (ставит хук на время запроса). */
  setPictureSink: (fn: ((dataUrl: string) => void) | null) => void;
  /** Вставить готовый текст в документ (кнопка «Вставить» у ответа). */
  insert: (text: string) => Promise<void>;
}

export interface ChatStep {
  id: string;
  tool: string;
  label: string;
  state: "run" | "ok" | "err";
  detail?: string;
}

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Шаги агента, выполненные в этом ответе. */
  steps?: ChatStep[];
  /** Картинки, приложенные пользователем. */
  images?: string[];
  error?: string;
  /** Сгенерированные картинки (data:-ссылки) — показываются в ответе. */
  pictures?: string[];
}
