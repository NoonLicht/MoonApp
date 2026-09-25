/**
 * ИИ-оформление заметок MySpace («Моё пространство» → Заметки).
 *
 * «Оформить» приводит черновой текст заметки к аккуратному Markdown тем же
 * провайдером, что AI-чат и ИИ-конспект лекций (ключ и модель берутся из
 * настроек чата: chat.provider / chat.model). Перед запросом «сырой» текст
 * сохраняется в sidecar storage/vault/notes/.ai/<имя заметки>.txt — из него
 * кнопка «Регенерировать» собирает оформление заново и ПОЛНОСТЬЮ заменяет текст
 * заметки (см. POST /api/myspace/ai/format и /api/myspace/ai/regenerate).
 *
 * Почему отдельный модуль: роуты server/routes/myspace.js — обычный .js, а
 * провайдеры/секреты/настройки живут в CJS-модулях; держать этот код в роуте
 * означало бы либо дублировать логику чата, либо ломать тестируемость.
 *
 * TS-исходник, как server/ts/myspace-vault.ts: компилируется в server/notesAi.js
 * командой `npm run compile:server`, поэтому require("../notesAi") из роутов
 * работает без изменений.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import { removePath } from "./fsUtil";

/* eslint-disable @typescript-eslint/no-require-imports */
// Провайдеры чата и секреты — ещё не переведённые на TS модули: импорт .js без
// объявлений не проходит strict-сборку, поэтому require с ожидаемой формой
// (так же, как в server/ts/index.ts). ВАЖНО: путь пишется от ВЫХОДНОГО файла
// server/notesAi.js, а не от server/ts/notesAi.ts — tsc переносит модуль на
// уровень выше, и "../providers" на рантайме уводило бы в корень проекта.
const providers = require("./providers") as {
  getProvider: (id: string) => any;
  PROVIDERS: Array<{ id: string; label?: string; models?: string[] }>;
};
const security = require("./security") as { getSecret: (name: string) => string };
const { runWithPage } = require("./middleware/perPageProxy") as {
  runWithPage: <T>(page: unknown, fn: () => T) => T;
};

const { DIRS } = config;

/** Папка заметок vault (storage/vault/notes) — как в server/ts/myspace-vault.ts. */
export const NOTES_DIR: string = DIRS.vaultNotes;
/**
 * Папка со «сырыми» исходниками. Имя с точки — vault.walkTree пропускает
 * скрытые записи, поэтому .ai не появляется в проводнике заметок.
 */
export const SOURCE_DIR: string = path.join(NOTES_DIR, ".ai");

/** Результат ИИ-оформления (ответ POST /api/myspace/ai/format|regenerate). */
export interface NotesAiResult {
  /** Готовый Markdown — его и нужно записать в заметку. */
  content: string;
  provider: string;
  model: string;
  /** Символов в готовом тексте. */
  chars: number;
  /** Символов в исходнике, из которого собрано оформление. */
  rawChars: number;
  /** Сколько блоков ушло в модель (длинная заметка режется по строкам). */
  blocks: number;
  /** true — текст собран «Регенерировать» из сохранённого исходника. */
  regenerated: boolean;
}

/** Состояние sidecar-исходника заметки (для подсказок в UI и журнала). */
export interface NotesAiSourceInfo {
  exists: boolean;
  /** Имя файла-исходника внутри .ai (без пути). */
  file: string;
  chars: number;
  /** ISO-время последней записи исходника ("" — исходника нет). */
  updatedAt: string;
}
/**
 * Предел одного запроса к модели. Заметка длиннее режется по строкам: модель
 * получает фрагменты подряд, а ответы склеиваются в исходном порядке.
 */
const CHUNK_CHARS = 6000;
/** Предохранитель от «заметки на сотни КБ»: больше 40 запросов подряд не шлём. */
const MAX_CHUNKS = 40;
/**
 * Если модель вернула меньше половины исходника — это потеря текста, а не
 * оформление. Заметку в таком случае НЕ перезаписываем: лучше ошибка в UI, чем
 * молча стёртый абзац.
 */
const MIN_KEEP_RATIO = 0.5;
/** Оформление — задача без креатива, поэтому температура ниже чатовой. */
const TEMPERATURE = 0.3;

const SYSTEM_PROMPT =
  "Ты — редактор личных заметок. Приводишь черновые записи к аккуратному Markdown, " +
  "не меняя смысл и не выбрасывая факты.";

/**
 * Промпт оформления. «Умеренно дополнить» ограничено резюме и списком терминов:
 * любое сочинительство здесь — это подмена заметки пользователя.
 */
