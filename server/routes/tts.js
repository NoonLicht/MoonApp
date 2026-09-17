"use strict";

/**
 * API аудиокнижной TTS-студии (F5-TTS + Coqui XTTS v2).
 *
 *  GET    /api/tts/hardware        — GPU/VRAM (nvidia-smi) + «Optimal for Your PC»
 *  GET    /api/tts/env             — Python-окружение: интерпретатор + модули
 *                                    (torch/torchaudio/f5_tts/TTS) + прогресс установки
 *  GET    /api/tts/env/install     — план установки: CUDA/CPU torch, объём, команды
 *  GET    /api/tts/env/interpreters— найденные интерпретаторы Python с модулями
 *  POST   /api/tts/env/install     — { engine, device } → pip-установка с прогрессом
 *  POST   /api/tts/env/cancel      — отменить установку окружения
 *  POST   /api/tts/env/python      — { cmd } → сохранить интерпретатор (voice.pythonCmd)
 *  GET    /api/tts/presets         — системные + пользовательские пресеты
 *  POST   /api/tts/presets         — сохранить пользовательский пресет
 *  DELETE /api/tts/presets/:id     — удалить пользовательский пресет
 *  GET    /api/tts/profiles        — профили голоса
 *  POST   /api/tts/profiles        — сохранить профиль
 *  DELETE /api/tts/profiles/:id    — удалить профиль
 *  POST   /api/tts/reference       — загрузка референса (→ ref_* в storage/tts)
 *  POST   /api/tts/import-book     — .epub/.fb2/.pdf/.mobi/.rtf/.txt → главы
 *  POST   /api/tts/preview-chunks  — NLP-предпросмотр чанков (Batch Editor)
 *  POST   /api/tts                 — запуск задания { refFile, engine, chunks[], ... }
 *  GET    /api/tts/:id             — статус (stage/progress/chunkIndex/vram)
 *  GET    /api/tts/:id/download    — готовый mp3/wav/m4b
 *  POST   /api/tts/reveal          — показать файл в проводнике
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const engine = require("../tts");
const pyEnv = require("../pyEnv");
const settings = require("../settings");
const { DIRS } = require("../config");
const bookParser = require("../bookParser");
const logger = require("../logger");
// Загруженная книга хранится под исходным именем (кириллица), а fs.rmSync такие
// пути на Windows молча не удаляет — temp-файлы копились бы вечно.
const { removePath } = require("../fsUtil");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.tts,
    filename: (req, file, cb) => {
      const base = path.basename(
        String(file.originalname || "file").replace(/[\\/:*?"<>|]+/g, "_"),
      );
      cb(null, `up_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // книга может быть тяжёлой (pdf)
});

/* ------------------------- Железо ------------------------- */

