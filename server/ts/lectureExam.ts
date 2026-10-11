/**
 * «Лекция → экзамен»: из расшифровки лекции модель делает карточки и тест,
 * ответы на тест выявляют слабые темы, а карточки повторяются по FSRS.
 *
 * Здесь — чистая логика (подсказка модели, разбор JSON, оценка теста, очередь
 * повторений) и простое хранилище в одном JSON. Вызов модели — в routes.
 */
import fs from "fs";
import path from "path";
import { newCard, review, type FsrsCard, type Grade } from "./fsrs";

export interface ExamChunk {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ExamCardIn {
  q: string;
  a: string;
  topic: string;
  /** Момент в лекции (мс), откуда вопрос; 0 — неизвестно. */
  ms: number;
}

export interface QuizQuestion {
  q: string;
  options: string[];
  answer: number;
  topic: string;
  ms: number;
}

export interface ExamDraft {
  cards: ExamCardIn[];
  quiz: QuizQuestion[];
}

const MAX_CHARS = 12_000;

const stamp = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** Текст лекции с метками времени; длинная запись равномерно прореживается. */
export function transcriptFor(chunks: ExamChunk[], maxChars = MAX_CHARS): string {
  const lines = chunks
    .filter((c) => String(c.text ?? "").trim())
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((c) => `[${stamp(c.start_ms)}] ${String(c.text).trim()}`);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return lines.join("\n");
  const keepEvery = Math.ceil(total / maxChars);
  return lines.filter((_, i) => i % keepEvery === 0).join("\n").slice(0, maxChars);
}

export function buildExamPrompt(transcript: string, o: { cards?: number; quiz?: number } = {}): string {
  return (
    `По тексту лекции составь учебные материалы. Верни ТОЛЬКО JSON без пояснений вида:\n` +
    `{"cards":[{"q":"вопрос","a":"краткий ответ","topic":"тема","t":"чч:мм:сс"}],` +
    `"quiz":[{"q":"вопрос","options":["A","B","C","D"],"answer":0,"topic":"тема","t":"чч:мм:сс"}]}\n` +
    `Карточек: ${o.cards ?? 12}, вопросов теста: ${o.quiz ?? 8}. Вопросы по сути материала, без «что сказал лектор». ` +
    `В тесте ровно 4 варианта, answer — номер верного (с нуля). t — метка времени, где тема раскрыта. ` +
    `Не придумывай фактов, которых нет в тексте.\n\n=== ЛЕКЦИЯ ===\n${transcript}`
  );
}

function parseTs(v: unknown): number {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/** Достаёт JSON из ответа модели (с обёрткой ```json или текстом вокруг) и чистит его. */
export function parseExam(raw: string): ExamDraft {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let obj: { cards?: unknown; quiz?: unknown } = {};
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      /* битый JSON — вернём пустое */
    }
  }
  const str = (v: unknown, max = 600): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const cards: ExamCardIn[] = [];
  for (const c of Array.isArray(obj.cards) ? obj.cards : []) {
    const o = c as Record<string, unknown>;
    const q = str(o?.q);
    const a = str(o?.a);
    if (q.length >= 3 && a) cards.push({ q, a, topic: str(o?.topic, 80), ms: parseTs(o?.t) });
  }
  const quiz: QuizQuestion[] = [];
  for (const c of Array.isArray(obj.quiz) ? obj.quiz : []) {
    const o = c as Record<string, unknown>;
    const options = Array.isArray(o?.options) ? o.options.map((x) => str(x, 300)).filter(Boolean) : [];
    const answer = Number(o?.answer);
    const q = str(o?.q);
    if (q.length < 3 || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length)
      continue;
    quiz.push({ q, options: options.slice(0, 6), answer, topic: str(o?.topic, 80), ms: parseTs(o?.t) });
  }
  return { cards: cards.slice(0, 40), quiz: quiz.slice(0, 30) };
}

// ---------------- оценка теста ----------------

export interface QuizResult {
  total: number;
  correct: number;
  percent: number;
  /** Темы с ошибками, от самых слабых; ms — где пересмотреть. */
  weak: { topic: string; wrong: number; of: number; ms: number }[];
  wrongIdx: number[];
}

export function gradeQuiz(quiz: QuizQuestion[], answers: number[]): QuizResult {
  const topics = new Map<string, { wrong: number; of: number; ms: number }>();
  const wrongIdx: number[] = [];
  let correct = 0;
  quiz.forEach((q, i) => {
    const key = q.topic || "—";
    const t = topics.get(key) ?? { wrong: 0, of: 0, ms: 0 };
    t.of++;
    if (answers[i] === q.answer) correct++;
    else {
      t.wrong++;
      wrongIdx.push(i);
      if (!t.ms) t.ms = q.ms;
    }
    topics.set(key, t);
  });
  const weak = [...topics.entries()]
    .filter(([, v]) => v.wrong > 0)
    .map(([topic, v]) => ({ topic, ...v }))
    .sort((a, b) => b.wrong / b.of - a.wrong / a.of || b.wrong - a.wrong);
  return {
    total: quiz.length,
    correct,
    percent: quiz.length ? Math.round((correct / quiz.length) * 100) : 0,
    weak,
    wrongIdx,
  };
}

