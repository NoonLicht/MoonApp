/**
 * FSRS-4.5: планировщик интервальных повторений (стабильность, сложность,
 * извлекаемость). Чистые функции без хранилища; веса — значения по умолчанию.
 *
 * Оценки: 1 — снова, 2 — трудно, 3 — хорошо, 4 — легко.
 */

export type Grade = 1 | 2 | 3 | 4;
export type CardState = "new" | "learning" | "review" | "relearning";

export interface FsrsCard {
  /** Стабильность: через сколько дней извлекаемость падает до 90 %. */
  stability: number;
  /** Сложность 1…10. */
  difficulty: number;
  /** Момент следующего повторения (мс). */
  due: number;
  lastReview: number | null;
  reps: number;
  lapses: number;
  state: CardState;
}

export const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072,
  0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = 19 / 81;
export const REQUEST_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 36500;
const DAY = 86_400_000;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const clampD = (d: number): number => clamp(d, 1, 10);

export function newCard(now: number): FsrsCard {
  return { stability: 0, difficulty: 0, due: now, lastReview: null, reps: 0, lapses: 0, state: "new" };
}

/** Вероятность вспомнить через elapsedDays дней при стабильности s. */
export function retrievability(elapsedDays: number, s: number): number {
  if (s <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / s, DECAY);
}

/** Интервал в днях, после которого извлекаемость упадёт до целевой. */
export function nextInterval(s: number, retention = REQUEST_RETENTION): number {
  const days = (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, MAX_INTERVAL_DAYS);
}

const initStability = (g: Grade): number => Math.max(W[g - 1], 0.1);
const initDifficulty = (g: Grade): number => clampD(W[4] - W[5] * (g - 3));

function nextDifficulty(d: number, g: Grade): number {
  const next = d - W[6] * (g - 3);
  // возврат к среднему, чтобы сложность не застревала на краях
  return clampD(W[7] * initDifficulty(3) + (1 - W[7]) * next);
}

function recallStability(d: number, s: number, r: number, g: Grade): number {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy)
  );
}

function forgetStability(d: number, s: number, r: number): number {
  return Math.min(
    s,
    W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]),
  );
}

/** Новое состояние карточки после ответа. */
export function review(card: FsrsCard, grade: Grade, now: number): FsrsCard {
  if (card.state === "new" || card.stability <= 0) {
    const s = initStability(grade);
    const again = grade === 1;
    return {
      stability: s,
      difficulty: initDifficulty(grade),
      // «снова» повторяем через 10 минут, остальное — по интервалу
      due: again ? now + 10 * 60_000 : now + nextInterval(s) * DAY,
      lastReview: now,
      reps: 1,
      lapses: again ? 1 : 0,
      state: again ? "learning" : "review",
    };
  }
  const elapsed = card.lastReview !== null ? Math.max(0, (now - card.lastReview) / DAY) : 0;
  const r = retrievability(elapsed, card.stability);
  const d = nextDifficulty(card.difficulty, grade);
  if (grade === 1) {
    const s = Math.max(forgetStability(card.difficulty, card.stability, r), 0.1);
    return {
      stability: s,
      difficulty: d,
      due: now + 10 * 60_000,
      lastReview: now,
      reps: card.reps + 1,
      lapses: card.lapses + 1,
      state: "relearning",
    };
  }
  const s = recallStability(card.difficulty, card.stability, r, grade);
  return {
    stability: s,
    difficulty: d,
    due: now + nextInterval(s) * DAY,
    lastReview: now,
    reps: card.reps + 1,
    lapses: card.lapses,
    state: "review",
  };
}

/** Прогноз интервалов для четырёх кнопок (в днях; 0 — через минуты). */
export function previewIntervals(card: FsrsCard, now: number): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const g of [1, 2, 3, 4] as Grade[]) {
    const n = review(card, g, now);
    out[g] = g === 1 ? 0 : Math.round((n.due - now) / DAY);
  }
  return out;
}
