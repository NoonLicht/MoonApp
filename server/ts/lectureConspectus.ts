/**
 * Выделено из lecture.ts при разбиении крупного файла (поведение не менялось).
 */
import fs from "fs";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import { getProvider, PROVIDERS } from "./providers";
import { getSecret } from "./security";
import { runWithPage } from "./middleware/perPageProxy";
import { stmts } from "./db";
import * as diarize from "./diarize";
import { cfg, getStatus, syncNotesFileSafe } from "./lecture";
import { fmtTs } from "./lectureExport";

/* ------------------------- AI-конспект (провайдер чата, чанками) ------------------------- */

/**
 * Конспект строится ЧАНКАМИ и в два прохода.
 *
 * Почему переписано: старая версия отправляла в локальный Ollama только последние
 * 14 000 символов расшифровки. Для часовой лекции это означало, что конспект
 * строится по её концу, а начало просто не существует. Плюс требовался
 * запущенный Ollama, хотя в приложении уже есть провайдеры чата (DeepSeek и др.)
 * с сохранёнными ключами.
 *
 * Схема: расшифровка делится на блоки по ~conspectusChunkChars символов, каждый
 * блок превращается в ЧЕРНОВЫЕ ЗАМЕТКИ (первый проход), затем заметки сводятся в
 * один структурированный конспект (второй проход). «Шов» (хвост предыдущего
 * блока) передаётся в следующий запрос, поэтому фразы на границе блоков не
 * теряются, а метки времени удерживают хронологию лекции.
 */

const CHUNK_PROMPT = `Ты — академический ассистент. Ниже ФРАГМЕНТ автоматической расшифровки
университетской лекции (сделана распознаванием речи, а не человеком — в тексте
неизбежны ошибки распознавания: перепутанные созвучные слова, искажённые
термины/имена/названия, случайно слипшиеся или разорванные слова, неверные
числа и т.п.).

Сначала определи по смыслу фрагмента, о какой предметной области идёт речь
(математика, право, экономика, программирование, история и т.д.) — дальше
опирайся на эту область, чтобы понять, какое слово подразумевалось на самом
деле, а не просто повторяй то, что услышал движок распознавания.

Твоя задача — ИСПРАВЛЯТЬ ошибки распознавания по смыслу и контексту, а не
механически переносить их в заметки:
- если слово явно искажено (созвучный термин из другой области, «каша» из
  слогов, перепутанное окончание) — восстанови то, что реально имелось в виду,
  и пиши уже исправленный вариант;
- формулы, определения и числа, которые распознавание могло исказить
  (перепутанные цифры, потерянные знаки), восстанавливай по внутренней логике
  темы, если это очевидно из контекста;
- если восстановить смысл невозможно (фрагмент слишком испорчен) — пропусти
  это место, а не выдумывай произвольную замену.

Дальше выпиши по фрагменту ЧЕРНОВЫЕ ЗАМЕТКИ на русском (без вступлений и
выводов), уже в исправленном виде:
- определения всех терминов, которые встречаются в тексте;
- теоремы, формулы (в LaTeX $...$), правила и условия их применимости;
- примеры и задачи вместе с решением;
- числовые факты, даты, имена;
- 2-3 вопроса по этому фрагменту, которые могут спросить на экзамене.

Не добавляй факты и темы, которых во фрагменте вообще не было — исправлять
искажённое слово можно и нужно, придумывать целиком новое содержание нельзя.
Если фрагмент — продолжение предыдущей мысли, так и укажи («продолжение: ...»).
=== ФРАГМЕНТ ===
`;

const MERGE_PROMPT = `Ты — академический ассистент. Ниже ЧЕРНОВЫЕ ЗАМЕТКИ по всей лекции,
собранные по фрагментам в хронологическом порядке (заметки уже прошли черновую
чистку от ошибок распознавания речи, но между фрагментами могли остаться
нестыковки в написании одного и того же термина/имени — приведи их к единому
варианту по смыслу, если очевидно, что это одно и то же).

Сначала сам определи тему и предметную область лекции по содержанию заметок
(не спрашивай пользователя и не проси уточнить — просто пойми это из текста)
и адаптируй терминологию и акценты конспекта под эту область.

Собери из них один аккуратный конспект на русском в Markdown ровно в таком виде:

## Тема лекции
(одна строка: предметная область и конкретная тема, определённые тобой по содержанию)

## Обзор
(2-4 абзаца: о чём лекция, логика изложения)

## Ключевые термины
| Термин | Определение |
|---|---|

## Основные теоремы и формулы
(нумерованный список; формулы в LaTeX-нотации $...$)

## Вопросы для подготовки к экзамену
1. (вопрос) — (краткий ожидаемый ответ)

Убери повторы и «черновые» пометки, сохрани порядок разделов лекции.
Не добавляй факты, которых не подразумевают заметки — но при этом не тяни
дословно явные огрехи распознавания речи (перепутанные слова, обрывки), если
по смыслу заметок понятно, что имелось в виду; в таком случае пиши исправленный
вариант.
=== ЗАМЕТКИ ===
`;