// ---------------- колода ----------------

export interface StoredCard extends FsrsCard {
  id: string;
  lectureId: number;
  q: string;
  a: string;
  topic: string;
  ms: number;
}

export interface ExamStore {
  cards: StoredCard[];
  quizzes: Record<string, { at: number; quiz: QuizQuestion[]; lastResult?: QuizResult & { at: number } }>;
}

export const emptyStore = (): ExamStore => ({ cards: [], quizzes: {} });

let seq = 0;
const makeId = (now: number): string => `${now.toString(36)}${(seq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Добавляет карточки лекции; одинаковые вопросы не дублируются. */
export function addCards(
  store: ExamStore,
  lectureId: number,
  items: ExamCardIn[],
  now: number,
): { store: ExamStore; added: number } {
  const have = new Set(store.cards.filter((c) => c.lectureId === lectureId).map((c) => c.q.toLowerCase()));
  const fresh: StoredCard[] = [];
  for (const it of items) {
    const k = it.q.toLowerCase();
    if (have.has(k)) continue;
    have.add(k);
    fresh.push({ ...newCard(now), id: makeId(now), lectureId, q: it.q, a: it.a, topic: it.topic, ms: it.ms });
  }
  return { store: { ...store, cards: [...store.cards, ...fresh] }, added: fresh.length };
}

/** Карточки к повторению: просроченные, самые давние первыми; новые — после просроченных. */
export function dueCards(cards: StoredCard[], now: number, limit = 20, lectureId?: number): StoredCard[] {
  return cards
    .filter((c) => c.due <= now && (lectureId === undefined || c.lectureId === lectureId))
    .sort((a, b) => (a.state === "new" ? 1 : 0) - (b.state === "new" ? 1 : 0) || a.due - b.due)
    .slice(0, limit);
}

export function applyReview(
  store: ExamStore,
  cardId: string,
  grade: Grade,
  now: number,
): { store: ExamStore; card: StoredCard | null } {
  let found: StoredCard | null = null;
  const cards = store.cards.map((c) => {
    if (c.id !== cardId) return c;
    found = { ...c, ...review(c, grade, now) };
    return found;
  });
  return { store: { ...store, cards }, card: found };
}

/** Ошибки в тесте возвращают соответствующие вопросы в колоду «к повторению сейчас». */
export function absorbWrong(
  store: ExamStore,
  lectureId: number,
  quiz: QuizQuestion[],
  wrongIdx: number[],
  now: number,
): ExamStore {
  const items: ExamCardIn[] = wrongIdx.map((i) => ({
    q: quiz[i].q,
    a: quiz[i].options[quiz[i].answer],
    topic: quiz[i].topic,
    ms: quiz[i].ms,
  }));
  const r = addCards(store, lectureId, items, now);
  // уже существующие карточки с этими вопросами тоже становятся срочными
  const wrongQ = new Set(items.map((x) => x.q.toLowerCase()));
  const cards = r.store.cards.map((c) =>
    c.lectureId === lectureId && wrongQ.has(c.q.toLowerCase()) && c.due > now ? { ...c, due: now } : c,
  );
  return { ...r.store, cards };
}

export interface ExamStats {
  total: number;
  due: number;
  fresh: number;
  learned: number;
  /** Ближайшие дни с числом карточек: расписание повторений. */
  schedule: { date: string; count: number }[];
}

export function statsOf(cards: StoredCard[], now: number, days = 14): ExamStats {
  const dayKey = (ts: number): string => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const today = dayKey(now);
  const by = new Map<string, number>();
  for (const c of cards) {
    if (c.state === "new") continue;
    const k = c.due <= now ? today : dayKey(c.due);
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const limit = dayKey(now + days * 86_400_000);
  return {
    total: cards.length,
    due: cards.filter((c) => c.due <= now).length,
    fresh: cards.filter((c) => c.state === "new").length,
    learned: cards.filter((c) => c.state === "review").length,
    schedule: [...by.entries()]
      .filter(([k]) => k <= limit)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ---------------- хранение ----------------

function storeFile(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "exam-decks.json");
}

export function loadStore(file = storeFile()): ExamStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      cards: Array.isArray(raw?.cards) ? raw.cards : [],
      quizzes: raw?.quizzes && typeof raw.quizzes === "object" ? raw.quizzes : {},
    };
  } catch {
    return emptyStore();
  }
}

export function saveStore(s: ExamStore, file = storeFile()): void {
  fs.writeFileSync(file, JSON.stringify(s), "utf8");
}
