"use strict";

/**
 * API апскейла фото и видео (встроенный ONNX-движок, server/upscale.js).
 *
 *  GET    /api/upscale/models          — каталог моделей + статус загрузки
 *  POST   /api/upscale/models/download — скачать модель из манифеста
 *  POST   /api/upscale/models/sync     — обновить каталог (манифест из GitHub)
 *  DELETE /api/upscale/models/:id      — удалить скачанный файл модели
 *  GET    /api/upscale/hardware        — рантайм, ffmpeg, CPU, доступные модели
 *  GET    /api/upscale/presets         — системные + пользовательские пресеты
 *  POST   /api/upscale/presets         — сохранить пользовательский пресет
 *  DELETE /api/upscale/presets/:name   — удалить пользовательский пресет
 *  POST   /api/upscale/probe           — быстрая проба файла (без задания)
 *  POST   /api/upscale/estimate        — оценка результата и времени (без запуска)
 *  POST   /api/upscale                 — multipart { file, ...params } → job
 *  GET    /api/upscale/:id             — статус задания
 *  POST   /api/upscale/:id/cancel      — мягкая остановка (кнопка «Стоп»)
 *  POST   /api/upscale/pause           — пауза очереди (кадры и процессы живут)
 *  POST   /api/upscale/resume          — продолжить с того же кадра
 *  POST   /api/upscale/:id/pause       — пауза одного задания
 *  POST   /api/upscale/:id/resume      — продолжить одно задание
 *  POST   /api/upscale/inputs/clean    — очистить папку загрузок (storage/upscale/in)
 *  GET    /api/upscale/:id/download    — скачивание результата
 *  GET    /api/upscale/:id/preview     — стриминг результата (сравнение)
 *  GET    /api/upscale/:id/reveal      — путь результата для проводника
 *  DELETE /api/upscale/:id             — отменить/удалить задание и файлы
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const engine = require("../upscale");
const settings = require("../settings");
const { DIRS } = require("../config");
const logger = require("../logger");
// Загрузки названы по исходному имени файла (кириллица сохраняется), а fs.rmSync
// такие пути на Windows молча не удаляет — временные файлы копились бы вечно.
const { removePath } = require("../fsUtil");
const { detectFfmpeg } = require("../convertEngine");

const router = express.Router();
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 ГБ — видео бывает большим

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.upscaleIn,
    filename: (req, file, cb) => {
      const base = path.basename(
        String(file.originalname || "media").replace(/[\\/:*?"<>|]+/g, "_"),
      );
      const ext = path.extname(base) || ".bin";
      const stem = path.basename(base, ext).slice(0, 60) || "media";
      cb(null, `${Date.now()}_${stem}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
});

// Публичное представление задания: без путей к файлам на диске.
function view(job) {
  if (!job) return null;
  const { inputPath, outFile, ...rest } = job;
  return rest;
}

/** Незавершённые задания: ответ на «Пауза»/«Продолжить» сразу показывает очередь. */
function jobsView() {
  const out = [];
  for (const j of engine.jobs.values()) {
    if (j.done || j.stage === "error" || j.stage === "stopped") continue;
    out.push(view(j));
  }
  return out;
}

// --- Модели: каталог + загрузка из манифеста ---
router.get("/models", (req, res) => {
  res.json({
    runtime: engine.runtimeAvailable(),
    runtimeInfo: engine.runtimeStatus(),
    dir: DIRS.upscaleModels,
    models: engine.listModels(),
    downloads: engine.downloadStates(),
    // Откуда каталог: скачанный из GitHub (remote) или вшитый в сборку.
    manifest: engine.manifestInfo(),
    // TensorRT: есть ли провайдер в сборке и что уже собрано (панель моделей).
    trt: engine.trtStatus(),
  });
});

/**
 * «Собрать движок TensorRT FP16»: TRT компилирует ONNX под GPU и кладёт
 * .engine в кэш. Для AMD/Intel/CPU этот пункт не нужен — там работает
 * обычный ONNX-путь (провайдеры dml/cpu).
 */
