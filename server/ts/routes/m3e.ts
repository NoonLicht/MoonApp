/**
 * API «M3E Canvas» (набор страниц-проектов в Моём пространстве).
 *
 *  GET    /api/m3e                    — { activeId, pages[], trash[] }
 *  PATCH  /api/m3e                    — { activeId?, order?, pages? } порядок, активная, закрепление, цвет
 *  POST   /api/m3e/pages              — новая страница; тело — текст документа (пусто = чистая), ?after=<id>
 *  GET    /api/m3e/pages/:id          — документ страницы (текст JSON)
 *  PUT    /api/m3e/pages/:id          — сохранить документ (тело — текст JSON)
 *  POST   /api/m3e/pages/:id/duplicate — копия { title }
 *  DELETE /api/m3e/pages/:id          — в корзину
 *  POST   /api/m3e/trash/:id/restore  — вернуть из корзины
 *  DELETE /api/m3e/trash/:id          — удалить насовсем
 *
 * Документ идёт как text/plain: общий JSON-парсер приложения ограничен 2 МБ, а на страницах бывают картинки.
 */
import express from "express";
import * as m3e from "../m3e";

const router = express.Router();
const body = express.text({ type: () => true, limit: "42mb" });

const bad = (res: express.Response, code: number, error: string) =>
  res.status(code).json({ error });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

router.get("/", (_req, res) => {
  try {
    res.json(m3e.list());
  } catch (e) {
    bad(res, 500, message(e));
  }
});

router.patch("/", (req, res) => {
  try {
    res.json(m3e.patch((req.body || {}) as m3e.Patch));
  } catch (e) {
    bad(res, 500, message(e));
  }
});

router.post("/pages", body, (req, res) => {
  try {
    const after =
      typeof req.query.after === "string" && m3e.isId(req.query.after)
        ? req.query.after
        : undefined;
    const text = typeof req.body === "string" ? req.body : "";
    if (text) JSON.parse(text);
    res.status(201).json(m3e.create(text || null, after));
  } catch (e) {
    bad(res, message(e) === "too_large" ? 413 : 400, message(e));
  }
});

router.get("/pages/:id", (req, res) => {
  const text = m3e.read(req.params.id);
  if (text === null) return bad(res, 404, "not_found");
  res.type("text/plain").send(text);
});

router.put("/pages/:id", body, (req, res) => {
  try {
    const text = typeof req.body === "string" ? req.body : "";
    JSON.parse(text);
    const meta = m3e.write(req.params.id, text);
    if (!meta) return bad(res, 404, "not_found");
    res.json(meta);
  } catch (e) {
    bad(res, 400, message(e));
  }
});

router.post("/pages/:id/duplicate", (req, res) => {
  try {
    const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : "";
    const meta = m3e.duplicate(req.params.id, title);
    if (!meta) return bad(res, 404, "not_found");
    res.status(201).json(meta);
  } catch (e) {
    bad(res, 500, message(e));
  }
});

router.delete("/pages/:id", (req, res) => {
  try {
    const wb = m3e.remove(req.params.id);
    if (!wb) return bad(res, 404, "not_found");
    res.json(wb);
  } catch (e) {
    bad(res, 500, message(e));
  }
});

router.post("/trash/:id/restore", (req, res) => {
  try {
    const wb = m3e.restore(req.params.id);
    if (!wb) return bad(res, 404, "not_found");
    res.json(wb);
  } catch (e) {
    bad(res, 500, message(e));
  }
});

router.delete("/trash/:id", (req, res) => {
  try {
    const wb = m3e.purge(req.params.id);
    if (!wb) return bad(res, 404, "not_found");
    res.json(wb);
  } catch (e) {
    bad(res, 500, message(e));
  }
});

export default router;
