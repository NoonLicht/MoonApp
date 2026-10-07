/**
 * API страницы «Переводчик» (TranslateGemma 4B, локально, без лимитов на объём).
 *
 *  GET    /api/translate/status          — рантайм, провайдеры, модель, загрузка
 *  POST   /api/translate/model           — {variant} начать загрузку модели
 *  DELETE /api/translate/model/:variant  — удалить вариант; POST /model/cancel — отмена
 *  POST   /api/translate/unload          — выгрузить модель из памяти
 *  POST   /api/translate/text            — {text, src, tgt, provider, variant}
 *  POST   /api/translate/file | /image   — multipart (file + src, tgt, provider, variant)
 *  GET    /api/translate/jobs/:id        — состояние (partial, blocks, прогресс)
 *  GET    /api/translate/jobs/:id/download — результат-файл; POST /jobs/:id/cancel; DELETE
 */
import express from "express";
import multer from "multer";
import path from "path";
import config from "../config";
import { packStatus, runtimeStatus, supportedBackends } from "../upscale/runtime";
import { failedList, loadedInfo, unload } from "../translate/engine";
import { LANGUAGES, TESS_LANG } from "../translate/languages";
import {
  cancelDownload,
  downloadState,
  installedVariants,
  isVariant,
  removeVariant,
  startDownload,
} from "../translate/model";
import {
  FILE_EXT,
  cancelJob,
  deleteJob,
  getJob,
  jobOutput,
  normProvider,
  normVariant,
  startFile,
  startImage,
  startText,
} from "../translate/jobs";
import type { Req } from "../translate/jobs";

const { DIRS } = config;
const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.translateTmp,
    filename: (_req, file, cb) =>
      cb(
        null,
        `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`,
      ),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

// multer кодирует имя в latin1: возвращаем исходную UTF-8 запись (кириллица в имени).
const origName = (f: Express.Multer.File): string =>
  Buffer.from(f.originalname, "latin1").toString("utf8");

const baseReq = (b: Record<string, unknown>): Req => ({
  src: String(b.src || "auto"),
  tgt: String(b.tgt || "en"),
  provider: normProvider(b.provider),
  variant: normVariant(b.variant),
});

router.get("/status", (_req, res) => {
  const rt = runtimeStatus();
  res.json({
    runtime: { available: rt.available, version: rt.version, error: rt.error },
    backends: supportedBackends(),
    pack: packStatus().installed,
    // Пак поставлен, но процесс работает на прежнем рантайме (CUDA/TensorRT появятся после перезапуска).
    restart: packStatus().installed && runtimeStatus().pack !== packStatus().binding,
    platform: process.platform,
    installed: installedVariants(),
    download: downloadState(),
    loaded: loadedInfo(),
    failed: failedList(),
    languages: Object.keys(LANGUAGES),
    ocrLanguages: Object.keys(TESS_LANG),
    fileExt: FILE_EXT,
  });
});

router.post("/model", (req, res) => {
  const v = String(req.body?.variant || "");
  if (!isVariant(v)) return res.status(400).json({ error: "bad_variant" });
  res.json(startDownload(v));
});
router.post("/model/cancel", (_req, res) => {
  cancelDownload();
  res.json({ ok: true });
});
router.delete("/model/:variant", (req, res) => {
  const v = req.params.variant;
  if (!isVariant(v)) return res.status(400).json({ error: "bad_variant" });
  unload();
  removeVariant(v);
  res.json({ ok: true });
});
router.post("/unload", (_req, res) => {
  unload();
  res.json({ ok: true });
});

router.post("/text", (req, res) => {
  const text = String(req.body?.text ?? "");
  if (!text.trim()) return res.status(400).json({ error: "empty_text" });
  try {
    res.json(startText(text, baseReq(req.body)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/file", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  try {
    res.json(startFile(req.file.path, origName(req.file), baseReq(req.body)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/image", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  try {
    res.json(startImage(req.file.path, baseReq(req.body)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  res.json(j);
});
router.post("/jobs/:id/cancel", (req, res) => {
  cancelJob(req.params.id);
  res.json({ ok: true });
});
router.delete("/jobs/:id", (req, res) => {
  deleteJob(req.params.id);
  res.json({ ok: true });
});
router.get("/jobs/:id/download", (req, res) => {
  const out = jobOutput(req.params.id);
  if (!out) return res.status(404).json({ error: "not_found" });
  res.download(out.path, out.name);
});

export = router;
