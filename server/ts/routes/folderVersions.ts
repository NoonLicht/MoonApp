/**
 * Версии папок (логика — в folderVersions.ts).
 *
 *  GET    /api/folder-versions?folder=       — список версий
 *  POST   /api/folder-versions               — { folder, label? } → снимок
 *  POST   /api/folder-versions/restore       — { folder, id } → { path } рядом с исходной папкой
 *  DELETE /api/folder-versions               — { folder, id }
 */
import express from "express";
import path from "path";
import config from "../config";
import * as fv from "../folderVersions";

const router = express.Router();
const root = (): string => path.join(config.DIRS.storage, "folder-versions");

const folderOf = (v: unknown): string => String(v ?? "").trim();

const status = (msg: string): number =>
  /not_a_folder|bad_id|folder_contains|too_large/.test(msg) ? 400 : /not_found/.test(msg) ? 404 : 500;

router.get("/", (req, res) => {
  const folder = folderOf(req.query.folder);
  if (!folder) return res.status(400).json({ error: "folder_required" });
  res.json({ items: fv.listVersions(root(), folder) });
});

router.post("/", (req, res) => {
  try {
    const folder = folderOf(req.body?.folder);
    if (!folder) return res.status(400).json({ error: "folder_required" });
    res.status(201).json(fv.snapshotFolder(root(), folder, { label: String(req.body?.label ?? "") }));
  } catch (e) {
    const msg = (e as Error).message;
    res.status(status(msg)).json({ error: msg });
  }
});

router.post("/restore", (req, res) => {
  try {
    res.json({ path: fv.restoreVersion(root(), folderOf(req.body?.folder), String(req.body?.id ?? "")) });
  } catch (e) {
    const msg = (e as Error).message;
    res.status(status(msg)).json({ error: msg });
  }
});

router.delete("/", (req, res) => {
  const ok = fv.deleteVersion(root(), folderOf(req.body?.folder), String(req.body?.id ?? ""));
  res.status(ok ? 200 : 404).json({ ok });
});

export = router;
