/**
 * Voice Vault (логика — в voiceVault.ts).
 *
 *  GET /api/voice-vault/search?q=&limit= — отрезки голосовых записей по смыслу запроса
 *
 * Аудио отдаётся существующими маршрутами: /api/lecture/chunks/:id/audio и
 * /api/quicknotes/:id/audio.
 */
import express from "express";
import fs from "fs";
import config from "../config";
import { stmts } from "../db";
import * as semantic from "../semantic";
import * as vv from "../voiceVault";

const router = express.Router();

function quickAudio(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const raw = JSON.parse(fs.readFileSync(config.FILES.quickNotesIndex, "utf8"));
    for (const q of Array.isArray(raw) ? raw : []) out.set(String(q.id), !!q.audioFile);
  } catch {
    /* быстрых заметок нет */
  }
  return out;
}

router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ items: [] });
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 40);
    const hits = await semantic.search(q, { sources: ["lecture", "quick"], limit });
    const quick = quickAudio();
    const items: vv.VaultHit[] = [];
    for (const h of hits) {
      if (h.source === "lecture") {
        const id = Number(h.ref);
        if (!stmts.lectureGet.get(id)) continue;
        const chunks = stmts.chunkFor.all(id) as unknown as vv.VaultChunk[];
        const seg = vv.segmentFor(chunks, Number(h.at) || 0);
        if (!seg) continue;
        items.push({
          kind: "lecture",
          ref: h.ref,
          title: h.title,
          snippet: vv.excerpt(seg.text, q),
          score: h.score,
          startMs: seg.startMs,
          endMs: seg.endMs,
          chunkIds: seg.chunkIds,
          audioUrl: null,
        });
      } else if (h.source === "quick") {
        items.push({
          kind: "quick",
          ref: h.ref,
          title: h.title,
          snippet: vv.excerpt(h.snippet, q),
          score: h.score,
          startMs: 0,
          endMs: 0,
          chunkIds: [],
          audioUrl: quick.get(h.ref) ? `/api/quicknotes/${encodeURIComponent(h.ref)}/audio` : null,
        });
      }
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