function buildPrompt(text: string, title: string, part: number, total: number): string {
  const where =
    total > 1
      ? `Ниже ФРАГМЕНТ ${part} из ${total} заметки «${title || "без названия"}» (продолжение — в следующем фрагменте, повторять его не нужно).`
      : `Ниже заметка «${title || "без названия"}» из личного хранилища.`;
  return `${where}
Оформи её аккуратно, НЕ меняя смысл:
- расставь заголовки (##, ###) и списки там, где это помогает читать;
- поправь опечатки, лишние пустые строки и разнобой в оформлении;
- формулы оставь в LaTeX-нотации $...$, код — в \`\`\`-блоках;
- [[вики-ссылки]], #теги, картинки и таблицы сохрани как есть;
- можно умеренно дополнить: 1-2 строки резюме в начале и список ключевых терминов в конце.
  Если факта нет в заметке — его не должно быть и в ответе, ничего не выдумывай.

Верни ТОЛЬКО готовый Markdown, без пояснений и без обрамляющих \`\`\`.
=== ЗАМЕТКА ===
${text}`;
}

/** Имя файла-исходника: "Моя заметка.md" → "Моя заметка.txt". */
function sourceFile(notePath: unknown): string {
  const base = path
    .basename(String(notePath || ""))
    .replace(/\.(md|markdown|txt)$/i, "")
    // Защита от имён, которые Windows не примет: заметку могли создать вручную,
    // а имя sidecar'а должно остаться открываемым в блокноте.
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim();
  return (base || "note") + ".txt";
}

/** Абсолютный путь sidecar-исходника (внутри .ai — выход за папку невозможен). */
export function sourcePath(notePath: unknown): string {
  return path.join(SOURCE_DIR, sourceFile(notePath));
}

/** Есть ли сохранённый исходник и сколько в нём символов. */
export function sourceInfo(notePath: unknown): NotesAiSourceInfo {
  const p = sourcePath(notePath);
  const file = path.basename(p);
  try {
    const st = fs.statSync(p);
    return {
      exists: true,
      file,
      chars: fs.readFileSync(p, "utf8").length,
      updatedAt: st.mtime.toISOString(),
    };
  } catch {
    return { exists: false, file, chars: 0, updatedAt: "" };
  }
}

/** Прочитать исходник ("" — его нет). */
export function readSource(notePath: unknown): string {
  try {
    return fs.readFileSync(sourcePath(notePath), "utf8");
  } catch {
    return "";
  }
}

/** Записать исходник (создаёт .ai при необходимости). */
export function writeSource(
  notePath: unknown,
  text: unknown,
): { ok: boolean; file: string; chars: number; error?: string } {
  const p = sourcePath(notePath);
  const file = path.basename(p);
  const body = String(text ?? "");
  try {
    if (!fs.existsSync(SOURCE_DIR)) fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    return { ok: true, file, chars: body.length };
  } catch (e) {
    return { ok: false, file, chars: 0, error: (e as Error).message };
  }
}

/** Удалить исходник (заметку удалили — sidecar не должен оставаться). */
export function removeSource(notePath: unknown): boolean {
  // Именно removePath: fs.rmSync на Windows молча не удаляет файлы с
  // кириллическими именами, а имена заметок почти всегда русские.
  return removePath(sourcePath(notePath));
}

/** Перенести исходник вслед за переименованной/перемещённой заметкой. */
export function moveSource(oldPath: unknown, newPath: unknown): boolean {
  const from = sourcePath(oldPath);
  const to = sourcePath(newPath);
  if (from === to) return true;
  try {
    if (!fs.existsSync(from)) return false;
    if (!fs.existsSync(SOURCE_DIR)) fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разбить текст на блоки по строкам. «Швов» нет: join("\n") блоков возвращает
 * исходный текст символ в символ, поэтому оформление не может потерять строку на
 * границе фрагментов.
 */
export function splitForFormat(raw: string, size = CHUNK_CHARS): string[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.length <= size) return [text];
  const blocks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = (): void => {
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
    len = 0;
  };
  for (const line of text.split("\n")) {
    if (len && len + line.length + 1 > size) flush();
    cur.push(line);
    len += line.length + 1;
  }
  flush();
  return blocks;
}

/** Модели любят заворачивать весь ответ в ```-забор — снимаем его. */
export function cleanupAnswer(text: unknown): string {
  let s = String(text ?? "").trim();
  const fenced = s.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fenced) s = fenced[1].trim();
  return s;
}

/** Лимит ответа: примерно половина символов блока (в токенах), но не больше 8000. */
function maxTokensFor(chars: number): number {
  return Math.min(8000, Math.max(1200, Math.round(chars / 2)));
}

