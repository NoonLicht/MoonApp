/**
 * Команды ИИ внутри заметки: строка `...команда запрос` в редакторе («Моё пространство»).
 *
 * Команды делятся на преобразующие (работают над выделением или всей заметкой и заменяют их)
 * и порождающие (результат вставляется на место строки с командой). По умолчанию запросы идут в
 * локальную модель llama.cpp — её подбирает маршрутизатор (llamacpp/router.ts) из скачанных;
 * облако используется, только если для заметок явно выбран облачный провайдер.
 */
import settings from "./settings";
import { assertFeature, boundOf } from "./aiBindings";
import { askModel, type LlmTarget } from "./llmOnce";
import { getProvider } from "./providers";
import { getSecret } from "./security";
import { cleanupAnswer, askAi } from "./notesAi";
import { chatModels } from "./llamacpp/router";

export type CommandId =
  | "format"
  | "fix"
  | "short"
  | "expand"
  | "simplify"
  | "formal"
  | "translate"
  | "table"
  | "list"
  | "summary"
  | "todo"
  | "plan"
  | "fact"
  | "continue"
  | "title"
  | "ideas"
  | "explain"
  | "tags"
  | "ask";

interface Spec {
  /** transform — над выделением/заметкой, generate — вставка вместо строки команды. */
  kind: "transform" | "generate";
  /** Нужен ли текст заметки как контекст. */
  needsText: boolean;
  maxTokens: number;
  temperature: number;
  build(a: { args: string; text: string; title: string; hasSelection: boolean }): string;
}

const KEEP =
  "Сохрани язык исходного текста, [[вики-ссылки]], #теги, ссылки, картинки и код как есть. " +
  "Верни только результат без пояснений и без обрамляющих ``` .";

