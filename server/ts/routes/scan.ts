/**
 * Фото → задачи и сканер документов (логика — в photoTasks.ts, photoChecklist.ts).
 *
 *  POST /api/scan/photo-tasks     — multipart "file" (+ createTasks=0) → заметка, чек-лист, задачи
 *  POST /api/scan/pdf             — multipart "files"[] (+ title, text=0) → PDF в storage/scans
 *  GET  /api/scan/list            — готовые сканы
 *  GET  /api/scan/file/:name      — скачать PDF
 */
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import * as pt from "../photoTasks";

const router = express.Router();
const upload = multer({ defParamCharset: "utf8", storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

router.post("/photo-tasks", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file_required" });
    const r = await pt.photoToTasks(req.file.buffer, {
      name: req.file.originalname,
      mime: req.file.mimetype,
      createTasks: req.body?.createTasks !== "0",
    });
    res.json(r);
  } catch (e) {
    const m = (e as Error).message;
    res.status(m === "unsupported_image" ? 415 : 500).json({ error: m });
  }
});

router.post("/pdf", upload.array("files", 20), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return res.status(400).json({ error: "files_required" });
    const r = await pt.scanToPdf(
      files.map((f) => ({ data: f.buffer, mime: f.mimetype })),
      { title: String(req.body?.title ?? ""), withText: req.body?.text !== "0" },
    );
    res.json(r);
  } catch (e) {
    const m = (e as Error).message;
    res.status(m === "unsupported_image" ? 415 : 500).json({ error: m });
  }
});

router.get("/list", (_req, res) => res.json({ items: pt.listScans() }));

router.get("/file/:name", (req, res) => {
  const name = path.basename(String(req.params.name));
  const full = path.join(pt.scansDir(), name);
  if (!/\.pdf$/i.test(name) || !fs.existsSync(full)) return res.status(404).json({ error: "not_found" });
  res.download(full, name);
});

export = router;