interface AiTarget {
  provider: any;
  secret: string;
  model: string;
}

/** Настройки ИИ-оформления заметок (myspace.ai) + провайдер из чата. */
interface AiCfg {
  providerId: string;
  /** true — провайдер наследуется от AI-чата (свой не выбран). */
  providerFromChat: boolean;
  chatProvider: string;
  model: string;
}

/** Текущая конфигурация: myspace.ai, а пустые поля — из настроек чата. */
export function aiCfg(): AiCfg {
  const mine = settings.get("myspace")?.ai || {};
  const chat = settings.get("chat") || {};
  const own = String(mine.provider || "").trim();
  return {
    providerId: own || String(chat.provider || "deepseek"),
    providerFromChat: !own,
    chatProvider: String(chat.provider || ""),
    model: String(mine.model || "").trim() || (own ? "" : String(chat.model || "").trim()),
  };
}

/** Список провайдеров для формы выбора (id, ярлык, каталог моделей, есть ли ключ). */
export function aiProviders(): Array<{
  id: string;
  label: string;
  models: string[];
  hasKey: boolean;
}> {
  return (providers.PROVIDERS || []).map((p) => ({
    id: p.id,
    label: String(p.label || p.id),
    models: Array.isArray(p.models) ? p.models : [],
    hasKey: !!security.getSecret(p.id),
  }));
}

/** Конфигурация для UI: текущий выбор + список провайдеров. */
export function aiConfig(): AiCfg & { hasKey: boolean; providers: ReturnType<typeof aiProviders> } {
  const c = aiCfg();
  return { ...c, hasKey: !!security.getSecret(c.providerId), providers: aiProviders() };
}

/**
 * Сохранить выбор провайдера/модели (частично). Пустой providerId — «как в чате»,
 * пустая модель — «подобрать автоматически». Провайдер обязан существовать:
 * иначе остался бы «мёртвый» выбор, а ошибка всплыла бы при первом оформлении.
 */
export function setAiConfig(patch: { providerId?: unknown; model?: unknown } = {}): ReturnType<
  typeof aiConfig
> {
  const next: { provider: string; model: string } = {
    provider: aiCfg().providerFromChat ? "" : aiCfg().providerId,
    model: String(settings.get("myspace")?.ai?.model || ""),
  };
  if (patch.providerId !== undefined) {
    const id = String(patch.providerId || "").trim();
    if (id && !(providers.PROVIDERS || []).some((p) => p.id === id))
      throw new Error("notes_ai_provider_unknown: " + id);
    next.provider = id;
    // Смена провайдера обнуляет модель: имя от старого провайдера почти наверняка
    // не подойдёт новому (ровно на этом ловились «model not exist»).
    next.model = "";
  }
  if (patch.model !== undefined) next.model = String(patch.model || "").trim().slice(0, 200);
  settings.set({ myspace: { ai: next } });
  logger.action("myspace.ai.config", next);
  return aiConfig();
}

/** Живой список моделей провайдера (нет сети — каталог провайдера, чтобы селект не пустовал). */
export async function providerModels(
  id: string,
  appPage: unknown = null,
): Promise<{ provider: string; models: string[] }> {
  let provider: any;
  try {
    provider = providers.getProvider(String(id || ""));
  } catch {
    throw new Error("notes_ai_provider_unknown: " + String(id || ""));
  }
  const secret = security.getSecret(provider.id);
  if (!secret) throw new Error("notes_ai_not_configured: " + provider.id);
  let list: string[] = [];
  try {
    list = await runWithPage(appPage, () => provider.listModels(secret));
  } catch {
    /* нет сети — ниже отдадим каталог */
  }
  if (!Array.isArray(list) || !list.length) list = provider.models || [];
  return { provider: provider.id, models: list.filter(Boolean).map(String) };
}

/**
 * Провайдер + ключ + модель из настроек AI-чата. Коды ошибок те же по смыслу,
 * что у конспекта лекций (conspectus_*), но со своим префиксом notes_ai_* —
 * страница заметок переводит их в подсказки (см. notesAiError в MyspacePage).
 */
async function aiTarget(appPage: unknown): Promise<AiTarget> {
  const cfg = aiCfg();
  const providerId = cfg.providerId;
  let provider: any;
  try {
    provider = providers.getProvider(providerId);
  } catch {
    throw new Error("notes_ai_provider_unknown: " + providerId);
  }
  const secret = security.getSecret(provider.id);
  if (!secret) throw new Error("notes_ai_not_configured: " + provider.id);
  let model = cfg.model;
  if (!model) {
    let list: string[] = [];
    try {
      list = await runWithPage(appPage, () => provider.listModels(secret));
    } catch {
      /* нет сети — берём каталог провайдера */
    }
    if (!Array.isArray(list) || !list.length) list = provider.models || [];
    // reasoner медленнее и хуже держит длинный контекст — предпочитаем chat-модель.
    model = list.find((m) => /chat|turbo|flash|mini|small|lite/i.test(m)) || list[0] || "";
  }
  if (!model) throw new Error("notes_ai_model_missing: " + provider.id);
  return { provider, secret, model };
}

