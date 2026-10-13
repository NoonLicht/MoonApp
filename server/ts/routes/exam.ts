/**
 * «Лекция → экзамен» (логика — в lectureExam.ts и fsrs.ts).
 *
 *  POST   /api/exam/:lectureId/build   — { conspectus?, cards?, quiz? } → карточки и тест из расшифровки
 *  GET    /api/exam/:lectureId         — { cards, quiz, lastResult }
 *  POST   /api/exam/:lectureId/quiz    — { answers: number[] } → оценка, слабые темы, ошибки в колоду
 *  DELETE /api/exam/:lectureId         — удалить карточки и тест лекции
 *  GET    /api/exam/due                — ?limit=&lectureId= → карточки к повторению с прогнозом интервалов
 *  POST   /api/exam/review             — { cardId, grade: 1..4 }
 *  GET    /api/exam/stats              — всего, к повторению, расписание на 14 дней
 */
import express from "express";
import { stmts } from "../db";
import * as lecture from "../lecture";
import { runWithPage } from "../middleware/perPageProxy";
import { conspectusTarget } from "../lectureConspectus";
import * as ex from "../lectureExam";
import { previewIntervals, type Grade } from "../fsrs";

const router = express.Router();

type Target = {
  provider: { chat(o: Record<string, unknown>): Promise<string> };
  secret: string;
  model: string;
};

router.get("/due", (req, res) => {
  const now = Date.now();
  const s = ex.loadStore();
  const lectureId = req.query.lectureId !== undefined ? Number(req.query.lectureId) : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const items = ex.dueCards(s.cards, now, limit, Number.isFinite(lectureId) ? lectureId : undefined);
  res.json({ items: items.map((c) => ({ ...c, intervals: previewIntervals(c, now) })) });
});

router.get("/stats", (_req, res) => res.json(ex.statsOf(ex.loadStore().cards, Date.now())));

router.post("/review", (req, res) => {
  const grade = Number(req.body?.grade);
  if (![1, 2, 3, 4].includes(grade)) return res.status(400).json({ error: "bad_grade" });
  const r = ex.applyReview(ex.loadStore(), String(req.body?.cardId ?? ""), grade as Grade, Date.now());
  if (!r.card) return res.status(404).json({ error: "card_not_found" });
  ex.saveStore(r.store);
  res.json({ card: r.card });
});

router.get("/:lectureId", (req, res) => {
  const id = Number(req.params.lectureId);
  const s = ex.loadStore();
  const q = s.quizzes[String(id)];
  res.json({
    cards: s.cards.filter((c) => c.lectureId === id),
    quiz: q?.quiz ?? [],
    lastResult: q?.lastResult ?? null,
  });
});

router.post("/:lectureId/build", async (req, res) => {
  try {
    const id = Number(req.params.lectureId);
    if (!stmts.lectureGet.get(id)) return res.status(404).json({ error: "session_not_found" });
    const chunks = stmts.chunkFor.all(id) as unknown as ex.ExamChunk[];
    const transcript = ex.transcriptFor(chunks);
    if (!transcript.trim()) return res.status(400).json({ error: "empty_transcript" });

    // Конспект — по желанию: он тяжёлый (десятки запросов к модели на длинной записи).
    let conspectus = false;
    if (req.body?.conspectus === true) {
      await lecture.generateConspectus(id, { appPage: req.appPage, replace: false });
      conspectus = true;
    }

    const t = (await conspectusTarget(req.appPage ?? null, "lecture.exam")) as unknown as Target;
    const text = await runWithPage(req.appPage ?? null, () =>
      t.provider.chat({
        secret: t.secret,
        model: t.model,
        messages: [
          { role: "system", text: "Ты методист: делаешь точные учебные карточки и тесты по лекции." },
          {
            role: "user",
            text: ex.buildExamPrompt(transcript, {
              cards: Number(req.body?.cards) || undefined,
              quiz: Number(req.body?.quiz) || undefined,
            }),
          },
        ],
        temperature: 0.3,
        maxTokens: 3500,
        stream: true,
      }),
    );
    const draft = ex.parseExam(String(text || ""));
    if (!draft.cards.length && !draft.quiz.length)
      return res.status(502).json({ error: "model_returned_no_exam" });

    const now = Date.now();
    let s = ex.loadStore();
    const added = ex.addCards(s, id, draft.cards, now);
    s = added.store;
    s.quizzes[String(id)] = { at: now, quiz: draft.quiz };
    ex.saveStore(s);
    res.json({ conspectus, cards: added.added, quiz: draft.quiz.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/:lectureId/quiz", (req, res) => {
  const id = Number(req.params.lectureId);
  const s = ex.loadStore();
  const q = s.quizzes[String(id)];
  if (!q || !q.quiz.length) return res.status(404).json({ error: "quiz_not_found" });
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.map(Number) : [];
  const result = ex.gradeQuiz(q.quiz, answers);
  const now = Date.now();
  let next = ex.absorbWrong(s, id, q.quiz, result.wrongIdx, now);
  next = {
    ...next,
    quizzes: { ...next.quizzes, [String(id)]: { ...q, lastResult: { ...result, at: now } } },
  };
  ex.saveStore(next);
  res.json(result);
});

router.delete("/:lectureId", (req, res) => {
  const id = Number(req.params.lectureId);
  const s = ex.loadStore();
  const quizzes = { ...s.quizzes };
  delete quizzes[String(id)];
  ex.saveStore({ cards: s.cards.filter((c) => c.lectureId !== id), quizzes });
  res.json({ ok: true });
});

export = router;
