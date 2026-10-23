/**
 * Шумоподавление записи (логика — в audioClean.ts).
 *
 *  POST /api/audio-clean — multipart file + level (light|medium|strong) + normalize → WAV
 */
import express from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import config from "../config";
import { detectFfmpeg } from "../convertEngine";
import { removePath } from "../fsUtil";
import * as ac from "../audioClean";

const router = express.Router();
const MAX_BYTES = 300 * 1024 * 1024;

const upload = multer({ defParamCharset: "utf8",
  storage: multer.diskStorage({
    destination: config.DIRS.tmp,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".bin";
      cb(null, `clean_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

router.post("/", upload.single("file"), async (req, res) => {
  const input = req.file?.path;
  const output = input ? input.replace(/\.[^.]*$/, "") + ".clean.wav" : "";
  const cleanup = () => {
    if (input) removePath(input);
    if (output) removePath(output);
  };
  try {
    if (!req.file || !input) return res.status(400).json({ error: "missing_file" });
    const ff = await detectFfmpeg();
    if (!ff.found || !ff.ffmpeg) {
      cleanup();
      return res.status(503).json({ error: "ffmpeg_not_found" });
    }
    const level = String(req.body?.level ?? "medium") as ac.CleanLevel;
    await ac.cleanAudio(ff.ffmpeg, input, output, {
      level,
      normalize: String(req.body?.normalize) !== "false",
    });
    const name = encodeURIComponent(ac.outputName(req.file.originalname || "audio"));
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${name}`);
    res.sendFile(path.resolve(output), (err) => {
      if (err) res.destroy();
      cleanup();
    });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;
