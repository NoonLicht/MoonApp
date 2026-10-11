/**
 * API дневника.
 *
 *  GET    /api/diary/entries?from=&to=   — записи (дата, слов, превью) + серия дней
 *  GET    /api/diary/entry/:date          — запись дня { date, content, exists }
 *  PUT    /api/diary/entry/:date          — сохранить { content } (пустое — удалить файл)
 *  DELETE /api/diary/entry/:date          — удалить запись
 *  GET    /api/diary/template             — { template: string | null }
 *  PUT    /api/diary/template             — сохранить шаблон { template }
 *  POST   /api/diary/week-summary         — итог недели { date, language, labels }; ответ ИИ сохраняется
 *  GET    /api/diary/summary/:date        — сохранённый итог недели этой даты
 *  PUT    /api/diary/summary/:date        — правка итога { markdown } (пустое — удалить)
 *  DELETE /api/diary/summary/:date        — удалить итог
 */
import express from "express";
import * as diary from "../diary";

const router = express.Router();

const bad = (res: express.Response, code = "invalid_date") => res.status(400).json({ error: code });

router.get("/entries", (req, res) => {
  try {
    const items = diary.listEntries(String(req.query.from || ""), String(req.query.to || ""));
    const today = new Date();
    const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    res.json({ items, streak: diary.streak(diary.listEntries().map((i) => i.date), t) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/entry/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json(diary.readEntry(req.params.date));
});

router.put("/entry/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  const content = req.body && req.body.content;
  if (typeof content !== "string") return bad(res, "missing_content");
  res.json(diary.writeEntry(req.params.date, content));
});

router.delete("/entry/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json({ ok: diary.deleteEntry(req.params.date) });
});

router.get("/template", (_req, res) => res.json({ template: diary.getTemplate() }));

router.put("/template", (req, res) => {
  const tpl = req.body && req.body.template;
  if (typeof tpl !== "string") return bad(res, "missing_template");
  res.json({ template: diary.setTemplate(tpl) });
});

router.get("/summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json(diary.getSavedSummary(req.params.date));
});

router.put("/summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  const markdown = req.body && req.body.markdown;
  if (typeof markdown !== "string") return bad(res, "missing_markdown");
  res.json(diary.saveSummary(req.params.date, markdown, { edited: true }));
});

router.delete("/summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json({ ok: diary.deleteSummary(req.params.date) });
});

router.get("/day-summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json(diary.getDaySummary(req.params.date));
});

router.put("/day-summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  const b = req.body || {};
  if (typeof b.markdown !== "string") return bad(res, "missing_markdown");
  res.json(
    diary.saveDaySummary(req.params.date, b.markdown, {
      ai: !!b.ai,
      provider: typeof b.provider === "string" ? b.provider : undefined,
      model: typeof b.model === "string" ? b.model : undefined,
    }),
  );
});

router.delete("/day-summary/:date", (req, res) => {
  if (!diary.isValidDate(req.params.date)) return bad(res);
  res.json({ ok: diary.deleteDaySummary(req.params.date) });
});

router.post("/week-summary", async (req, res) => {
  try {
    const b = req.body || {};
    if (!diary.isValidDate(b.date)) return bad(res);
    const l = b.labels || {};
    const labels: diary.DigestLabels = {
      title: String(l.title || "Week"),
      entries: String(l.entries || "Entries"),
      tasksDone: String(l.tasksDone || "Tasks done"),
      tasksCreated: String(l.tasksCreated || "Tasks added"),
      notes: String(l.notes || "Notes edited"),
      lectures: String(l.lectures || "Lectures"),
      nothing: String(l.nothing || "Nothing recorded this week."),
    };
    res.json(await diary.weekSummary(b.date, String(b.language || "Russian"), labels));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