const SPECS: Record<CommandId, Spec> = {
  format: {
    kind: "transform",
    needsText: true,
    maxTokens: 3000,
    temperature: 0.2,
    build: ({ text }) =>
      `Оформи текст заметки в аккуратный Markdown: заголовки, списки, выделение главного, таблицы там, где уместно. Смысл не меняй, факты не выбрасывай и не добавляй. ${KEEP}\n\n${text}`,
  },
  fix: {
    kind: "transform",
    needsText: true,
    maxTokens: 3000,
    temperature: 0.1,
    build: ({ text }) =>
      `Исправь орфографию, пунктуацию и грамматику. Стиль и смысл не меняй. ${KEEP}\n\n${text}`,
  },
  short: {
    kind: "transform",
    needsText: true,
    maxTokens: 1500,
    temperature: 0.2,
    build: ({ text, args }) =>
      `Сократи текст${args ? ` (${args})` : " примерно вдвое"}, сохранив ключевые факты. ${KEEP}\n\n${text}`,
  },
  expand: {
    kind: "transform",
    needsText: true,
    maxTokens: 2500,
    temperature: 0.5,
    build: ({ text, args }) =>
      `Разверни текст подробнее${args ? `: ${args}` : ""}, не выдумывая фактов, которых нет в тексте. ${KEEP}\n\n${text}`,
  },
  simplify: {
    kind: "transform",
    needsText: true,
    maxTokens: 2500,
    temperature: 0.3,
    build: ({ text }) => `Перепиши проще и понятнее, короткими предложениями. ${KEEP}\n\n${text}`,
  },
  formal: {
    kind: "transform",
    needsText: true,
    maxTokens: 2500,
    temperature: 0.3,
    build: ({ text }) => `Перепиши в деловом официальном стиле. ${KEEP}\n\n${text}`,
  },
  translate: {
    kind: "transform",
    needsText: true,
    maxTokens: 3000,
    temperature: 0.1,
    build: ({ text, args }) =>
      `Переведи текст на ${args || "английский"} язык, сохраняя разметку Markdown и имена собственные. Верни только перевод.\n\n${text}`,
  },
  table: {
    kind: "transform",
    needsText: true,
    maxTokens: 2500,
    temperature: 0.2,
    build: ({ text, args }) =>
      `Преобразуй данные из текста в таблицу Markdown${args ? ` (${args})` : ""}. Ничего не выдумывай. Верни только таблицу.\n\n${text}`,
  },
  list: {
    kind: "transform",
    needsText: true,
    maxTokens: 2000,
    temperature: 0.2,
    build: ({ text }) =>
      `Преобразуй текст в структурированный маркированный список, сохранив все факты. ${KEEP}\n\n${text}`,
  },
  summary: {
    kind: "generate",
    needsText: true,
    maxTokens: 700,
    temperature: 0.3,
    build: ({ text, args }) =>
      `Сделай краткое резюме заметки${args ? ` (${args})` : ""}: одна строка сути и 3–6 пунктов списком. Только факты из текста. Верни Markdown.\n\n${text}`,
  },
  todo: {
    kind: "generate",
    needsText: true,
    maxTokens: 800,
    temperature: 0.2,
    build: ({ text, args }) =>
      `Выпиши из заметки конкретные задачи${args ? ` (${args})` : ""} в виде чек-листа Markdown: «- [ ] задача (срок, если указан)». Если задач нет, предложи 3–5 логичных следующих шагов.\n\n${text}`,
  },
  plan: {
    kind: "generate",
    needsText: false,
    maxTokens: 1000,
    temperature: 0.5,
    build: ({ text, args, title }) =>
      `Составь чёткий пошаговый план${args ? `: ${args}` : ` по теме заметки «${title}»`}. Верни нумерованный список Markdown с короткими пунктами.${text ? `\n\nКонтекст заметки:\n${text}` : ""}`,
  },
  fact: {
    kind: "generate",
    needsText: false,
    maxTokens: 400,
    temperature: 0.8,
    build: ({ text, args, title }) =>
      `Напиши один интересный и достоверный факт${args ? ` на тему «${args}»` : ` по теме заметки «${title}»`}, 2–4 предложения. Если не уверен в точности — скажи об этом. Верни только текст.${!args && text ? `\n\nЗаметка:\n${text.slice(0, 2500)}` : ""}`,
  },
  continue: {
    kind: "generate",
    needsText: true,
    maxTokens: 900,
    temperature: 0.7,
    build: ({ text, args }) =>
      `Продолжи текст заметки в том же стиле и на том же языке${args ? `: ${args}` : ""}. Напиши только продолжение (1–3 абзаца), не повторяя уже написанное.\n\n${text}`,
  },
  title: {
    kind: "generate",
    needsText: true,
    maxTokens: 150,
    temperature: 0.7,
    build: ({ text }) =>
      `Предложи 5 коротких вариантов заголовка для этой заметки (до 8 слов). Верни маркированный список, на языке заметки.\n\n${text.slice(0, 5000)}`,
  },
  ideas: {
    kind: "generate",
    needsText: false,
    maxTokens: 700,
    temperature: 0.9,
    build: ({ text, args, title }) =>
      `Предложи 7 идей${args ? ` на тему: ${args}` : ` по теме заметки «${title}»`}. Верни маркированный список, у каждой идеи — одна строка.${!args && text ? `\n\nЗаметка:\n${text.slice(0, 2500)}` : ""}`,
  },
  explain: {
    kind: "generate",
    needsText: false,
    maxTokens: 800,
    temperature: 0.4,
    build: ({ text, args, hasSelection }) =>
      `Объясни простыми словами${args ? `: ${args}` : hasSelection ? " выделенный фрагмент" : " содержание заметки"}. Коротко и по делу, Markdown.${!args ? `\n\n${text.slice(0, 5000)}` : ""}`,
  },
  tags: {
    kind: "generate",
    needsText: true,
    maxTokens: 100,
    temperature: 0.2,
    build: ({ text }) =>
      `Подбери 3–6 тегов для заметки. Верни одной строкой в формате «#тег1 #тег2 #тег3», теги строчными буквами без пробелов (составные через дефис), на языке заметки. Больше ничего.\n\n${text.slice(0, 5000)}`,
  },
  ask: {
    kind: "generate",
    needsText: false,
    maxTokens: 1200,
    temperature: 0.6,
    build: ({ text, args }) =>
      `${args}\n\nОтветь в формате Markdown, без вступлений.${text ? `\n\nКонтекст — текст заметки пользователя (используй, если относится к запросу):\n${text.slice(0, 4500)}` : ""}`,
  },
};

