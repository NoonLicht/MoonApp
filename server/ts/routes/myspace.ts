import express from "express";
import multer from "multer";
import * as vault from "../myspace-vault";
// ИИ-оформление заметок: провайдер чата + sidecar с «сырым» текстом
// (server/ts/notesAi.ts → server/notesAi.js, см. npm run compile:server).
import * as notesAi from "../notesAi";
import logger from "../logger";
import * as vaultAssets from "../vaultAssets";

const router = express.Router();

// Картинки, вставленные в заметку (кнопка "Вложить" в тулбаре: файл/буфер
// обмена). Храним в памяти — файлы маленькие (превью-картинки), пишем сами.
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/myspace/assets — multipart "file" → { id, url }
router.post("/assets", assetUpload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const { id } = vaultAssets.saveAsset(
      req.file.buffer,
      req.file.originalname || "",
      req.file.mimetype,
    );
    res.json({ id, url: `/api/myspace/assets/${id}` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/myspace/assets/:id — отдаёт сохранённую картинку. Токен для <img src>
// добавляется Electron'ом через session.webRequest.onBeforeSendHeaders на все
// запросы к 127.0.0.1:<port> (см. electron/main.js), поэтому спецаллоулист не нужен.
router.get("/assets/:id", (req, res) => {
  const found = vaultAssets.findAsset(String(req.params.id || ""));
  if (!found) return res.status(404).end();
  res.setHeader("Content-Type", found.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(found.path);
});

// GET /api/myspace/tree — file tree
router.get("/tree", (req, res) => {
  try {
    res.json(vault.buildTree());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/myspace/file?path=... — read file
router.get("/file", (req, res) => {
  try {
    const f = vault.readFile(req.query.path as string);
    if (!f) return res.status(404).json({ error: "not found" });
    const outline = vault.getOutline(f.content);
    const backlinks = vault.getBacklinks(req.query.path as string);
    res.json({ ...f, outline, backlinks });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/myspace/file — create or update file
router.post("/file", (req, res) => {
  try {
    const { path: filePath, content, frontmatter } = req.body || {};
    if (!filePath) return res.status(400).json({ error: "path required" });
    const result = vault.writeFile(filePath, content || "", frontmatter || {});
    logger.action("myspace.write", { path: filePath });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/myspace/file?path=...
router.delete("/file", (req, res) => {
  try {
    const result = vault.deleteFile(req.query.path as string);
    if (!result.ok) return res.status(404).json(result);
    // Заметки нет — её sidecar-исходник (.ai/<имя>.txt) тоже больше не нужен,
    // иначе он остаётся мусором на диске и может быть подхвачен одноимённой
    // новой заметкой.
    notesAi.removeSource(req.query.path);
    logger.action("myspace.delete", { path: req.query.path });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/myspace/rename
router.put("/rename", (req, res) => {
  try {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath)
      return res.status(400).json({ error: "oldPath and newPath required" });
    const result = vault.renameFile(oldPath, newPath);
    // Исходник переезжает вместе с заметкой: «Регенерировать» должно работать и
    // после переименования.
    if (result && result.ok) notesAi.moveSource(oldPath, newPath);
    logger.action("myspace.rename", { oldPath, newPath });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/myspace/folder
router.post("/folder", (req, res) => {
  try {
    const { path: folderPath } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: "path required" });
    res.json(vault.createFolder(folderPath));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/myspace/search?q=...
router.get("/search", (req, res) => {
  try {
    res.json(vault.searchFiles(req.query.q));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/myspace/tags
router.get("/tags", (req, res) => {
  try {
    res.json(vault.getAllTags());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Holst / Canvas ====================

// GET /api/myspace/holsts — list all .holst files
router.get("/holsts", (req, res) => {
  try {
    res.json(vault.listHolsts());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/myspace/holst?name=... — read a .holst file
router.get("/holst", (req, res) => {
  try {
    const result = vault.readHolst(req.query.name as string);
    if (!result) return res.status(404).json({ error: "not found" });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/myspace/holst — write a .holst file
router.post("/holst", (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const result = vault.writeHolst(name, data || {});
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/myspace/holst?name=...
router.delete("/holst", (req, res) => {
  try {
    const result = vault.deleteHolst(req.query.name as string);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ИИ-оформление заметок ====================
//
// POST /api/myspace/ai/format     { path }  — оформить текущий текст заметки
// POST /api/myspace/ai/regenerate { path }  — заново из сохранённого исходника
//
// Логика в server/notesAi.js: «оформить» сохраняет «сырой» текст в
// storage/vault/notes/.ai/<имя>.txt и возвращает аккуратную версию, а
// «регенерировать» собирает её заново из этого исходника и ПОЛНОСТЬЮ заменяет
// текст заметки. Обе кнопки пишут файл здесь, а не в модуле: у заметки должен
// сохраниться её frontmatter и одна точка логирования.

/** Коды notes_ai_* — это подсказки пользователю (нет ключа/модели, нет исходника). */
function aiStatus(message: any) {
  return /notes_ai_(not_configured|provider_unknown|model_missing|no_source|empty_note|too_long|short_output)/.test(
    String(message || ""),
  )
    ? 400
    : 500;
}

async function runAiFormat(req: any, res: any, mode: any) {
  const filePath = (req.body || {}).path;
  if (!filePath) return res.status(400).json({ error: "path required" });
  const file = vault.readFile(filePath);
  if (!file) return res.status(404).json({ error: "not found" });
  try {
    const out = await notesAi.formatNote({
      path: filePath,
      content: file.content,
      title: String(file.name || "").replace(/\.md$/, ""),
      mode,
      appPage: req.appPage,
    });
    // Пишем результат тем же способом, что и обычное сохранение (POST /file):
    // frontmatter заметки остаётся нетронутым.
    vault.writeFile(filePath, out.content, file.frontmatter || {});
    logger.action("myspace.ai." + mode, {
      path: filePath,
      provider: out.provider,
      model: out.model,
      chars: out.chars,
    });
    res.json(out);
  } catch (e: any) {
    res.status(aiStatus(e.message)).json({ error: e.message });
  }
}

router.post("/ai/format", (req, res) => runAiFormat(req, res, "format"));
router.post("/ai/regenerate", (req, res) => runAiFormat(req, res, "regenerate"));

// GET /api/myspace/ai/config   — выбранные провайдер/модель + список провайдеров
// POST /api/myspace/ai/config  { providerId, model } — сохранить выбор (settings)
// GET /api/myspace/ai/models?provider=id — живой список моделей провайдера
//
// Зачем: провайдер и модель для оформления заметок берутся из настроек чата, и
// опечатка в имени модели (например «depseek-flash») всплывала сырым JSON от
// сервиса. Теперь выбор делается списком в самой странице заметок и сохраняется
// в myspace.ai.provider/model, поэтому повторять его каждый раз не нужно.

router.get("/ai/config", (req, res) => {
  try {
    res.json(notesAi.aiConfig());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/ai/config", (req, res) => {
  try {
    res.json(notesAi.setAiConfig(req.body || {}));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/ai/models", async (req, res) => {
  try {
    res.json(await notesAi.providerModels(String(req.query.provider || ""), req.appPage));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export = router;
