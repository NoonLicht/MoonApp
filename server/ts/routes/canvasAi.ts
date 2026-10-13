/**
 * Холст, который понимает содержимое (логика — в canvasAi.ts).
 *
 *  POST /api/canvas-ai/analyze — { objs: [{id,type,text,name,preview,path,src,link}] }
 *                                → { links, groups, missing, seen }
 */
import express from "express";
import fs from "fs";
import path from "path";
import config from "../config";
import { stmts } from "../db";
import * as vaultAssets from "../vaultAssets";
import * as ocr from "../ocr";
import * as cai from "../canvasAi";
import { askModel } from "../llmOnce";

const router = express.Router();

const MAX_OBJS = 300;
const MAX_IMAGES = 4;

function noteText(rel: string): string {
  const root = path.resolve(config.DIRS.vaultNotes);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(full, "utf8").slice(0, 700);
  } catch {
    return "";
  }
}

function lectureText(id: number): string {
  try {
    const rows = stmts.chunkFor.all(id) as unknown as { text: string }[];
    return rows
      .map((r) => r.text)
      .join(" ")
      .slice(0, 700);
  } catch {
    return "";
  }
}

router.post("/analyze", async (req, res) => {
  try {
    const objs = (Array.isArray(req.body?.objs) ? req.body.objs : []).slice(0, MAX_OBJS) as cai.BoardObj[];
    const extra: { image: Record<string, string>; linked: Record<string, string> } = { image: {}, linked: {} };
    let images = 0;
    for (const o of objs) {
      if (o.type === "note" && o.path) {
        const t = noteText(String(o.path));
        if (t) extra.linked[o.id] = t;
      } else if (o.type === "link" && o.link?.kind === "lecture") {
        const t = lectureText(Number(o.link.ref));
        if (t) extra.linked[o.id] = t;
      } else if (o.type === "image" && o.src && images < MAX_IMAGES) {
        const m = /\/assets\/([0-9a-f]{20})/.exec(String(o.src));
        const found = m ? vaultAssets.findAsset(m[1]) : null;
        if (found) {
          images++;
          try {
            const r = await ocr.recognize(fs.readFileSync(found.path));
            if (r.text.trim()) extra.image[o.id] = r.text.replace(/\s+/g, " ").trim().slice(0, 300);
          } catch {
            /* картинка без текста — просто пропускаем */
          }
        }
      }
    }
    const items = cai.describe(objs, extra);
    if (items.length < 2) return res.json({ links: [], groups: [], missing: [], seen: items.length });
    const raw = await askModel(
      "Ты помогаешь структурировать доску идей. Отвечаешь строго JSON.",
      cai.buildPrompt(items),
      { appPage: req.appPage, maxTokens: 1200, temperature: 0.3, feature: "notes.canvas" },
    );
    res.json({ ...cai.parseSuggestions(raw, items.map((i) => i.id)), seen: items.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
