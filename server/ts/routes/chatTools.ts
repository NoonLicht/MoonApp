/**
 * Инструменты ответов ИИ-чата (логика — в answerTools.ts).
 *
 *  POST /api/chat-tools/factcheck   — { text } → утверждения и найденные для них заметки
 *  POST /api/chat-tools/save-answer — { question, answer, model?, auto? } → заметка в vault
 *  GET  /api/chat-tools/skills      — навыки: заметки из папки «Навыки» → системные промпты
 *  POST /api/chat-tools/judge       — { question, answer } → оценка ответа моделью-судьёй
 *  POST /api/chat-tools/context     — { kind: file|folder|site, target, question? } → блок контекста
 */
import express from "express";
import config from "../config";
import * as semantic from "../semantic";
import * as vault from "../myspace-vault";
import * as tools from "../answerTools";
import * as skills from "../aiSkills";
import * as plugins from "../plugins";
import * as prov from "../provenance";
import multer from "multer";
import * as ocr from "../ocr";
import * as imageExplain from "../imageExplain";
import { removePath } from "../fsUtil";
import fs from "fs";
import path from "path";
import * as cc from "../chatContext";
import * as fileText from "../fileTextIndex";
import { walkFiles } from "../fileInsights";
import { conspectusTarget } from "../lectureConspectus";
import { runWithPage } from "../middleware/perPageProxy";

const router = express.Router();

