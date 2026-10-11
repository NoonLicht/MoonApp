import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** FSRS и «Лекция → экзамен» (server/ts/fsrs.ts, lectureExam.ts). */
const req = createRequire(import.meta.url);
let f: any;
let ex: any;
beforeAll(() => {
  f = req("../server/fsrs");
  ex = req("../server/lectureExam");
});

const DAY = 86_400_000;

describe("FSRS", () => {
  it("первая оценка задаёт стабильность из весов и интервал растёт с оценкой", () => {
    const c = f.newCard(0);
    const hard = f.review(c, 2, 0);
    const good = f.review(c, 3, 0);
    const easy = f.review(c, 4, 0);
    expect(good.stability).toBeCloseTo(3.7145, 3);
    expect(hard.due).toBeLessThan(good.due);
    expect(good.due).toBeLessThan(easy.due);
    expect(good.state).toBe("review");
  });

  it("«снова» возвращает через минуты, добавляет провал и снижает стабильность", () => {
    let c = f.review(f.newCard(0), 3, 0);
    const before = c.stability;
    c = f.review(c, 1, 5 * DAY);
    expect(c.lapses).toBe(1);
    expect(c.state).toBe("relearning");
    expect(c.due - 5 * DAY).toBe(10 * 60_000);
    expect(c.stability).toBeLessThanOrEqual(before);
  });

  it("успешные повторения увеличивают интервал", () => {
    let c = f.review(f.newCard(0), 3, 0);
    const first = c.due;
    c = f.review(c, 3, first);
    expect(c.due - first).toBeGreaterThan(first - 0);
    expect(c.reps).toBe(2);
  });

  it("извлекаемость на интервале равна целевой 90 %", () => {
    const s = 10;
    const days = f.nextInterval(s);
    expect(f.retrievability(days, s)).toBeGreaterThan(0.89);
    expect(f.retrievability(days, s)).toBeLessThan(0.91);
  });

  it("сложность остаётся в пределах 1…10", () => {
    let c = f.review(f.newCard(0), 1, 0);
    for (let i = 1; i < 30; i++) c = f.review(c, 1, i * DAY);
    expect(c.difficulty).toBeLessThanOrEqual(10);
    expect(c.difficulty).toBeGreaterThanOrEqual(1);
  });
});

describe("разбор ответа модели", () => {
  it("достаёт JSON из обёртки и отбрасывает некорректные записи", () => {
    const raw =
      'Вот материалы:\n```json\n' +
      JSON.stringify({
        cards: [
          { q: "Что такое энтропия?", a: "Мера неопределённости", topic: "Энтропия", t: "00:12:30" },
          { q: "", a: "пусто" },
        ],
        quiz: [
          { q: "Единица энтропии?", options: ["бит", "ватт", "ньютон", "моль"], answer: 0, topic: "Энтропия", t: "00:13:00" },
          { q: "Плохой", options: ["a"], answer: 0 },
          { q: "Выход за границы", options: ["a", "b"], answer: 5 },
        ],
      }) +
      "\n```";
    const d = ex.parseExam(raw);
    expect(d.cards).toHaveLength(1);
    expect(d.cards[0].ms).toBe(12 * 60_000 + 30_000);
    expect(d.quiz).toHaveLength(1);
    expect(ex.parseExam("не json")).toEqual({ cards: [], quiz: [] });
  });

  it("длинную расшифровку прореживает, но укладывается в лимит", () => {
    const chunks = Array.from({ length: 400 }, (_, i) => ({
      start_ms: i * 1000,
      end_ms: i * 1000 + 900,
      text: `фрагмент номер ${i} ` + "слово ".repeat(10),
    }));
    expect(ex.transcriptFor(chunks, 3000).length).toBeLessThanOrEqual(3000);
  });
});

describe("тест и колода", () => {
  const quiz = [
    { q: "q1", options: ["a", "b"], answer: 0, topic: "Т1", ms: 1000 },
    { q: "q2", options: ["a", "b"], answer: 1, topic: "Т2", ms: 2000 },
    { q: "q3", options: ["a", "b"], answer: 1, topic: "Т2", ms: 3000 },
  ];

  it("оценивает и ранжирует слабые темы", () => {
    const r = ex.gradeQuiz(quiz, [0, 0, 0]);
    expect(r.correct).toBe(1);
    expect(r.percent).toBe(33);
    expect(r.weak).toEqual([{ topic: "Т2", wrong: 2, of: 2, ms: 2000 }]);
    expect(r.wrongIdx).toEqual([1, 2]);
  });

  it("ошибки попадают в колоду срочно и без дублей", () => {
    const now = 1_000_000;
    let s = ex.emptyStore();
    s = ex.addCards(s, 7, [{ q: "q2", a: "b", topic: "Т2", ms: 0 }], now).store;
    s.cards[0].due = now + 5 * DAY;
    const s2 = ex.absorbWrong(s, 7, quiz, [1, 2], now);
    expect(s2.cards.map((c: any) => c.q).sort()).toEqual(["q2", "q3"]);
    expect(s2.cards.every((c: any) => c.due <= now)).toBe(true);
  });

  it("очередь: просроченные раньше новых; расписание считает по дням", () => {
    const now = 10 * DAY;
    let s = ex.emptyStore();
    s = ex.addCards(s, 1, [
      { q: "новая", a: "a", topic: "", ms: 0 },
      { q: "старая", a: "a", topic: "", ms: 0 },
      { q: "позже", a: "a", topic: "", ms: 0 },
    ], now).store;
    const [nw, old, later] = s.cards;
    Object.assign(old, f.review(f.review(f.newCard(0), 3, 0), 3, 0), { due: now - DAY });
    Object.assign(later, f.review(f.newCard(now), 3, now));
    const due = ex.dueCards(s.cards, now);
    expect(due.map((c: any) => c.q)).toEqual(["старая", "новая"]);
    const st = ex.statsOf(s.cards, now);
    expect(st).toMatchObject({ total: 3, due: 2, fresh: 1 });
    expect(st.schedule.reduce((n: number, d: any) => n + d.count, 0)).toBe(2);
    expect(nw.state).toBe("new");
  });

  it("повторение обновляет карточку по id", () => {
    let s = ex.emptyStore();
    s = ex.addCards(s, 1, [{ q: "вопрос", a: "ответ", topic: "", ms: 0 }], 0).store;
    const r = ex.applyReview(s, s.cards[0].id, 3, 0);
    expect(r.card.reps).toBe(1);
    expect(ex.applyReview(s, "нет", 3, 0).card).toBeNull();
  });
});
