/**
 * Foresight — подсказки по ходу встречи (по мотивам Google AI Edge Foresight, всё локально).
 *
 *  • вопросы, прозвучавшие на встрече, находятся в расшифровке по мере её роста;
 *  • на каждый вопрос ищется ответ в личной базе знаний (заметки, файлы, дневник…: тот же
 *    семантический индекс на EmbeddingGemma, что и у умного поиска) и, если найдено,
 *    модель коротко отвечает по найденным отрывкам;
 *  • «заметки → полный текст»: сокращённые пометки пользователя раскрываются по расшифровке.
 *
 * Состояние карточек живёт в памяти процесса: оно производное от расшифровки (её можно
 * просканировать заново), а сама встреча хранится в обычной сессии лектория.
 */
import { stmts } from "./db";
import * as semantic from "./semantic";
import { askModel } from "./llmOnce";
import { fmtTs } from "./lectureExport";
import logger from "./logger";

export interface ChunkRow {
  id?: number;
  start_ms: number;
  end_ms: number;
  text: string;
  status?: string;
}

export interface Source {
  source: string;
  ref: string;
  title: string;
  snippet: string;
  score: number;
}

export interface Card {
  id: string;
  question: string;
  atMs: number;
  status: "searching" | "done" | "none" | "error";
  answer: string;
  sources: Source[];
  manual: boolean;
}

/* ------------------------- Поиск вопросов ------------------------- */

const WH_RU =
  /^(?:а\s+|и\s+|ну\s+|так\s+)?(?:кто|что|как|какой|какая|какое|какие|каких|каким|каком|которы[йеяхм]|почему|зачем|когда|где|куда|откуда|сколько|чей|чья|чьё|чьи|можно\s+ли|нужно\s+ли|надо\s+ли|правда\s+ли|есть\s+ли|будет\s+ли|может\s+ли|должен\s+ли)(?![\p{L}\p{N}])/iu;
const WH_EN = /^(?:what|why|how|when|where|who|whom|whose|which)(?![\p{L}\p{N}])/iu;
const AUX_EN = /^(?:can|could|would|should|will|do|does|did|is|are|was|were|have|has|shall)\s+\w+/iu;
const MIN_LEN = 8;

/** Разбивка текста на предложения с сохранением знака конца. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+[.!?…]*/g;
  for (const m of String(text || "").matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Предложение — вопрос, если оканчивается «?» либо начинается с вопросительного слова
 * (расшифровка часто не ставит знак). Слишком короткое («что?», «да?») не считается.
 */
export function isQuestion(sentence: string): boolean {
  const s = sentence.trim().replace(/^[—–-]\s*/, "");
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_LEN) return false;
  if (/\?\s*$/.test(s)) return true;
  if (/[.!…]\s*$/.test(s)) return false;
  return WH_RU.test(s) || WH_EN.test(s) || AUX_EN.test(s);
}

