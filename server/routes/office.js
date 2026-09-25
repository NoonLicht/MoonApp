"use strict";

/**
 * Конвертация Word/PowerPoint/Excel ⇄ PDF через LibreOffice headless
 * (server/ts/officeConvert.ts).
 *
 *  GET  /api/office/status         — { found, path, version }
 *  POST /api/office/convert        — multipart file + to=pdf|docx|... → файл
 */

const express = require("express");
const multer = require("multer");
const officeConvert = require("../officeConvert");

const router = express.Router();
const MAX_BYTES = 200 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

router.get("/status", async (_req, res) => {
  try {
    res.json(await officeConvert.detectOffice());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/convert", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const to = String((req.body && req.body.to) || "").trim();
    if (!to) return res.status(400).json({ error: "missing_target" });
    const { buf, name } = await officeConvert.convertOffice(req.file.buffer, req.file.originalname, to);
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);
    res.send(buf);
  } catch (e) {
    const status = e.message === "office_engine_missing" ? 404 : e.message.startsWith("unsupported_target") ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;
