/**
 * Инструменты заметок и учёбы (логика — в noteTools.ts).
 *
 *  POST /api/note-tools/toc          — { text } → { text } с оглавлением
 *  POST /api/note-tools/parasites    — { text } → слова-паразиты
 *  POST /api/note-tools/glossary     — { text } → термины и определения
 *  POST /api/note-tools/formulas     — { text } → { text, evaluated }
 *  POST /api/note-tools/transclude   — { text } → текст с развёрнутыми ![[…]]
 *  POST /api/note-tools/strip-private— { text } → текст без приватных блоков
 *  GET  /api/note-tools/moc          — ?folder= → Markdown карты содержания
 *  POST /api/note-tools/plan         — { date? } → даты повторений
 *  POST /api/note-tools/sm2          — { card?, quality } → новое состояние карточки
 *  POST /api/note-tools/tags         — { text, path?, have? } → подсказки тегов по смыслу
 *  GET  /api/note-tools/templates    — встроенные шаблоны и заметки из папки «Шаблоны»
 *  POST /api/note-tools/template     — { id|path, title? } → { text } с подстановкой полей
 *  POST /api/note-tools/compare      — { a, b } → общее и различия двух конспектов
 *  POST /api/note-tools/site         — { folder?, title? } → zip со статическим мини-сайтом
 */
import express from "express";
import * as vault from "../myspace-vault";
import * as nt from "../noteTools";
import * as snapshots from "../noteSnapshots";
import * as extras from "../noteExtras";
import * as miniSite from "../miniSite";
import AdmZip from "adm-zip";

const router = express.Router();

const textOf = (req: express.Request): string => String(req.body?.text ?? "").slice(0, 2_000_000);

router.post("/toc", (req, res) => {
  res.json({ text: nt.applyToc(textOf(req), Number(req.body?.maxLevel) || 3) });
});

router.post("/parasites", (req, res) => {
  res.json(nt.findParasites(textOf(req)));
});

router.post("/glossary", (req, res) => {
  res.json({ items: nt.extractGlossary(textOf(req)) });
});

router.post("/formulas", (req, res) => {
  res.json(nt.evaluateTables(textOf(req)));
});

router.post("/strip-private", (req, res) => {
  res.json({ text: nt.stripPrivate(textOf(req)) });
});

/** Плоский список заметок хранилища: название (без .md) → путь. */
function allNotes(): { path: string; title: string }[] {
  const out: { path: string; title: string }[] = [];
  const walk = (items: vault.VaultTreeItem[]): void => {
    for (const it of items) {
      if (it.type === "folder") walk(it.children ?? []);
      else if (it.type === "note") out.push({ path: it.path, title: it.name.replace(/\.md$/i, "") });
    }
  };
  walk(vault.buildTree());
  return out;
}

router.post("/transclude", (req, res) => {
  const notes = allNotes();
  const resolve = (name: string): string | null => {
    const hit = notes.find((n) => n.title.toLowerCase() === name.toLowerCase());
    return hit ? (vault.readFile(hit.path)?.content ?? null) : null;
  };
  res.json({ text: nt.expandTransclusions(textOf(req), resolve) });
});

/** Все заметки с телом — для «долгов» графа и цитатника. */
function allWithContent(): { path: string; title: string; content: string }[] {
  return allNotes().map((n) => ({ ...n, content: vault.readFile(n.path)?.content ?? "" }));
}

router.get("/debts", (_req, res) => {
  res.json({ items: nt.unresolvedLinks(allWithContent()) });
});

router.get("/quotes", (_req, res) => {
  res.json({ items: nt.extractQuotes(allWithContent()).slice(0, 500) });
});

router.post("/slides", (req, res) => {
  res.json({ html: nt.toSlidesHtml(textOf(req), String(req.body?.title ?? "Презентация").slice(0, 120)) });
});

router.get("/snapshots", (req, res) => {
  res.json({ items: snapshots.list(String(req.query.path ?? "")) });
});