/** Один запрос к модели: собираем поток целиком (заметка ждёт готовый текст). */
async function askModel(
  target: AiTarget,
  prompt: string,
  appPage: unknown,
  maxTokens: number,
  systemPrompt: string = SYSTEM_PROMPT,
): Promise<string> {
  const text = await runWithPage(appPage, () =>
    target.provider.chat({
      secret: target.secret,
      model: target.model,
      messages: [
        { role: "system", text: systemPrompt },
        { role: "user", text: prompt },
      ],
      temperature: TEMPERATURE,
      maxTokens,
      stream: true,
    }),
  );
  return String(text || "").trim();
}

export interface NotesAiFormatOptions {
  /** Путь заметки внутри vault (как в /api/myspace/file). */
  path: string;
  /** Текущий текст заметки — нужен для режима «format». */
  content?: string;
  /** Заголовок заметки: подсказка модели и имя в промпте. */
  title?: string;
  /** format — оформить текущий текст; regenerate — заново из sidecar-исходника. */
  mode?: "format" | "regenerate";
  /** Страница-инициатор: провайдер ходит в сеть через per-page proxy. */
  appPage?: unknown;
}

/**
 * Оформить заметку. В vault ничего не пишет — возвращает готовый текст, а запись
 * делает роут (server/routes/myspace.js), чтобы у файла остались тот же
 * frontmatter и та же точка логирования.
 */
export async function formatNote(opts: NotesAiFormatOptions): Promise<NotesAiResult> {
  const mode = opts.mode === "regenerate" ? "regenerate" : "format";
  let raw: string;
  if (mode === "regenerate") {
    raw = readSource(opts.path).trim();
    if (!raw) throw new Error("notes_ai_no_source");
  } else {
    raw = String(opts.content || "").trim();
    if (!raw) throw new Error("notes_ai_empty_note");
    // Исходник сохраняем ДО запроса: если модель или сеть упадут, «Регенерировать»
    // всё равно будет из чего собирать оформление.
    const written = writeSource(opts.path, raw);
    if (!written.ok)
      logger.warn("notes.ai.source_failed", { path: opts.path, error: written.error });
  }

  const blocks = splitForFormat(raw);
  if (blocks.length > MAX_CHUNKS) throw new Error("notes_ai_too_long: " + raw.length);
  const target = await aiTarget(opts.appPage);
  const title = String(opts.title || "");
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const answer = await askModel(
      target,
      buildPrompt(blocks[i], title, i + 1, blocks.length),
      opts.appPage,
      maxTokensFor(blocks[i].length),
    );
    const clean = cleanupAnswer(answer);
    if (!clean) throw new Error("notes_ai_empty_response");
    parts.push(clean);
  }

  const content = parts.join("\n\n").trim();
  // Проверка «на потерю» — только для одиночного запроса: при склейке блоков
  // сравнивать размер с исходником некорректно (пустые строки и пунктуация
  // схлопываются законно), но там потери и не бывает: текст возвращается
  // поблочно с сохранением порядка.
  if (blocks.length === 1 && raw.length >= 400 && content.length < raw.length * MIN_KEEP_RATIO)
    throw new Error("notes_ai_short_output: " + content.length + "/" + raw.length);

  logger.action("notes.ai." + mode, {
    path: opts.path,
    provider: target.provider.id,
    model: target.model,
    rawChars: raw.length,
    chars: content.length,
    blocks: blocks.length,
  });
  return {
    content,
    provider: target.provider.id,
    model: target.model,
    chars: content.length,
    rawChars: raw.length,
    blocks: blocks.length,
    regenerated: mode === "regenerate",
  };
}

const ARTICLE_CLEANUP_SYSTEM_PROMPT =
  "Ты — редактор, который готовит извлечённый со страницы текст статьи для чтения. " +
  "Удаляешь мусор (меню, рекламу, подписи на кнопки, cookie-баннеры, ссылки " +
  "\"читайте также\", подвал сайта, повторяющиеся заголовки навигации), но " +
  "НЕ меняешь и не сокращаешь сам текст статьи.";

