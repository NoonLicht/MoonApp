/**
 * «Сшивка по смыслу» (логика — в montage.ts).
 *
 *  POST /api/montage        — { query, maxSeconds?, order? } → { id, clips, captions, seconds }
 *  GET  /api/montage/:id    — готовый mp3
 */
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import config from "../config";
import { stmts } from "../db";
import { detectFfmpeg } from "../convertEngine";
import * as semantic from "../semantic";
import * as lecture from "../lecture";
import * as vv from "../voiceVault";
import * as mt from "../montage";

const router = express.Router();
const dir = (): string => {
  const d = path.join(config.DIRS.storage, "montage");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

router.post("/", async (req, res) => {
  try {
    const query = String(req.body?.query ?? "").trim();
    if (query.length < 2) return res.status(400).json({ error: "empty_query" });
    const ff = await detectFfmpeg();
    if (!ff.found || !ff.ffmpeg) return res.status(503).json({ error: "ffmpeg_not_found" });

    const hits = await semantic.search(query, { sources: ["lecture"], limit: 30 });
    const clips: mt.Clip[] = [];
    for (const h of hits) {
      const id = Number(h.ref);
      if (!stmts.lectureGet.get(id)) continue;
      const chunks = stmts.chunkFor.all(id) as unknown as vv.VaultChunk[];
      const seg = vv.segmentFor(chunks, Number(h.at) || 0, 600);
      if (!seg) continue;
      const files = seg.chunkIds
        .map((cid) => lecture.chunkAudioPath(cid))
        .filter((p): p is string => !!p && fs.existsSync(p));
      if (!files.length) continue;
      clips.push({
        title: h.title,
        ref: h.ref,
        startMs: seg.startMs,
        endMs: seg.endMs,
        chunkIds: seg.chunkIds,
        snippet: vv.excerpt(seg.text, query, 160),
        score: h.score,
        files,
      });
    }
    const maxSeconds = Math.min(Math.max(Number(req.body?.maxSeconds) || 600, 30), 3600);
    const plan = mt.planMontage(clips, {
      maxSeconds,
      order: req.body?.order === "chronological" ? "chronological" : "relevance",
    });
    if (!plan.length) return res.json({ id: null, clips: [], captions: [], seconds: 0 });

    const id = crypto.randomBytes(6).toString("hex");
    const out = path.join(dir(), `${id}.mp3`);
    const inputs = plan.flatMap((c) => c.files ?? []);
    await new Promise<void>((resolve, reject) => {
      execFile(
        ff.ffmpeg as string,
        mt.ffmpegArgs(inputs, out),
        { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, _o, stderr) => (err ? reject(new Error(String(stderr).split(/\r?\n/).filter(Boolean).slice(-3).join(" "))) : resolve()),
      );
    });
    res.json({
      id,
      clips: plan.map(({ files: _f, ...c }) => c),
      captions: mt.captions(plan),
      seconds: mt.totalSeconds(plan),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/:id", (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: "bad_id" });
  const f = path.join(dir(), `${id}.mp3`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: "not_found" });
  res.sendFile(f);
});

export = router;