router.post("/factcheck", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").slice(0, 20000);
    const claims = tools.splitClaims(text);
    const results = [];
    for (const c of claims) {
      const hits = await semantic.search(c.text, { sources: ["note"], limit: 3 });
      results.push({
        claim: c.text,
        support: tools.supportLevel(hits[0]?.score ?? null),
        hits: hits.map((h) => ({
          ref: h.ref,
          title: h.title,
          snippet: h.snippet,
          score: Math.round(h.score * 100) / 100,
        })),
      });
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/save-answer", (req, res) => {
  try {
    const answer = String(req.body?.answer ?? "");
    if (!answer.trim()) return res.status(400).json({ error: "empty_answer" });
    if (req.body?.auto === true && tools.valueScore(answer) < tools.VALUE_THRESHOLD) {
      return res.json({ saved: false, reason: "low-value" });
    }
    const note = tools.noteFromAnswer(String(req.body?.question ?? ""), answer, {
      model: req.body?.model ? String(req.body.model).slice(0, 80) : undefined,
    });
    const r = vault.writeFile(note.path, note.content, note.frontmatter);
    if (!r.ok) return res.status(500).json({ error: r.error || "write_failed" });
    prov.save(prov.record(prov.load(), note.path, answer, "ai", Date.now()));
    res.json({ saved: true, path: note.path, title: note.title });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/skills", (_req, res) => {
  const out: skills.Skill[] = [];
  const walk = (items: vault.VaultTreeItem[]): void => {
    for (const it of items) {
      if (it.type === "folder") walk(it.children ?? []);
      else if (it.type === "note" && it.path.startsWith(skills.SKILLS_DIR)) {
        const f = vault.readFile(it.path);
        const s = f ? skills.skillFrom(it.path, f.content, f.frontmatter) : null;
        if (s) out.push(s);
      }
    }
  };
  walk(vault.buildTree());
  const dir = path.join(config.DIRS.storage, "plugins");
  for (const s of plugins.collect(plugins.listPlugins(dir)).skills) {
    out.push({ path: `plugin:${s.plugin}`, name: s.name, description: s.description, prompt: s.prompt });
  }
  res.json({ items: out.sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post("/judge", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "");
    const answer = String(req.body?.answer ?? "");
    if (!answer.trim()) return res.status(400).json({ error: "empty_answer" });
    const target = (await conspectusTarget(req.appPage ?? null, "chat.tools")) as unknown as {
      provider: { chat(opts: Record<string, unknown>): Promise<string> };
      secret: string;
      model: string;
    };
    const raw = await runWithPage(req.appPage ?? null, () =>
      target.provider.chat({
        secret: target.secret,
        model: target.model,
        messages: [
          { role: "system", text: "Ты строгий и беспристрастный эксперт-рецензент ответов ИИ." },
          { role: "user", text: skills.judgePrompt(question, answer) },
        ],
        temperature: 0,
        maxTokens: 600,
        stream: true,
      }),
    );
    const verdict = skills.parseVerdict(String(raw || ""));
    if (!verdict) return res.status(502).json({ error: "judge_unparsable" });
    res.json(verdict);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const CTX_MAX_FILES = 30;
const CTX_MAX_CHARS = 60_000;
const SITE_MAX_BYTES = 2 * 1024 * 1024;

/** Загрузка страницы с проверкой адреса на каждом переходе (без обхода в частную сеть). */
async function fetchSite(url: string): Promise<string> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!cc.isPublicUrl(cur)) throw new Error("url_not_allowed");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await fetch(cur, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "MoonApp" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        cur = new URL(String(r.headers.get("location")), cur).toString();
        continue;
      }
      if (!r.ok) throw new Error(`http_${r.status}`);
      if (Number(r.headers.get("content-length") || 0) > SITE_MAX_BYTES) throw new Error("page_too_large");
      const raw = (await r.text()).slice(0, SITE_MAX_BYTES);
      return /html/i.test(r.headers.get("content-type") || "") || /^\s*</.test(raw)
        ? fileText.htmlToText(raw)
        : raw;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too_many_redirects");
}

router.post("/context", async (req, res) => {
  try {
    const kind = String(req.body?.kind ?? "");
    const target = String(req.body?.target ?? "").trim();
    const question = String(req.body?.question ?? "").slice(0, 2000);
    if (!target) return res.status(400).json({ error: "target_required" });
    const docs: cc.SourceDoc[] = [];
    if (kind === "site") {
      docs.push({ title: new URL(target).hostname, text: await fetchSite(target) });
    } else if (kind === "file" || kind === "folder") {
      const files =
        kind === "file"
          ? [target]
          : (await walkFiles([target], { maxFiles: 500 }))
              .map((f) => f.path)
              .filter((p) => fileText.kindOf(p) === "text" || fileText.kindOf(p) === "pdf")
              .slice(0, CTX_MAX_FILES);
      for (const f of files) {
        const k = fileText.kindOf(f);
        if (!k || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
        try {
          docs.push({ title: path.basename(f), text: (await fileText.extract(f, k)).slice(0, CTX_MAX_CHARS) });
        } catch {
          /* нечитаемый файл пропускается */
        }
      }
    } else return res.status(400).json({ error: "bad_kind" });
    const passages = cc.pickPassages(docs, question);
    res.json({ context: cc.buildContext(passages), sources: [...new Set(passages.map((p) => p.title))], files: docs.length });
  } catch (e) {
    const msg = (e as Error).message;
    res.status(/not_allowed|Invalid URL/.test(msg) ? 400 : 500).json({ error: msg });
  }
});

const explainUpload = multer({
  storage: multer.diskStorage({ destination: config.DIRS.tmp }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Объяснение скриншота/слайда или формулы с доски: OCR + текстовая модель.
router.post("/explain-image", explainUpload.single("file"), async (req, res) => {
  const cleanup = () => req.file && removePath(req.file.path);
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const mode: imageExplain.ExplainMode = req.body?.mode === "formulas" ? "formulas" : "explain";
    const text = imageExplain.cleanOcr((await ocr.recognize(fs.readFileSync(req.file.path))).text);
    cleanup();
    if (!imageExplain.isUsable(text)) return res.json({ answer: "", ocr: text, formulas: [] });
    const target = (await conspectusTarget(req.appPage ?? null, "chat.tools")) as unknown as {
      provider: { chat(opts: Record<string, unknown>): Promise<string> };
      secret: string;
      model: string;
    };
    const answer = String(
      (await runWithPage(req.appPage ?? null, () =>
        target.provider.chat({
          secret: target.secret,
          model: target.model,
          messages: [
            { role: "system", text: imageExplain.systemPrompt(mode) },
            { role: "user", text: imageExplain.userPrompt(mode, text, String(req.body?.question ?? "")) },
          ],
          temperature: 0.2,
          maxTokens: 1500,
          stream: true,
        }),
      )) || "",
    ).trim();
    res.json({ answer, ocr: text, formulas: mode === "formulas" ? imageExplain.extractLatex(answer) : [] });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
