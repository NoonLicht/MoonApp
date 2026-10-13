/**
 * Перетаскивание из приложения в другие программы (Telegram, проводник…).
 *
 *  GET  /api/dragout/note?path=    — абсолютный путь файла заметки
 *  GET  /api/dragout/screenshot/:id — абсолютный путь скриншота/записи из библиотеки
 *  POST /api/dragout/stash?name=   — тело файла → временный файл, ответ {path}
 *
 * Системный drag в Electron принимает только настоящий файл на диске, поэтому всё, чего на
 * диске нет (картинка из письма, блоб из страницы), сначала кладётся во временную папку.
 */
import crypto from "crypto";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import config from "../config";
import * as screenshots from "../screenshots";

const router = express.Router();
const TMP = path.join(os.tmpdir(), "moonapp-dragout");
const MAX_AGE_MS = 6 * 3600 * 1000;

function sweep(): void {
  try {
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (Date.now() - fs.statSync(p).mtimeMs > MAX_AGE_MS)
        fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* папки ещё нет */
  }
}

/** Имя файла без путей и запрещённых в Windows символов. */
function safeName(raw: string): string {
  const n = path
    .basename(String(raw || "file"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return n || "file";
}

router.get("/note", (req, res) => {
  const rel = String(req.query.path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const base = path.resolve(config.DIRS.vaultNotes);
  const full = path.resolve(base, rel);
  if (
    !rel ||
    !full.startsWith(base + path.sep) ||
    !fs.existsSync(full) ||
    !fs.statSync(full).isFile()
  )
    return res.status(404).json({ error: "not_found" });
  res.json({ path: full });
});

router.get("/screenshot/:id", (req, res) => {
  const item = screenshots.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  const p = screenshots.filePath(item);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "file_missing" });
  res.json({ path: p });
});

router.post("/stash", express.raw({ type: "*/*", limit: "200mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: "empty" });
  sweep();
  const dir = path.join(TMP, crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(String(req.query.name || "file")));
  fs.writeFileSync(file, req.body);
  res.json({ path: file });
});

export = router;
