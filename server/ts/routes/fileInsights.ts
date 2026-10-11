/**
 * Анализ файлов: дубликаты, забытые крупные файлы, похожие изображения.
 *
 *  POST /api/fileinsights/start      — { kind, roots[], minSize?, olderThanDays? } → { id }
 *  GET  /api/fileinsights/status/:id — состояние и результат
 *  POST /api/fileinsights/cancel/:id
 *  POST /api/fileinsights/similar    — { items: [{ path, hash }], maxDistance? } → { groups }
 *  GET  /api/fileinsights/image      — ?path= отдать картинку (только изображения) для dHash в UI
 */
import express from "express";
import fs from "fs";
import path from "path";
import * as fi from "../fileInsights";

const router = express.Router();
const KINDS: fi.InsightKind[] = ["duplicates", "forgotten", "images"];

router.post("/start", (req, res) => {
  const body = req.body ?? {};
  const kind = String(body.kind) as fi.InsightKind;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: "bad_kind" });
  const roots: string[] = (Array.isArray(body.roots) ? body.roots : [])
    .map((r: unknown) => String(r))
    .filter((r: string) => path.isAbsolute(r) && fs.existsSync(r));
  if (!roots.length) return res.status(400).json({ error: "missing_roots" });
  const num = (v: unknown): number | undefined =>
    Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
  const id = fi.startInsight(kind, roots, {
    minSize: num(body.minSize),
    olderThanDays: num(body.olderThanDays),
  });
  res.status(201).json({ id });
});

router.get("/status/:id", (req, res) => {
  const j = fi.getInsight(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  res.json(j);
});

router.post("/cancel/:id", (req, res) => {
  res.json({ ok: fi.cancelInsight(req.params.id) });
});

router.post("/similar", (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = raw
    .slice(0, 5000)
    .map((i: { path?: unknown; hash?: unknown }) => ({ path: String(i.path), hash: String(i.hash) }));
  const d = Number(req.body?.maxDistance);
  res.json({ groups: fi.groupSimilar(items, Number.isFinite(d) ? Math.min(20, Math.max(0, d)) : 6) });
});

router.get("/image", (req, res) => {
  const p = String(req.query.path ?? "");
  if (!path.isAbsolute(p) || !fi.isImage(p)) return res.status(400).json({ error: "bad_path" });
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not_found" });
  res.sendFile(p);
});

export = router;