/** Системный промпт по умолчанию (используется, если не выбран пресет и нет своего текста). */
const DEFAULT_CONSPECTUS_SYSTEM_PROMPT =
  "Ты помогаешь студенту с конспектами лекций. Текст лекции получен автоматическим " +
  "распознаванием речи и содержит ошибки распознавания (перепутанные созвучные слова, " +
  "искажённые термины и имена). Сначала сам определи предметную область и тему лекции по " +
  "содержанию, дальше используй это понимание, чтобы по контексту восстанавливать слова, " +
  "которые распознавание исказило, и писать в конспекте уже исправленный, осмысленный " +
  "вариант — а не дословно повторять ошибки транскрипции. Не выдумывай факты, которых не " +
  "было в тексте: исправлять искажённое слово можно, придумывать новое содержание нельзя. " +
  "Пиши по-русски.";

/**
 * Общая приписка про ошибки распознавания речи — добавляется к каждому
 * предметному пресету ниже. Раньше пресеты требовали «только по тексту», из-за
 * чего модель дословно переносила в конспект явные ошибки whisper (перепутанные
 * созвучные слова, искажённые термины) вместо того, чтобы поправить их по
 * контексту своей предметной области (см. DEFAULT_CONSPECTUS_SYSTEM_PROMPT).
 */
const ASR_FIX_HINT =
  "Текст лекции получен автоматическим распознаванием речи и содержит ошибки " +
  "распознавания — по контексту предмета исправляй искажённые термины/имена, а не " +
  "переноси их в конспект дословно. Не выдумывай факты, которых не было в тексте.";

/**
 * Встроенные пресеты системного промпта под учебные предметы. Пользователь может
 * выбрать один из них или задать свой текст (свой текст всегда в приоритете).
 */
const CONSPECTUS_BUILTIN_PRESETS = [
  { id: "general", label: "Общий", builtin: true, systemPrompt: DEFAULT_CONSPECTUS_SYSTEM_PROMPT },
  {
    id: "economics",
    label: "Экономика",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту-экономисту с конспектом лекции. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Выделяй экономические термины, формулы, показатели и определения, сохраняй числовые примеры и графики словами.",
  },
  {
    id: "management",
    label: "Менеджмент",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту-менеджеру с конспектом лекции. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Выделяй управленческие модели, термины, кейсы и практические выводы.",
  },
  {
    id: "math",
    label: "Математика",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту с конспектом лекции по математике. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Сохраняй формулы, определения, теоремы и доказательства как можно точнее, в понятной текстовой нотации.",
  },
  {
    id: "programming",
    label: "Программирование",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту с конспектом лекции по программированию. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Сохраняй код, названия структур данных, алгоритмов и терминов как есть.",
  },
  {
    id: "law",
    label: "Право",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту-юристу с конспектом лекции. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Сохраняй ссылки на статьи законов, термины и формулировки максимально точно.",
  },
  {
    id: "history",
    label: "История",
    builtin: true,
    systemPrompt:
      `Ты помогаешь студенту-историку с конспектом лекции. Пиши по-русски. ${ASR_FIX_HINT} ` +
      "Сохраняй даты, имена, события и причинно-следственные связи.",
  },
];

// Пользовательские пресеты хранятся отдельным JSON-файлом (не в settings.json —
// там patch фильтруется белым списком типов number/string/boolean и не пропускает
// массивы объектов, см. server/ts/settings.ts sanitizePatch).
function readCustomPresets() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.FILES.conspectusPresets, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeCustomPresets(list: any) {
  fs.writeFileSync(config.FILES.conspectusPresets, JSON.stringify(list, null, 2), "utf8");
}

