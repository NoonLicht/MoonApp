import express from "express";
import settings from "../settings";
import logger from "../logger";
import { clearProblems, listProblems, reportProblem, summarize } from "../problemLog";

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: "0.1.0" });
});

// POST /api/log — приём событий с фронта (клики, навигация, ошибки UI).
// Кладём в полный журнал audit.log: он целиком попадает в файл кнопки
// «Собрать логи». Уровень события задаёт фронт (action | info | warn | error).
router.post("/log", (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [body];
  for (const e of events) {
    if (!e || !e.event) continue;
    const level = String(e.level || "action");
    logger.log(level, String(e.event), e.data);
    // Ошибки и предупреждения UI дублируем в журнал проблем (там они склеиваются).
    if (level === "error" || level === "warn") {
      reportProblem({ source: "ui", level, error: String(e.event) });
    }
  }
  res.json({ ok: true });
});

// GET /api/problems — журнал проблем (новые сверху) и текстовая сводка.
router.get("/problems", (req, res) => {
  const items = listProblems();
  res.json({ items, summary: summarize(items) });
});

// DELETE /api/problems — очистить журнал проблем.
router.delete("/problems", (req, res) => {
  clearProblems();
  res.json({ ok: true });
});

// Архивация страниц переехала в routes/archive.js (движок .sitebak).
// Легаси-эндпоинты /api/archives и таблица archived_pages удалены (М9).

// Книги — перенесены в routes/books.js (полноценный каталог по OPDS).
// router.get("/books", ...) больше не здесь — см. /api/books.

export = router;