const norm = (q: string): string =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Вопросы из расшифровки, прозвучавшие после `afterMs`: [{question, atMs}]. */
export function detectQuestions(
  chunks: ChunkRow[],
  afterMs = -1,
): { question: string; atMs: number }[] {
  const found: { question: string; atMs: number }[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (c.end_ms <= afterMs) continue;
    if (c.status && c.status !== "done") continue;
    for (const s of splitSentences(c.text)) {
      if (!isQuestion(s)) continue;
      const k = norm(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      found.push({ question: s.replace(/^[—–-]\s*/, ""), atMs: c.start_ms });
    }
  }
  return found;
}

/* ------------------------- Состояние встречи ------------------------- */

interface State {
  scanMs: number;
  cards: Card[];
  queue: Promise<void>;
}

const states = new Map<number, State>();
let counter = 0;
const MIN_SCORE = 0.4;
const MAX_CARDS = 60;

function stateOf(id: number): State {
  let s = states.get(id);
  if (!s) {
    s = { scanMs: -1, cards: [], queue: Promise.resolve() };
    states.set(id, s);
  }
  return s;
}

const newId = (): string => `q${Date.now().toString(36)}${(counter++).toString(36)}`;

export const cardsOf = (id: number): Card[] => stateOf(id).cards;

export function dismiss(id: number, cardId: string): boolean {
  const s = stateOf(id);
  const before = s.cards.length;
  s.cards = s.cards.filter((c) => c.id !== cardId);
  return s.cards.length !== before;
}

/** Забыть состояние встречи (после удаления сессии). */
export function forget(id: number): void {
  states.delete(id);
}

const SYSTEM =
  "Ты помощник на встрече. Отвечай кратко (1–3 предложения) на языке вопроса и ТОЛЬКО по приведённым " +
  "отрывкам из личных заметок и файлов. Если в них нет ответа — напиши ровно «нет данных».";

export function buildAnswerPrompt(question: string, sources: Source[]): string {
  const ctx = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}`)
    .join("\n\n")
    .slice(0, 6000);
  return `Вопрос: ${question}\n\nОтрывки:\n${ctx}\n\nОтвет:`;
}

async function answer(card: Card, appPage: string | null): Promise<void> {
  try {
    const hits = (await semantic.search(card.question, { limit: 5 })) as unknown as Source[];
    const good = hits.filter((h) => h.score >= MIN_SCORE).slice(0, 4);
    if (!good.length) {
      card.status = "none";
      return;
    }
    card.sources = good.map((h) => ({
      source: h.source,
      ref: h.ref,
      title: h.title,
      snippet: String(h.snippet || "").slice(0, 400),
      score: Math.round(h.score * 100) / 100,
    }));
    try {
      const text = await askModel(SYSTEM, buildAnswerPrompt(card.question, card.sources), {
        appPage,
        maxTokens: 300,
        temperature: 0.1,
      });
      const clean = text.replace(/^\s*ответ:\s*/i, "").trim();
      // Модель сама сказала, что в отрывках ответа нет — источники всё равно показываем.
      card.answer = /^нет данных\.?$/i.test(clean) ? "" : clean;
    } catch (e) {
      // Модель недоступна — подсказка остаётся списком найденных источников.
      logger.warn("foresight.llm_failed", { error: String((e as Error).message).slice(0, 200) });
    }
    card.status = "done";
  } catch (e) {
    card.status = "error";
    logger.warn("foresight.search_failed", { error: String((e as Error).message).slice(0, 200) });
  }
}

function enqueue(id: number, card: Card, appPage: string | null): void {
  const s = stateOf(id);
  s.queue = s.queue.then(() => answer(card, appPage)).catch(() => undefined);
}

function addCard(
  id: number,
  question: string,
  atMs: number,
  manual: boolean,
  appPage: string | null,
): Card {
  const s = stateOf(id);
  const card: Card = {
    id: newId(),
    question,
    atMs,
    status: "searching",
    answer: "",
    sources: [],
    manual,
  };
  s.cards.push(card);
  if (s.cards.length > MAX_CARDS) s.cards.splice(0, s.cards.length - MAX_CARDS);
  enqueue(id, card, appPage);
  return card;
}

/** Просканировать новые чанки на вопросы; для каждого нового запускается поиск ответа. */
export function scan(id: number, appPage: string | null = null): { added: number; cards: Card[] } {
  if (!stmts.lectureGet.get(id)) throw new Error("session_not_found");
  const s = stateOf(id);
  const chunks = stmts.chunkFor.all(id) as unknown as ChunkRow[];
  const known = new Set(s.cards.map((c) => norm(c.question)));
  const fresh = detectQuestions(chunks, s.scanMs).filter((q) => !known.has(norm(q.question)));
  for (const q of fresh) addCard(id, q.question, q.atMs, false, appPage);
  const done = chunks.filter((c) => c.status === "done");
  if (done.length) s.scanMs = Math.max(s.scanMs, ...done.map((c) => c.end_ms));
  return { added: fresh.length, cards: s.cards };
}

/** Вопрос, заданный вручную. */
export function ask(id: number, question: string, appPage: string | null = null): Card {
  const q = String(question || "").trim();
  if (!q) throw new Error("empty_question");
  if (!stmts.lectureGet.get(id)) throw new Error("session_not_found");
  return addCard(id, q, 0, true, appPage);
}

/* ------------------------- Заметки → полный текст ------------------------- */

const EXPAND_SYSTEM =
  "Ты превращаешь короткие пометки участника встречи в связные заметки. Используй ТОЛЬКО расшифровку " +
  "встречи как источник фактов: раскрой каждую пометку одним-двумя предложениями, сохрани порядок и " +
  "смысл, ничего не выдумывай. В конце добавь разделы «Решения» и «Задачи» (если они были в расшифровке; " +
  "иначе пропусти). Формат — Markdown, язык — как в пометках.";

/** Расшифровка с метками времени, ужатая до `limit` символов (равномерно по всей встрече). */
export function transcriptFor(chunks: ChunkRow[], limit = 14000): string {
  const lines = chunks
    .filter((c) => (c.status || "done") === "done" && String(c.text || "").trim())
    .map((c) => `[${fmtTs(c.start_ms)}] ${String(c.text).trim()}`);
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= limit) return lines.join("\n");
  // Слишком длинно — выкидываем каждую вторую-третью строку, пока не влезет.
  let step = 2;
  let cur = lines;
  while (total > limit && step < 12) {
    cur = lines.filter((_, i) => i % step === 0);
    total = cur.reduce((n, l) => n + l.length + 1, 0);
    step++;
  }
  return cur.join("\n").slice(0, limit);
}

export async function expandNotes(
  id: number,
  notes: string,
  appPage: string | null = null,
): Promise<string> {
  const text = String(notes || "").trim();
  if (!text) throw new Error("empty_notes");
  if (!stmts.lectureGet.get(id)) throw new Error("session_not_found");
  const transcript = transcriptFor(stmts.chunkFor.all(id) as unknown as ChunkRow[]);
  const user = `Расшифровка:\n${transcript || "(пока пуста)"}\n\nПометки участника:\n${text}\n\nПолные заметки:`;
  return askModel(EXPAND_SYSTEM, user, { appPage, maxTokens: 1800, temperature: 0.2 });
}