const SYSTEM =
  "Ты — ассистент внутри приложения для заметок. Выполняй просьбу пользователя точно, " +
  "пиши по существу, не добавляй вводных фраз вроде «Конечно». Форматируй ответ в Markdown.";

export const isCommand = (v: string): v is CommandId => v in SPECS;

export interface CommandInput {
  command: string;
  /** Аргументы после названия команды или свободный запрос для `ask`. */
  args: string;
  /** Текст заметки без строки команды. */
  content: string;
  selection: string;
  title: string;
  appPage?: string | null;
}

export interface CommandResult {
  /** replace — заменить выделение/заметку; insert — вставить на место строки команды. */
  mode: "replace" | "insert";
  /** Что заменять: выделение или вся заметка (только для replace). */
  target: "selection" | "note";
  text: string;
  provider: string;
  model: string;
}

const CONTEXT_CHARS = 7000;

/** Куда отправлять: локальная llama.cpp по умолчанию; облако — только при явном выборе провайдера. */
function route(): { local: boolean; model: string } {
  const mine = ((settings.get("myspace") as { ai?: { provider?: string; model?: string } })?.ai ??
    {}) as { provider?: string; model?: string };
  const own = String(mine.provider || "").trim();
  if (own === "llamacpp") return { local: true, model: String(mine.model || "") || "auto" };
  if (!own && chatModels().length) return { local: true, model: "auto" };
  return { local: false, model: "" };
}

export async function runCommand(i: CommandInput): Promise<CommandResult> {
  const id = (isCommand(i.command) ? i.command : "ask") as CommandId;
  const spec = SPECS[id];
  const hasSelection = !!i.selection.trim();
  const args = i.args.trim();
  if (id === "ask" && !args) throw new Error("notes_cmd_empty");
  const body = (hasSelection ? i.selection : i.content).trim();
  if (spec.needsText && !body) throw new Error("notes_cmd_no_text");
  const prompt = spec.build({
    args,
    text: body.slice(0, CONTEXT_CHARS),
    title: i.title,
    hasSelection,
  });
  assertFeature("notes.commands");
  const r = route();
  const bound = boundOf("notes.commands");
  let out: string;
  let provider = "llamacpp";
  let model = r.model;
  if (bound) {
    // привязка модели к командам заметок (Настройки → «Привязка моделей ИИ»)
    out = await askModel(SYSTEM, prompt, {
      appPage: i.appPage ?? "myspace",
      maxTokens: spec.maxTokens,
      temperature: spec.temperature,
      feature: "notes.commands",
    });
    provider = bound.provider;
    model = bound.model;
  } else if (r.local) {
    const p = getProvider("llamacpp");
    const target = {
      provider: p,
      secret: getSecret("llamacpp") || "local",
      model: r.model || "auto",
    };
    // task нужен маршрутизатору (подпись в индикаторе и выбор модели) — провайдер читает его из параметров.
    const wrapped = {
      chat: (o: Record<string, unknown>) => p.chat({ ...o, task: "command" } as never),
    };
    out = await askModel(SYSTEM, prompt, {
      appPage: i.appPage ?? "myspace",
      maxTokens: spec.maxTokens,
      temperature: spec.temperature,
      target: { ...target, provider: wrapped } as unknown as LlmTarget,
    });
  } else {
    const a = await askAi(prompt, SYSTEM, i.appPage ?? "myspace", spec.maxTokens);
    out = a.text;
    provider = a.provider;
    model = a.model;
  }
  out = cleanupAnswer(out);
  if (!out) throw new Error("notes_cmd_empty_answer");
  if (spec.kind === "transform")
    return {
      mode: "replace",
      target: hasSelection ? "selection" : "note",
      text: out,
      provider,
      model,
    };
  return { mode: "insert", target: "note", text: out, provider, model };
}