router.get("/hardware", async (req, res) => {
  try {
    res.json(await engine.detectHardware());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Python-окружение движка: какой интерпретатор выбран (voice.pythonCmd), его
 * версия/путь и какие модули (torch/torchaudio/f5_tts/TTS) реально установлены.
 * Страница «Голос» показывает это ДО запуска рендера — иначе первая же попытка
 * заканчивалась «Ошибка рендера: No module named 'torch'».
 * ?force=1 — перепроверить, минуя кэш (кнопка «Проверить снова»).
 * В ответ дополнительно попадает прогресс установки окружения (pyEnv): страница
 * опрашивает этот же эндпоинт, пока идёт pip install.
 */
router.get("/env", async (req, res) => {
  try {
    const env = await engine.pythonEnv(req.query.force === "1" || req.query.force === "true");
    res.json({ ...env, install: pyEnv.installSnapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * План установки окружения: оба варианта torch (CUDA/CPU), объём загрузки,
 * команды pip и рекомендуемое устройство по железу. Отдельный эндпоинт, потому
 * что здесь опрашивается nvidia-smi (в /env он не нужен на каждый поллинг).
 */
router.get("/env/install", async (req, res) => {
  try {
    res.json(await pyEnv.installState(pyEnv.engineOf(req.query.engine), pyEnv.deviceOf(req.query.device)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Все интерпретаторы на машине с их модулями. Заменяет ручной ввод пути python в
 * Настройках: пользователь выбирает найденный вариант, и он сохраняется в
 * voice.pythonCmd (POST /env/python).
 */
router.get("/env/interpreters", async (req, res) => {
  try {
    res.json({ list: await pyEnv.interpreters() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Запуск установки: { engine: "f5"|"xtts", device: "cuda"|"cpu", python? }. */
router.post("/env/install", (req, res) => {
  try {
    const snap = pyEnv.install(
      pyEnv.engineOf(req.body?.engine),
      pyEnv.deviceOf(req.body?.device),
      req.body?.python ? String(req.body.python) : undefined,
    );
    logger.action("tts.env.install", {
      engine: snap.engine,
      device: snap.device,
      python: snap.python,
    });
    res.status(201).json(snap);
  } catch (e) {
    // busy — установка уже идёт; остальные тексты показываются как есть.
    res.status(400).json({ error: e.message });
  }
});

/** Отмена установки окружения (процесс pip убивается вместе с дочерними). */
router.post("/env/cancel", (req, res) => {
  res.json(pyEnv.cancel());
});

/**
 * Выбор интерпретатора: сохраняем путь в voice.pythonCmd, чтобы сайдкар движка и
 * проверка окружения смотрели в одно и то же место. Путь проверяется тем же
 * способом, что и в UI: без него torch в venv «не находится».
 */
router.post("/env/python", (req, res) => {
  try {
    const cmd = String(req.body?.cmd || "").trim();
    if (!cmd) return res.status(400).json({ error: "empty_python" });
    settings.set({ voice: { pythonCmd: cmd.slice(0, 500) } });
    logger.action("tts.env.python", { cmd });
    res.json({ ok: true, cmd });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- Пресеты ------------------------- */

router.get("/presets", (req, res) => res.json(engine.listPresets()));
router.post("/presets", (req, res) => {
  try {
    const p = engine.saveUserPreset(req.body || {});
    logger.action("tts.preset.save", { id: p.id, name: p.name });
    res.status(201).json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete("/presets/:id", (req, res) =>
  res.json({ ok: engine.deleteUserPreset(req.params.id) }),
);

/* ------------------------- Профили ------------------------- */

router.get("/profiles", (req, res) => res.json(engine.loadProfiles()));
router.post("/profiles", (req, res) => {
  try {
    const p = engine.saveProfile({ ...req.body, refFile: req.body?.refFile });
    logger.action("tts.profile.save", { id: p.id, name: p.name });
    res.status(201).json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete("/profiles/:id", (req, res) => res.json({ ok: engine.deleteProfile(req.params.id) }));

/* ------------------------- Референс ------------------------- */

router.post("/reference", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_reference" });
  // Приводим к формату ref_* (его валидируют профиль и задание).
  const ext = path.extname(req.file.originalname || "") || ".wav";
  const refName = `ref_${Date.now()}${ext}`;
  const finalPath = path.join(DIRS.tts, path.basename(refName));
  try {
    fs.renameSync(req.file.path, finalPath);
  } catch {
    fs.copyFileSync(req.file.path, finalPath);
  }
  res.status(201).json({ refFile: path.basename(finalPath), size: fs.statSync(finalPath).size });
});

/* ------------------------- Импорт книги ------------------------- */

router.post("/import-book", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const book = await bookParser.parseBook(req.file.path, req.file.originalname);
    try {
      removePath(req.file.path);
    } catch {
      /* ignore */
    }
    if (!book.chapters.length) return res.status(422).json({ error: "no_text_in_book" });
    logger.action("tts.book.import", {
      name: req.file.originalname,
      chapters: book.chapters.length,
    });
    res.json(book);
  } catch (e) {
    try {
      removePath(req.file.path);
    } catch {
      /* ignore */
    }
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------- NLP-предпросмотр ------------------------- */

router.post("/preview-chunks", (req, res) => {
  try {
    const chunks = engine.previewChunks(String(req.body?.text || ""), req.body?.engine, {
      expandNumbers: req.body?.expandNumbers !== false,
      yoficate: req.body?.yoficate !== false,
      markStress: !!req.body?.markStress,
    });
    res.json({ chunks });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- Задание ------------------------- */

router.post("/", (req, res) => {
  try {
    const job = engine.startJob(req.body || {});
    logger.action("tts.start", { id: job.id, engine: job.engine, chunks: job.chunksTotal });
    const { items, ...rest } = job;
    res.status(201).json({ ...rest, items: undefined, chunksPreview: items.slice(0, 5) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const { items, ...rest } = job;
  res.json(rest);
});

router.get("/:id/download", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile))
    return res.status(404).json({ error: "not_ready" });
  const safeName = `${
    String(job.opts.title || "audiobook")
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .slice(0, 60) || "audiobook"
  }.${job.opts.format}`;
  res.download(job.outFile, safeName);
});

router.post("/reveal", (req, res) => {
  try {
    res.json({ ok: engine.revealInExplorer(req.body?.path) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