/** Все пресеты для панели: встроенные + пользовательские. */
export function conspectusPresets() {
  return [...CONSPECTUS_BUILTIN_PRESETS, ...readCustomPresets()];
}

/** Сохранить (создать/обновить) пользовательский пресет. */
export function saveConspectusPreset(patch: Record<string, any> = {}) {
  const label = String(patch.label || "")
    .trim()
    .slice(0, 60);
  const systemPrompt = String(patch.systemPrompt || "")
    .trim()
    .slice(0, 4000);
  if (!label || !systemPrompt) throw new Error("conspectus_preset_invalid");
  const list = readCustomPresets();
  const id =
    patch.id && list.some((p) => p.id === patch.id)
      ? patch.id
      : `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const next = [...list.filter((p) => p.id !== id), { id, label, systemPrompt, builtin: false }];
  writeCustomPresets(next);
  logger.action("lecture.conspectus.preset_save", { id, label });
  return conspectusPresets();
}

/** Удалить пользовательский пресет (встроенные удалить нельзя). */
export function deleteConspectusPreset(id: any) {
  const next = readCustomPresets().filter((p) => p.id !== id);
  writeCustomPresets(next);
  logger.action("lecture.conspectus.preset_delete", { id });
  return conspectusPresets();
}

/** Эффективный системный промпт: свой текст → выбранный пресет → дефолт. */
function resolveConspectusSystemPrompt(c: any) {
  if (c.systemPrompt) return c.systemPrompt;
  const preset = conspectusPresets().find((p) => p.id === c.presetId);
  return preset ? preset.systemPrompt : DEFAULT_CONSPECTUS_SYSTEM_PROMPT;
}

/** Настройки конспекта: провайдер и модель берём из настроек чата, если не заданы. */
function conspectusCfg() {
  const c = cfg();
  const chat = settings.get("chat") || {};
  const trigger = ["smart", "auto", "manual"].includes(String(c.conspectusTrigger))
    ? String(c.conspectusTrigger)
    : "smart";
  return {
    // "" — «как в чате»: провайдер берётся из настроек AI-чата (chat.provider).
    providerId: String(c.conspectusProvider || chat.provider || "deepseek"),
    providerFromChat: !c.conspectusProvider,
    model: String(c.conspectusModel || ""),
    // Режим запуска: smart (авто с проверками) | auto (авто всегда) | manual (кнопка).
    trigger,
    autoMinChars: Math.max(0, Math.min(200000, Number(c.conspectusAutoMinChars) || 0)),
    chunkChars: Math.max(1500, Math.min(20000, Number(c.conspectusChunkChars) || 6000)),
    overlapChars: Math.max(0, Math.min(2000, Number(c.conspectusOverlapChars) || 600)),
    maxChunks: Math.max(1, Math.min(300, Number(c.conspectusMaxChunks) || 60)),
    // Свой системный промпт (пусто — используется пресет или дефолт).
    systemPrompt: String(c.conspectusSystemPrompt || "").trim(),
    // Выбранный пресет (id из conspectusPresets()); игнорируется, если задан systemPrompt.
    presetId: String(c.conspectusPresetId || "general"),
    // Лимит токенов ответа модели на каждый запрос (влияет и на объём «размышлений»
    // у reasoning-моделей — см. resolveConspectusSystemPrompt/askModel).
    maxTokens: Math.max(256, Math.min(16000, Number(c.conspectusMaxTokens) || 3000)),
    temperature: 0.3,
  };
}

/**
 * Провайдер + ключ + модель для конспекта.
 * Модель: явная настройка → список провайдера → первая «chat»-модель из /models.
 * (У DeepSeek в API есть deepseek-chat и deepseek-reasoner; имени «flash» нет,
 * поэтому неизвестное имя не подставляем молча, а сверяемся со списком сервиса.)
 */
async function conspectusTarget(appPage: any) {
  const c = conspectusCfg();
  let provider;
  try {
    provider = getProvider(c.providerId);
  } catch {
    throw new Error("conspectus_provider_unknown: " + c.providerId);
  }
  const secret = getSecret(provider.id);
  if (!secret) throw new Error("conspectus_not_configured: " + provider.id);
  let model = c.model;
  if (!model) {
    let list: any[] = [];
    try {
      list = await runWithPage(appPage, () => provider.listModels(secret));
    } catch {
      /* нет сети — берём каталог провайдера */
    }
    if (!Array.isArray(list) || !list.length) list = provider.models || [];
    // reasoner медленнее и хуже держит длинный контекст — предпочитаем chat-модель.
    model = list.find((m: any) => /chat|turbo|flash|mini|small|lite/i.test(m)) || list[0] || "";
  }
  if (!model) throw new Error("conspectus_model_missing: " + provider.id);
  return { provider, secret, model, cfg: { ...c, systemPrompt: resolveConspectusSystemPrompt(c) } };
}

/* --- Настройки конспекта и выбор провайдера (панель «ИИ-конспект») --- */

/**
 * Провайдеры для панели: ярлык, каталог моделей и ЕСТЬ ЛИ КЛЮЧ.
 * Без этого списка пользователь выбирал «OpenAI», не понимая, что ключа нет,
 * и получал conspectus_not_configured уже во время сборки конспекта.
 */
export function conspectusProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    models: Array.isArray(p.models) ? p.models : [],
    hasKey: !!getSecret(p.id),
  }));
}

/** Настройки конспекта одним ответом: провайдер, модель, режим запуска + список. */
export function conspectusSettings() {
  const c = conspectusCfg();
  const chat = settings.get("chat") || {};
  return {
    providerId: c.providerId,
    providerFromChat: c.providerFromChat, // true — провайдер наследуется от чата
    chatProvider: String(chat.provider || ""),
    hasKey: !!getSecret(c.providerId),
    model: c.model,
    trigger: c.trigger,
    autoMinChars: c.autoMinChars,
    chunkChars: c.chunkChars,
    overlapChars: c.overlapChars,
    maxChunks: c.maxChunks,
    systemPrompt: c.systemPrompt, // свой текст (пусто — используется пресет)
    presetId: c.presetId,
    maxTokens: c.maxTokens,
    presets: conspectusPresets(),
    triggerOptions: ["smart", "auto", "manual"],
    providers: conspectusProviders(),
  };
}

/** Сохранить настройки конспекта (частично: только переданные поля). */
export function setConspectusSettings(patch: Record<string, any> = {}) {
  const c = cfg();
  const next: Record<string, any> = {};
  const num = (v: any, lo: any, hi: any, fallback: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  if (patch.providerId !== undefined) {
    const id = String(patch.providerId || "");
    // "" — «как в чате» (chat.provider); иначе провайдер обязан существовать.
    if (id && !PROVIDERS.some((p) => p.id === id))
      throw new Error("conspectus_provider_unknown: " + id);
    next.conspectusProvider = id;
  }
  if (patch.model !== undefined) next.conspectusModel = String(patch.model || "").slice(0, 200);
  if (patch.trigger !== undefined) {
    const tr = String(patch.trigger || "");
    if (!["smart", "auto", "manual"].includes(tr))
      throw new Error("conspectus_trigger_unknown: " + tr);
    next.conspectusTrigger = tr;
  }
  if (patch.autoMinChars !== undefined) {
    next.conspectusAutoMinChars = Math.round(
      num(patch.autoMinChars, 0, 200000, Number(c.conspectusAutoMinChars) || 0),
    );
  }
  if (patch.chunkChars !== undefined)
    next.conspectusChunkChars = Math.round(num(patch.chunkChars, 1500, 20000, 6000));
  if (patch.overlapChars !== undefined)
    next.conspectusOverlapChars = Math.round(num(patch.overlapChars, 0, 2000, 0));
  if (patch.maxChunks !== undefined)
    next.conspectusMaxChunks = Math.round(num(patch.maxChunks, 1, 300, 60));
  if (patch.systemPrompt !== undefined)
    next.conspectusSystemPrompt = String(patch.systemPrompt || "")
      .trim()
      .slice(0, 4000);
  if (patch.presetId !== undefined)
    next.conspectusPresetId = String(patch.presetId || "general").slice(0, 64);
  if (patch.maxTokens !== undefined)
    next.conspectusMaxTokens = Math.round(num(patch.maxTokens, 256, 16000, 3000));
  if (Object.keys(next).length) settings.set({ lecture: next });
  logger.action("lecture.conspectus.settings", next);
  return conspectusSettings();
}

/** Модели провайдера для селекта (живой /models, при отсутствии сети — каталог). */
export async function providerModels(id: any, appPage?: string | null) {
  let provider;
  try {
    provider = getProvider(String(id || ""));
  } catch {
    throw new Error("conspectus_provider_unknown: " + String(id || ""));
  }
  const secret = getSecret(provider.id);
  if (!secret) throw new Error("conspectus_not_configured: " + provider.id);
  let list: any[] = [];
  try {
    list = await runWithPage(appPage, () => provider.listModels(secret));
  } catch {
    /* нет сети — отдаём каталог провайдера, чтобы селект был не пустой */
  }
  if (!Array.isArray(list) || !list.length) list = provider.models || [];
  return { provider: provider.id, models: list.filter(Boolean).map(String) };
}

/** Символы и чанки с текстом — «масса» расшифровки для авто-режима. */
export function transcriptWeight(id: any) {
  const chunks = stmts.chunkFor.all(id);
  let chars = 0;
  for (const c of chunks) chars += String(c.text || "").trim().length;
  return { chars, chunks };
}

/** «Текст вырос заметно с прошлой сборки» — общий критерий для stale/авто. */
export function conspectusStale(lec: any, chars: any) {
  if (!lec?.conspectus_at) return false;
  const prev = Number(lec.conspectus_len) || 0;
  return chars > prev * 1.25 + 400;
}

/**
 * Умный авто-конспект: запускается сам после того, как расшифровка дочитана.
 *
 * Почему «умный», а не «всегда»: сборка длинной лекции — это десятки запросов
 * к модели (деньги и время). Поэтому в режиме smart пропускаем запуск, когда
 * (а) расшифровки меньше autoMinChars — конспектировать нечего;
 * (б) текст не изменился с прошлой сборки — повтор был бы платой за то же самое.
 * Режим auto собирает всегда, manual — только по кнопке.
 */
export function maybeAutoConspectus(id: any) {
  let c;
  try {
    c = conspectusCfg();
  } catch {
    return;
  }
  if (c.trigger === "manual") return;
  if (conspectusJobs.get(id)?.state === "working") return; // уже собирается
  const lec = stmts.lectureGet.get(id);
  if (!lec) return; // сессию успели удалить
  const w = transcriptWeight(id);
  if (!w.chars) return; // распознанных слов нет
  if (c.trigger === "smart") {
    if (w.chars < c.autoMinChars) {
      logger.action("lecture.conspectus.skip", {
        id,
        chars: w.chars,
        min: c.autoMinChars,
        why: "too_short",
      });
      return;
    }
    if (lec.conspectus_at && !conspectusStale(lec, w.chars)) {
      logger.action("lecture.conspectus.skip", {
        id,
        chars: w.chars,
        prev: Number(lec.conspectus_len) || 0,
        why: "nothing_new",
      });
      return;
    }
  }
  logger.action("lecture.conspectus.auto", { id, chars: w.chars, trigger: c.trigger });
  // Ошибку авто-сборки не «выбрасываем в никуда»: она остаётся в conspectusJobs
  // (state=error) и видна панели, а сама лекция уже сохранена в архиве.
  void generateConspectus(id).catch((e) => {
    logger.error("lecture.conspectus.auto.error", { id, error: String(e?.message || e) });
  });
}

/**
 * Авто-диаризация после остановки записи (настройка diarizeEnabled).
 *
 * По умолчанию ВЫКЛЮЧЕНА: разбор длинной лекции — это минуты процессора, и
 * запускать его молча после каждой записи нельзя. Когда включена — расчёт идёт
 * в фоне, а прогресс виден на странице (GET /api/lecture/:id/diarize).
 */
export function maybeAutoDiarize(id: any) {
  let c;
  try {
    c = cfg();
  } catch {
    return;
  }
  if (c.diarizeEnabled !== true) return;
  if (diarize.diarizeState(id).state === "working") return;
  // Пакет не скачан — молча ничего не делаем: о необходимости скачать сообщит
  // панель «Говорящие», а не ошибка в логе после каждой лекции.
  if (!diarize.installed().ready) return;
  const hasText = stmts.chunkFor.all(id).some((x) => String(x.text || "").trim());
  if (!hasText) return;
  try {
    diarize.startDiarize(id);
    logger.action("lecture.diarize.auto", { id });
  } catch (e: any) {
    logger.error("lecture.diarize.auto", { id, error: String(e?.message || e) });
  }
}

/** Разбить расшифровку на блоки с таймкодами, не разрывая предложения. */
export function transcriptBlocks(chunks: any, chunkChars: any, overlapChars: any, maxChunks: any) {
  const segments = chunks
    .filter((c: any) => String(c.text || "").trim())
    .map((c: any) => ({
      at: Number(c.start_ms) || 0,
      text: String(c.text).replace(/\s+/g, " ").trim(),
    }))
    .sort((a: any, b: any) => a.at - b.at);
  const blocks = [];
  let cur: any[] = [];
  let size = 0;
  for (const s of segments) {
    const line = `[${fmtTs(s.at)}] ${s.text}`;
    if (size + line.length > chunkChars && cur.length) {
      // «Шов»: хвост предыдущего блока уходит в следующий запрос как контекст,
      // иначе фраза, разрезанная границей блока, теряет смысл.
      const tail: any = overlapChars > 0 ? String(cur[cur.length - 1]).slice(-overlapChars) : "";
      blocks.push(cur.join("\n"));
      cur = tail ? [`(...продолжение предыдущего фрагмента: ${tail})`] : [];
      size = cur.length ? cur[0].length : 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length) blocks.push(cur.join("\n"));
  // Предохранитель: многочасовая лекция не должна запускать сотни запросов.
  const truncated = blocks.length > maxChunks;
  return { blocks: blocks.slice(0, maxChunks), truncated, total: blocks.length };
}

/** Один вызов модели: собираем поток целиком (панель ждёт готовый конспект). */
async function askModel(target: any, prompt: any, appPage: any, maxTokens?: any) {
  const text = await runWithPage(appPage, () =>
    target.provider.chat({
      secret: target.secret,
      model: target.model,
      messages: [
        {
          role: "system",
          text: target.cfg.systemPrompt || DEFAULT_CONSPECTUS_SYSTEM_PROMPT,
        },
        { role: "user", text: prompt },
      ],
      temperature: target.cfg.temperature,
      maxTokens: maxTokens || target.cfg.maxTokens || 3000,
      stream: true,
    }),
  );
  return String(text || "").trim();
}

/** Состояние сборки конспекта (для прогресса в UI). */
const conspectusJobs = new Map();
export function conspectusState(id: any) {
  const job = conspectusJobs.get(id);
  const lec = stmts.lectureGet.get(id);
  const w = lec ? transcriptWeight(id) : { chars: 0, chunks: [] };
  let c = null;
  try {
    c = conspectusCfg();
  } catch {
    /* настройки ещё не читаются — отдаём базовое */
  }
  return {
    ...(job || {
      state: "idle",
      progress: 0,
      total: 0,
      phase: "",
      model: "",
      error: "",
      truncated: false,
      at: 0,
    }),
    // Режим и «устаревание» для панели: в ручном режиме авто-сборки не будет,
    // а stale честно говорит, что после сборки расшифровка заметно выросла.
    trigger: c?.trigger || "smart",
    providerId: c?.providerId || "",
    autoMinChars: c?.autoMinChars ?? 0,
    transcriptChars: w.chars,
    conspectusAt: lec?.conspectus_at || "",
    stale: conspectusStale(lec, w.chars),
  };
}

/**
 * Собрать конспект лекции: блоки → черновые заметки → общий конспект.
 * Прогресс доступен на GET /:id/conspectus, пока идёт сборка.
 *
 * opts.replace = true — «Регенерировать» со страницы: конспект собирается заново
 * из расшифровки и ПЕРЕЗАПИСЫВАЕТ заметки, а не дописывается в них. Так кнопка
 * возвращает «чистый» конспект, если предыдущая сборка оказалась неудачной.
 */
export async function generateConspectus(
  id: any,
  opts: { appPage?: string | null; target?: any; replace?: boolean } = {},
) {
  const { appPage = null, target: injected = null, replace = false } = opts;
  const st = getStatus(id);
  if (!st) throw new Error("session_not_found");
  if (!st.chunks.some((c) => String(c.text || "").trim())) throw new Error("no_transcript_yet");
  if (conspectusJobs.get(id)?.state === "working") throw new Error("conspectus_busy");

  const c = injected?.cfg ? { ...conspectusCfg(), ...injected.cfg } : conspectusCfg();
  const { blocks, truncated, total } = transcriptBlocks(
    st.chunks,
    c.chunkChars,
    c.overlapChars,
    c.maxChunks,
  );
  const started = Date.now();
  const setJob = (patch: any) => conspectusJobs.set(id, { ...conspectusState(id), ...patch });
  setJob({
    state: "working",
    progress: 0,
    total: blocks.length,
    phase: "notes",
    model: "",
    error: "",
    truncated,
    at: started,
  });
  try {
    // target можно внедрить (тесты и локальные модели): тогда ключ/провайдер не нужны.
    const target = injected || (await conspectusTarget(appPage));
    setJob({ model: target.model });

    // --- Первый проход: черновые заметки по каждому блоку ---
    const notes = [];
    for (let i = 0; i < blocks.length; i++) {
      const part = await askModel(target, CHUNK_PROMPT + blocks[i], appPage);
      if (part) notes.push(`### Фрагмент ${i + 1}\n${part}`);
      setJob({ progress: i + 1, phase: "notes" });
    }
    if (!notes.length) throw new Error("conspectus_empty_response");

    // --- Второй проход: свести заметки в один конспект ---
    setJob({ phase: "merge", progress: 0, total: 1 });
    const merged = notes.join("\n\n");
    let markdown;
    if (merged.length <= c.chunkChars * 2) {
      markdown = await askModel(target, MERGE_PROMPT + merged, appPage, 4000);
    } else {
      // Заметки не влезли в один запрос → сворачиваем группами, затем финал.
      const groups = [];
      let cur = "";
      for (const n of notes) {
        if (cur.length + n.length > c.chunkChars && cur) {
          groups.push(cur);
          cur = "";
        }
        cur += (cur ? "\n\n" : "") + n;
      }
      if (cur) groups.push(cur);
      const condensed = [];
      for (let i = 0; i < groups.length; i++) {
        condensed.push(
          await askModel(
            target,
            `Сожми заметки по фрагментам лекции, сохранив все термины, формулы и вопросы.\n=== ЗАМЕТКИ ===\n${groups[i]}`,
            appPage,
            3000,
          ),
        );
        setJob({ progress: i + 1, total: groups.length });
      }
      markdown = await askModel(target, MERGE_PROMPT + condensed.join("\n\n"), appPage, 4000);
    }
    markdown = String(markdown || "").trim();
    if (!markdown) throw new Error("conspectus_empty_response");

    const lec = stmts.lectureGet.get(id);
    // replace — «Регенерировать»: заметки ПЕРЕЗАПИСЫВАЮТСЯ новым конспектом
    // (маркеры «важного» и ручные пометки при этом теряются — кнопку нажали
    // осознанно). Обычная сборка и авто-режим по-прежнему ДОПИСЫВАЮТ конспект,
    // чтобы не затирать заметки, которые студент вёл по ходу лекции.
    // Имя nextNotes, а не merged: merged выше — уже собранные черновые заметки.
    const nextNotes = replace ? markdown : (lec?.notes ? lec.notes + "\n\n" : "") + markdown;
    stmts.lectureUpdate.run(id, {
      notes: nextNotes,
      // Метаданные авто-режима: когда собрали и по какой длине расшифровки.
      // Без них smart-режим не отличал бы «нового текста нет» от «лекция
      // дочитана» и платил бы за повторную сборку на каждый чанк.
      conspectus_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      conspectus_len: transcriptWeight(id).chars,
    });
    // Конспект сразу уходит в .md файл лекции: и при нажатии кнопки «ИИ-конспект»,
    // и в авто-режиме (maybeAutoConspectus → generateConspectus) — файл
    // перезаписывается тем же, а не заводится заново (см. syncNotesFile).
    syncNotesFileSafe(id, "conspectus");
    logger.action("lecture.conspectus", {
      id,
      provider: target.provider.id,
      model: target.model,
      blocks: blocks.length,
      chars: markdown.length,
      ms: Date.now() - started,
      truncated,
      replaced: !!replace,
    });
    setJob({
      state: "done",
      progress: blocks.length,
      total: blocks.length,
      phase: "done",
      model: target.model,
      error: "",
    });
    return {
      markdown,
      model: `${target.provider.id}/${target.model}`,
      blocks: blocks.length,
      truncated,
      ofTotal: total,
      replaced: !!replace,
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    setJob({ state: "error", phase: "", error: msg });
    logger.error("lecture.conspectus.error", { id, error: msg });
    throw e;
  }
}
