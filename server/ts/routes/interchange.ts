/**
 * Обмен заметками с Obsidian, Notion и Anki.
 *
 *  POST /api/interchange/import         — multipart: file (.zip), source=obsidian|notion, folder?
 *  GET  /api/interchange/export         — ?flavor=obsidian|notion → .zip со всеми заметками
 *  GET  /api/interchange/anki           — ?type=basic|cloze → .tsv для импорта в Anki
 *
 * Конвертация текста — в noteInterchange.ts; здесь только файлы и vault.
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import config from "../config";
import { removePath } from "../fsUtil";
import * as vault from "../myspace-vault";
import * as ni from "../noteInterchange";

const router = express.Router();
const { DIRS } = config;

const MAX_ZIP = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

const upload = multer({ defParamCharset: "utf8",
  storage: multer.diskStorage({ destination: DIRS.tmp }),
  limits: { fileSize: MAX_ZIP },
});

function* walkNotes(dir: string, base = ""): Generator<{ rel: string; full: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walkNotes(full, rel);
    else if (/\.md$/i.test(e.name)) yield { rel, full };
  }
}

function allNotes(): { path: string; content: string }[] {
  return [...walkNotes(vault.NOTEBOOK_DIR)].map((n) => ({
    path: n.rel,
    content: fs.readFileSync(n.full, "utf8"),
  }));
}

router.post("/import", upload.single("file"), (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const source = String(req.body?.source) === "notion" ? "notion" : "obsidian";
    const folder = String(req.body?.folder ?? "").trim();
    const zip = new AdmZip(req.file.path);
    const all = zip.getEntries();
    if (all.length > MAX_ENTRIES) {
      cleanup();
      return res.status(413).json({ error: "too_many_entries" });
    }
    const entries: ni.ImportEntry[] = [];
    let tooBig = 0;
    for (const e of all) {
      if (e.isDirectory) continue;
      if (e.header.size > MAX_ENTRY_BYTES) {
        tooBig++;
        continue;
      }
      entries.push({ name: e.entryName, content: e.getData() });
    }
    const plan = ni.planImport(entries, source, folder);
    let written = 0;
    let renamed = 0;
    for (const n of plan.notes) {
      let target = n.path;
      // Существующие заметки не перезаписываем — импорт кладёт копию рядом.
      for (let i = 1; vault.readFile(target); i++) {
        target = n.path.replace(/(\.md)?$/i, i === 1 ? " (импорт)$1" : ` (импорт ${i})$1`);
      }
      if (target !== n.path) renamed++;
      if (vault.writeFile(target, n.content).ok) written++;
    }
    cleanup();
    res.json({
      imported: written,
      renamed,
      skipped: plan.skipped.length + tooBig,
      skippedAttachments: plan.skipped.filter((s) => s.reason === "not-markdown").length,
    });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/export", (req, res) => {
  try {
    const flavor = String(req.query.flavor) === "notion" ? "notion" : "obsidian";
    const zip = new AdmZip();
    let n = 0;
    for (const note of allNotes()) {
      const text = flavor === "notion" ? ni.wikiLinksToMarkdown(note.content) : note.content;
      zip.addFile(note.path, Buffer.from(text, "utf8"));
      n++;
    }
    if (!n) return res.status(404).json({ error: "no_notes" });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="moonapp-notes-${flavor}.zip"`);
    res.send(zip.toBuffer());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/anki", (req, res) => {
  try {
    const type = String(req.query.type) === "cloze" ? "cloze" : "basic";
    const { tsv, count } = ni.ankiTsv(allNotes(), type);
    if (!count) return res.status(404).json({ error: "no_cards" });
    res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="moonapp-anki-${type}.tsv"`);
    res.setHeader("X-Card-Count", String(count));
    res.send(tsv);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