function buildArticleCleanupPrompt(text: string, title: string, part: number, total: number): string {
  const where =
    total > 1
      ? `Ниже ФРАГМЕНТ ${part} из ${total} извлечённого текста статьи «${title || "без названия"}» (это кусок одной статьи, продолжение — в следующем фрагменте).`
      : `Ниже текст статьи «${title || "без названия"}», извлечённый со страницы автоматически.`;
  return `${where}
Он мог зацепить постороннее: меню сайта, рекламные блоки, призывы подписаться,
плашки cookie/согласий, блоки "похожие статьи"/"читайте также", подвал сайта,
кнопки "поделиться". Убери ВСЁ, что не относится к самой статье.
Сам текст статьи оставь ПОЛНОСТЬЮ, дословно — не сокращай, не пересказывай,
не меняй формулировки, не добавляй ничего от себя.

Верни ТОЛЬКО очищенный текст статьи, без пояснений.
=== ТЕКСТ ===
${text}`;
}

/**
 * Прогоняет извлечённый текст статьи через ту же модель, что и оформление
 * заметок — убирает меню/рекламу/мусор навигации, которые остались после
 * грубого HTML→текст парсера (server/ts/bookmarks.ts). Если ключ ИИ не
 * настроен или запрос упал — бросает ошибку, вызывающий код обязан тихо
 * откатиться на исходный текст (сохранение статьи не должно падать из-за
 * недоступности ИИ).
 */
export async function cleanupArticleText(
  text: string,
  title: string,
  appPage?: unknown,
): Promise<string> {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const blocks = splitForFormat(raw);
  if (blocks.length > MAX_CHUNKS) return raw; // статья слишком длинная — не рискуем, отдаём как есть
  const target = await aiTarget(appPage);
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const answer = await askModel(
      target,
      buildArticleCleanupPrompt(blocks[i], title, i + 1, blocks.length),
      appPage,
      maxTokensFor(blocks[i].length),
      ARTICLE_CLEANUP_SYSTEM_PROMPT,
    );
    const clean = cleanupAnswer(answer);
    if (!clean) throw new Error("notes_ai_empty_response");
    parts.push(clean);
  }
  const content = parts.join("\n\n").trim();
  // Та же защита от "потери текста", что у formatNote: если модель вернула
  // заметно меньше половины — она что-то выкинула сверх мусора, лучше отдать
  // исходный вырез, чем статью с дырами.
  if (content.length < raw.length * MIN_KEEP_RATIO) return raw;
  return content;
}

const QUICK_NOTE_SYSTEM_PROMPT =
  "Ты — редактор личных заметок. Приводишь расшифровку устной голосовой " +
  "заметки к аккуратному структурированному Markdown, не меняя смысл и не " +
  "выбрасывая факты.";

function buildQuickNotePrompt(text: string): string {
  return `Ниже — расшифровка короткой устной голосовой заметки (whisper мог допустить
опечатки/пунктуационные ошибки — поправь их по смыслу). Преобрази её в
аккуратный структурированный Markdown:
- вынеси заголовок (## Заголовок) по смыслу заметки;
- если в заметке несколько мыслей/пунктов — оформи как список;
- если есть даты/имена/числа — сохрани их точно, ничего не выдумывай;
- убери слова-паразиты и повторы устной речи, но не меняй смысл.

Верни ТОЛЬКО готовый Markdown, без пояснений и без обрамляющих \`\`\`.
=== РАСШИФРОВКА ===
${text}`;
}

/**
 * Структурировать расшифровку голосовой заметки в Markdown — облегчённая версия
 * formatNote() без привязки к файлу в vault (у быстрых заметок своё хранилище,
 * storage/quicknotes/index.json, sidecar-исходник им не нужен).
 */
export async function structureQuickNote(
  text: string,
  appPage?: unknown,
): Promise<{ content: string; provider: string; model: string }> {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("notes_ai_empty_note");
  const blocks = splitForFormat(raw);
  if (blocks.length > MAX_CHUNKS) throw new Error("notes_ai_too_long: " + raw.length);
  const target = await aiTarget(appPage);
  const parts: string[] = [];
  for (const block of blocks) {
    const answer = await askModel(
      target,
      buildQuickNotePrompt(block),
      appPage,
      maxTokensFor(block.length),
      QUICK_NOTE_SYSTEM_PROMPT,
    );
    const clean = cleanupAnswer(answer);
    if (!clean) throw new Error("notes_ai_empty_response");
    parts.push(clean);
  }
  logger.action("quicknotes.ai.structure", { provider: target.provider.id, model: target.model, rawChars: raw.length });
  return { content: parts.join("\n\n").trim(), provider: target.provider.id, model: target.model };
}