router.get("/snapshots/read", (req, res) => {
  const text = snapshots.read(String(req.query.path ?? ""), String(req.query.id ?? ""));
  if (text === null) return res.status(404).json({ error: "not_found" });
  res.json({ text });
});

router.post("/snapshots", (req, res) => {
  const s = snapshots.snapshot(String(req.body?.path ?? ""), textOf(req), "manual");
  if (!s) return res.status(400).json({ error: "bad_path" });
  res.status(201).json(s);
});

router.get("/moc", (req, res) => {
  const folder = String(req.query.folder ?? "").replace(/^\/+|\/+$/g, "");
  const notes = allNotes()
    .filter((n) => !folder || n.path.startsWith(folder + "/"))
    .map((n) => ({
      path: n.path,
      title: n.title,
      tags: vault.readFile(n.path)?.tags ?? [],
    }));
  res.json({ text: nt.buildMoc(notes, folder ? `Карта: ${folder}` : "Карта содержания"), count: notes.length });
});

router.post("/plan", (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date))
    ? String(req.body.date)
    : new Date().toISOString().slice(0, 10);
  res.json({ date, reviews: nt.reviewPlan(date) });
});

router.post("/sm2", (req, res) => {
  const c = req.body?.card ?? {};
  const card = {
    interval: Number(c.interval) || 0,
    repetitions: Number(c.repetitions) || 0,
    ease: Number(c.ease) || 2.5,
  };
  res.json(nt.sm2(card, Number(req.body?.quality)));
});

router.post("/tags", (req, res) => {
  const have = Array.isArray(req.body?.have) ? req.body.have.map(String) : [];
  const notes = allWithContent().map((n) => ({
    path: n.path,
    content: n.content,
    tags: vault.readFile(n.path)?.tags ?? [],
  }));
  res.json({
    items: extras.suggestTags(textOf(req), notes, { have, selfPath: String(req.body?.path ?? "") || undefined }),
  });
});

const TEMPLATE_DIR = "Шаблоны/";

router.get("/templates", (_req, res) => {
  const mine = allNotes()
    .filter((n) => n.path.startsWith(TEMPLATE_DIR))
    .map((n) => ({ id: `note:${n.path}`, title: n.title }));
  res.json({ items: [...extras.BUILTIN_TEMPLATES.map((t) => ({ id: t.id, title: t.title })), ...mine] });
});

router.post("/template", (req, res) => {
  const id = String(req.body?.id ?? "");
  let body: string | null = null;
  if (id.startsWith("note:")) {
    const p = id.slice(5);
    if (p.startsWith(TEMPLATE_DIR)) body = vault.readFile(p)?.content ?? null;
  } else {
    body = extras.BUILTIN_TEMPLATES.find((t) => t.id === id)?.body ?? null;
  }
  if (body === null) return res.status(404).json({ error: "template_not_found" });
  res.json({ text: extras.renderTemplate(body, { title: String(req.body?.title ?? "").slice(0, 200) }) });
});

router.post("/compare", (req, res) => {
  const cut = (v: unknown): string => String(v ?? "").slice(0, 500_000);
  res.json(extras.compareNotes(cut(req.body?.a), cut(req.body?.b)));
});

router.post("/site", (req, res) => {
  const folder = String(req.body?.folder ?? "").replace(/^\/+|\/+$/g, "");
  const notes = allNotes()
    .filter((n) => !folder || n.path.startsWith(folder + "/"))
    .slice(0, 500)
    .map((n) => ({ ...n, content: vault.readFile(n.path)?.content ?? "" }));
  if (!notes.length) return res.status(404).json({ error: "no_notes" });
  const title = String(req.body?.title ?? "").trim().slice(0, 120) || folder.split("/").pop() || "Заметки";
  const zip = new AdmZip();
  for (const [name, html] of Object.entries(miniSite.buildSite(notes, title))) {
    zip.addFile(name, Buffer.from(html, "utf8"));
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="mini-site.zip"');
  res.send(zip.toBuffer());
});

export = router;