router.post("/models/:id/trt", async (req, res) => {
  try {
    const tile = Number((req.body || {}).tile) || 0;
    const r = await engine.buildTrtEngine(req.params.id, { tile });
    res.json({ ...r, trt: engine.trtStatus() });
  } catch (e) {
    // 400 — «нельзя собрать на этой машине» (нет провайдера), 500 — сбой сборки.
    const code = e.message === "trt_unavailable" ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

/**
 * «Обновить каталог»: свежий манифест моделей из GitHub вместо ожидания
 * обновления приложения. Тело { url } — свой адрес (иначе из движка).
 * Ошибка не ломает уже работающий каталог: подмена только после проверки файла.
 */
router.post("/models/sync", async (req, res) => {
  try {
    const r = await engine.syncManifest({ url: (req.body || {}).url });
    res.json({ ...r, manifest: engine.manifestInfo() });
  } catch (e) {
    // 502: источник (GitHub/зеркало) не отдал каталог — это не ошибка запроса.
    res.status(502).json({ error: e.message });
  }
});

router.post("/models/download", async (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || "");
    const r = await engine.downloadModel(id, { force: body.force === true });
    engine.clearSessions(); // новая модель — старые сессии ни к чему
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удаление скачанного файла: каталог остаётся, место на диске освобождается.
router.delete("/models/:id", (req, res) => {
  try {
    const r = engine.removeModel(req.params.id);
    engine.clearSessions();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Железо: рантайм + ffmpeg + CPU (для подсказок в UI) ---
router.get("/hardware", async (req, res) => {
  try {
    const ff = await detectFfmpeg();
    const cpus = os.cpus();
    // Что сборка ffmpeg умеет из «железного»: NVENC/QSV/AMF и аппаратный декодер.
    // Нужно панели настроек, чтобы не обещать ускорение, которого нет.
    let gpu = { decode: "", x264: "", x265: "", av1: "", hardware: false };
    if (ff.found && ff.ffmpeg) {
      try {
        gpu = await engine.encoderPlan(ff.ffmpeg);
      } catch {
        /* не смогли спросить ffmpeg — оставляем пустой план */
      }
    }
    res.json({
      runtime: engine.runtimeAvailable(),
      runtimeInfo: engine.runtimeStatus(),
      ffmpeg: { found: ff.found, path: ff.path, version: ff.version },
      cpu: {
        name: cpus[0]?.model || "CPU",
        coresLogical: cpus.length,
        coresPhysical: Math.max(1, Math.ceil(cpus.length / 2)),
      },
      gpu,
      models: engine.listModels(),
      // Провайдеры ONNX Runtime в этой сборке (cpu/dml/cuda/tensorrt…) и TensorRT:
      // список провайдеров нужен панели настроек, чтобы не обещать ускорение,
      // которого нет, а «собрать движок» — только когда провайдер есть.
      providers: engine.supportedBackends(),
      trt: engine.trtStatus(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Пресеты: системные из движка + пользовательские из settings.json ---
function customPresets() {
  try {
    const raw = String(settings.get("upscaler").customPresets || "");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === "string") : [];
  } catch {
    return [];
  }
}

function saveCustomPresets(list) {
  settings.set({ upscaler: { customPresets: JSON.stringify(list.slice(0, 30)) } });
}

router.get("/presets", (req, res) => {
  res.json({
    system: engine.SYSTEM_PRESETS,
    custom: customPresets(),
    defaults: settings.get("upscaler"),
  });
});

router.post("/presets", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "")
    .trim()
    .slice(0, 40);
  if (!name) return res.status(400).json({ error: "missing_name" });
  const list = customPresets().filter((p) => p.name !== name);
  const { name: _n, ...params } = body;
  list.push({ name, ...params });
  saveCustomPresets(list);
  res.json({ ok: true, custom: customPresets() });
});

router.delete("/presets/:name", (req, res) => {
  const before = customPresets().length;
  saveCustomPresets(customPresets().filter((p) => p.name !== req.params.name));
  res.json({ ok: true, removed: before - customPresets().length });
});

// --- Быстрая проба файла: тип/размеры/fps (файл сразу удаляем) ---
router.post("/probe", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const info = await engine.probeUpload(req.file.path, req.file.originalname);
    res.json({ ...info, size: req.file.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try {
      removePath(req.file.path);
    } catch {
      /* ignore */
    }
  }
});

// --- Оценка задания: размеры, кадры, частота, время (без запуска) ---
// Проба приходит с клиента (он уже спрашивал /probe), файл повторно не грузим:
// оценка нужна на каждое изменение настроек, и «вес» запроса тут неуместен.
router.post("/estimate", (req, res) => {
  try {
    const body = req.body || {};
    const probe = body.probe || {};
    if (!(Number(probe.width) > 0) || !(Number(probe.height) > 0)) {
      return res.status(400).json({ error: "probe_required" });
    }
    const params = engine.normalizeParams(body.params || body);
    res.json(
      engine.estimateUpscale(params, {
        kind: String(probe.kind || ""),
        width: Number(probe.width),
        height: Number(probe.height),
        duration: Number(probe.duration || 0),
        fps: Number(probe.fps || 0),
        fpsNum: Number(probe.fpsNum || 0),
        fpsDen: Number(probe.fpsDen || 0),
      }),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Старт задания ---
router.post("/", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    const job = engine.startJob({
      inputPath: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      ...req.body,
    });
    logger.action("upscale.route_start", { id: job.id, kind: job.kind, model: job.model });
    res.status(201).json(view(job));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Мягкая остановка задания (кнопка «Стоп» рядом с прогрессом): пайплайн
 * проверяет stage между кадрами и завершается сам, файлы результата не трогаем —
 * частичный результат остаётся для скачивания/повтора.
 */
router.post("/:id/cancel", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const stopped = engine.cancelJob(req.params.id);
  res.json({ ok: stopped, job: view(engine.getJob(req.params.id)) });
});

/**
 * Пауза и возобновление (маленькая кнопка рядом со «Стоп»).
 *
 * Пауза общая для очереди: задание держит слот очереди, поэтому следующие файлы
 * не стартуют, а обработка текущего продолжается ровно с того кадра, на котором
 * остановились (процессы и модели остаются живыми). Объявлено ДО `/:id`.
 */
router.post("/pause", (req, res) => {
  res.json({ ok: true, paused: engine.pauseJobs(), jobs: jobsView() });
});

router.post("/resume", (req, res) => {
  res.json({ ok: true, resumed: engine.resumeJobs(), jobs: jobsView() });
});

/** Пауза/продолжение одного задания (точечно, очередь не трогаем). */
router.post("/:id/pause", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({ ok: engine.pauseJob(req.params.id), job: view(engine.getJob(req.params.id)) });
});

router.post("/:id/resume", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({ ok: engine.resumeJob(req.params.id), job: view(engine.getJob(req.params.id)) });
});

/**
 * Очистка папки загрузок (storage/upscale/in) по требованию UI: пользователь
 * выбрал следующий файл — исходники прошлых задач больше не нужны.
 * Объявлено ДО `/:id`, иначе Express принял бы "inputs" за id задания.
 */
router.post("/inputs/clean", (req, res) => {
  try {
    res.json({ ok: true, ...engine.cleanInputs() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(view(job));
});

router.get("/:id/download", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile))
    return res.status(404).json({ error: "not_ready" });
  res.download(job.outFile, path.basename(job.outFile).replace(/^[0-9a-f-]{36}_/i, ""));
});

// Стриминг для плеера/картинки сравнения (Range-запросы Express обработает сам).
router.get("/:id/preview", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile || !fs.existsSync(job.outFile))
    return res.status(404).json({ error: "not_ready" });
  res.sendFile(job.outFile);
});

// Абсолютный путь результата для «Reveal in File Explorer»
// (открывается через IPC shell.showItemInFolder, см. electron/main.js).
router.get("/:id/reveal", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job?.done || !job.outFile) return res.status(404).json({ error: "not_ready" });
  res.json({ path: job.outFile });
});

router.delete("/:id", (req, res) => {
  const job = engine.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  engine.cancelJob(req.params.id); // мягкая остановка, если ещё считает
  try {
    if (job.outFile) removePath(job.outFile);
  } catch {
    /* ignore */
  }
  try {
    removePath(job.inputPath);
  } catch {
    /* ignore */
  }
  engine.jobs.delete(req.params.id);
  logger.action("upscale.delete", { id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
