"use strict";

/**
 * Видеосжатие: гибридный 3-ступенчатый пайплайн.
 *
 * Как это работает:
 *  1. Downscale — FFmpeg уменьшает исходник до рабочей высоты (480/720/1080),
 *     промежуточник кодируется в near-lossless CRF 12. Звук уже здесь
 *     перекодируется в AAC — он прокидывается через все шаги до финала.
 *  2. AI Upscale — realesrgan-ncnn-vulkan работает ТОЛЬКО с картинками, поэтому
 *     видео разбирается на кадры: ffmpeg извлекает PNG-кадры, Real-ESRGAN
 *     (модель realesrgan-x4plus) апскейлит папку кадров 4x на GPU, финальный
 *     энкодер собирает кадры обратно (суперсэмплинг 4x -> рабочая высота) и
 *     мультиплексирует со звуковой дорожкой исходника. Нет бинаря — шаг
 *     помечается aiSkipped и пропускается.
 *  3. Encode — AV1 (libsvtav1, fallback libaom-av1) / HEVC / H.264 с CRF 0-50,
 *     звук AAC 192k (map из оригинала, «?» — не падать без дорожки).
 *
 * Очередь (С5): одно активное задание на модуль, остальные ждут в pending.
 * Чистка (С6): при загрузке модуля удаляются файлы старше 24 ч; Map заданий
 *   ограничена (готовые/ошибочные удаляются первыми, максимум 20).
 *
 * Прогресс: ffmpeg -progress pipe:1 даёт out_time_us; ETA — по фактической
 * скорости обработки, взвешенной по долям шагов (40/20/40%).
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const settings = require("./settings");
const logger = require("./logger");
const { DIRS } = require("./config");
const { detectFfmpeg } = require("./convertEngine");

// id -> job; завершённые остаются для скачивания (см. trimJobs).
const jobs = new Map();
const JOB_LIMIT = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

// --- Очередь: одно активное задание, остальные ждут (С5) ---
let active = false;
const pending = [];
function enqueue(fn) {
  pending.push(fn);
  pump();
}
function pump() {
  if (active || !pending.length) return;
  active = true;
  const fn = pending.shift();
  Promise.resolve()
    .then(fn)
    .catch((e) => logger.error("compressor.queue", { error: String(e) }))
    .finally(() => { active = false; pump(); });
}

// --- TTL-чистка временных папок при загрузке модуля (С6) ---
function cleanupOldFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* занят — пропускаем */ }
    }
  } catch { /* не критично */ }
}
cleanupOldFiles(DIRS.compressorIn);
cleanupOldFiles(DIRS.compressorOut);

// Ограничение Map: самые старые готовые/ошибочные задания удаляются первыми.
function trimJobs() {
  if (jobs.size <= JOB_LIMIT) return;
  const removable = [...jobs.values()]
    .filter((j) => j.done || j.stage === "error")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const j of removable) {
    if (jobs.size <= JOB_LIMIT) break;
    jobs.delete(j.id);
  }
}

function probeDuration(ffprobe, file) {
  return new Promise((resolve) => {
    execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? 0 : parseFloat(String(stdout).trim()) || 0));
  });
}


function probeVideoInfo(ffprobe, file) {
  return new Promise((resolve) => {
    execFile(ffprobe, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name,avg_frame_rate", "-of", "json", file],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const s = JSON.parse(String(stdout)).streams?.[0] || {};
          resolve({ width: s.width, height: s.height, codec: s.codec_name, fps: s.avg_frame_rate });
        } catch { resolve({}); }
      });
  });
}

// Запуск ffmpeg с парсингом -progress: onProgress(секунды обработаны).
function runFfmpeg(ffmpeg, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [...args, "-progress", "pipe:1", "-nostats"], { windowsHide: true });
    let errTail = "";
    child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-4000); });
    child.stdout.on("data", (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m && onProgress) onProgress(Number(m[1]) / 1e6);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errTail.slice(-300)}`)));
  });
}

// --- Автоподбор энкодера ---
// Сборки FFmpeg различаются: где-то есть libx264/libx265, где-то только
// NVENC/QSV/OpenH264. Запрашиваем список энкодеров один раз и выбираем
// первый доступный из приоритетного списка.
let encoderCache = null;
function availableEncoders(ffmpeg) {
  if (encoderCache) return encoderCache;
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-encoders"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", () => { encoderCache = new Set(); resolve(encoderCache); });
    child.on("close", () => {
      const set = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*[VAS]+\.[.\dSBSX]+\s+(\S+)/.exec(line);
        if (m) set.add(m[1]);
      }
      encoderCache = set;
      resolve(set);
    });
  });
}

// Первый доступный энкодер из списка предпочтений (или null).
async function pickEncoder(ffmpeg, prefs) {
  const avail = await availableEncoders(ffmpeg);
  for (const e of prefs) if (avail.has(e)) return e;
  return null;
}

// Аргументы качества под конкретный энкодер (CRF-подобное поведение).
function qualityArgs(enc, crf) {
  if (enc === "mpeg4") return ["-qscale:v", String(Math.max(2, Math.min(31, Math.round(crf / 1.6))))];
  if (enc.endsWith("_nvenc")) return ["-rc", "vbr", "-cq", String(Math.max(0, Math.min(51, crf)))];
  if (enc.endsWith("_qsv")) return ["-global_quality", String(Math.max(0, Math.min(51, crf)))];
  return ["-crf", String(crf)];
}

// Кодек-специфика: предпочтительные энкодеры + параметры качества.
// Порядок — от лучшего сжатия к совместимости; ускорители GPU почти в конце,
// т.к. при том же качестве дают файл больше программных.
async function encoderArgs(ffmpeg, codec, crf) {
  const lists = {
    av1:  ["libsvtav1", "libaom-av1", "av1_nvenc", "av1_qsv"],
    hevc: ["libx265", "hevc_nvenc", "hevc_qsv"],
    h264: ["libx264", "libopenh264", "h264_nvenc", "h264_qsv", "mpeg4"],
  };
  const prefs = lists[codec] || lists.av1;
  const enc = await pickEncoder(ffmpeg, prefs);
  if (!enc) return null; // ни одного энкодера для кодека нет
  const args = ["-c:v", enc, ...qualityArgs(enc, crf)];
  if (enc === "libsvtav1") args.push("-preset", "6");
  if (enc === "libx264" || enc === "libopenh264") args.push("-preset", "medium");
  if (enc === "libx265") args.push("-preset", "medium", "-tag:v", "hvc1");
  if (enc === "hevc_nvenc" || enc === "hevc_qsv") args.push("-tag:v", "hvc1");
  return args;
}

// Бинарь Real-ESRGAN ищется в storage/bin (кладётся вручную или установщиком).
function findRealesrgan() {
  const p = path.join(DIRS.storage, "bin", "realesrgan-ncnn-vulkan.exe");
  return fs.existsSync(p) ? p : null;
}

/* -------------------- Запуск и выполнение задания -------------------- */

function startJob(opts) {
  const id = crypto.randomBytes(6).toString("hex");
  const cfg = settings.get("compressor") || {};
  const job = {
    id, name: String(opts.name || "video"), size: Number(opts.size) || 0,
    inputPath: opts.inputPath, outFile: "", outSize: 0,
    stage: "queued", step: 0, progress: 0, etaSec: null,
    crf: Math.max(0, Math.min(50, Number(opts.crf ?? cfg.crf ?? 22))),
    codec: ["av1", "hevc", "h264"].includes(opts.codec) ? opts.codec : (cfg.codec || "av1"),
    targetHeight: ["original", "1080", "720", "480"].includes(String(opts.targetHeight)) ? String(opts.targetHeight) : "original",
    aiWanted: opts.aiUpscale !== false && opts.aiUpscale !== "false" && cfg.aiUpscale !== false,
    aiScale: opts.aiScale === "4x" ? "4x" : (cfg.aiScale === "4x" ? "4x" : "2x"),
    info: {}, steps: [], aiSkipped: false, error: "", done: false,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  trimJobs();
  // Очередь: реальный пайплайн стартует, когда освободится предыдущий.
  enqueue(() => runPipeline(job));
  return job;
}

// Смена ступени пайплайна: stage/step для UI + база и вес ступени в общем
// проценте прогресса (downscale 40%, AI 20%, encode 40%).
function setStage(job, stage, step, base, span) {
  job.stage = stage; job.step = step;
  job.progress = base;
  job._base = base; job._span = span;
}

async function runPipeline(job) {
  const cfg = settings.get("compressor") || {};
  const cleanup = cfg.cleanupTemp !== false;
  const { ffmpeg, ffprobe } = await detectFfmpeg();
  if (!ffmpeg) { job.error = "ffmpeg_missing"; job.stage = "error"; return; }
  const stamp = `${Date.now()}_${job.id}`;
  const t0 = Date.now();

  try {
    const duration = await probeDuration(ffprobe, job.inputPath);
    job.info = { ...job.info, ...(await probeVideoInfo(ffprobe, job.inputPath)) };

    // Прогресс внутри шага -> общий %. ETA: секунд на секунду видео по уже
    // пройденной части, экстраполяция на оставшийся процент пайплайна.
    const tracker = (sec) => {
      if (!duration || !job._span) return;
      const frac = Math.min(1, sec / duration);
      job.progress = Math.min(99, Math.round(job._base + job._span * frac));
      const spent = (Date.now() - t0) / 1000;
      const doneFrac = (job._base + job._span * frac) / 100;
      if (doneFrac > 0.02) job.etaSec = Math.max(0, Math.round(spent * (1 - doneFrac) / doneFrac));
    };

    const downscaled = path.join(DIRS.compressorOut, `ds_${stamp}.mp4`);
    const workH = job.targetHeight === "original" ? null : Number(job.targetHeight);

    // --- Шаг 1: Downscale до рабочей высоты. Звук: AAC (тащится до финала). ---
    setStage(job, "downscale", 1, 0, workH ? 40 : 10);
    // Промежуточник: первый доступный H.264-энкодер (у сборок без libx264 —
    // OpenH264/NVENC/QSV/mpeg4), near-lossless качество.
    const interEnc = await encoderArgs(ffmpeg, "h264", 12);
    if (!interEnc) throw new Error("no_h264_encoder");
    if (workH) {
      await runFfmpeg(ffmpeg,
        ["-y", "-i", job.inputPath, "-vf", `scale=-2:${workH}`, ...interEnc,
         "-c:a", "aac", "-b:a", "192k", downscaled],
        tracker);
      job.steps.push("downscale");
      if (cleanup) { try { fs.rmSync(job.inputPath, { force: true }); } catch { /* ignore */ } }
      job.inputPath = downscaled;
    }

    // --- Шаг 2: AI Upscale покадрово (realesrgan-x4plus) ---
    const realesrgan = findRealesrgan();
    let framesUpDir = null;
    if (job.aiWanted && realesrgan) {
      setStage(job, "upscale", 2, workH ? 40 : 10, 20);
      const framesDir = path.join(DIRS.compressorOut, `fr_${stamp}`);
      framesUpDir = path.join(DIRS.compressorOut, `fru_${stamp}`);
      fs.mkdirSync(framesDir, { recursive: true });
      fs.mkdirSync(framesUpDir, { recursive: true });
      // Разборка на PNG-кадры.
      await runFfmpeg(ffmpeg, ["-y", "-i", job.inputPath, "-vsync", "0", path.join(framesDir, "f_%06d.png")], tracker);
      // Апскейл всей папки кадров (x4 модель; итоговый масштаб задаёт сборка).
      await new Promise((resolve, reject) => {
        const child = spawn(realesrgan,
          ["-i", framesDir, "-o", framesUpDir, "-n", "realesrgan-x4plus",
           "-g", String(Number(cfg.gpuDeviceId ?? 0))],
          { windowsHide: true });
        let errTail = "";
        child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-2000); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`realesrgan exit ${code}: ${errTail.slice(-150)}`)));
      });
      job.steps.push("ai-upscale");
      if (cleanup) { try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    } else if (job.aiWanted) {
      job.aiSkipped = true; // включено, но бинарь Real-ESRGAN не найден
    }

    // --- Шаг 3: Кодирование AV1/HEVC/H.264 + звук из исходника ---
    setStage(job, "encode", 3, (job.aiWanted && framesUpDir) ? 60 : (workH ? 40 : 10), 40);
    const outFile = path.join(DIRS.compressorOut, `cmp_${stamp}.mp4`);
    // Итоговая высота: после 4x-апскейла возвращаемся к рабочей (суперсэмплинг).
    const finalH = framesUpDir ? (workH || job.info.height || null) : (workH || null);
    const fps = String(job.info.fps || "30");
    const fpsArg = /^\d+\/\d+$/.test(fps) ? fps : "30";
    const vf = finalH ? ["-vf", `scale=-2:${finalH}`] : [];
    // Звук всегда из исходного файла (-map 1:a); «?» — не падать без дорожки.
    const audioArgs = ["-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"];
    const imageSeq = framesUpDir
      ? ["-framerate", fpsArg, "-i", path.join(framesUpDir, "f_%06d.png")]
      : ["-i", job.inputPath];
    const tryEncode = (vArgs) => runFfmpeg(ffmpeg,
      ["-y", ...imageSeq, "-i", job.inputPath, ...audioArgs, ...vf, ...vArgs, outFile], tracker);
    // Автоподбор энкодера под выбранный кодек (fallback на NVENC/QSV/aom).
    const vArgs = await encoderArgs(ffmpeg, job.codec, job.crf);
    if (!vArgs) throw new Error(`no_encoder_${job.codec}`);
    await tryEncode(vArgs);
    if (cleanup) {
      if (framesUpDir) { try { fs.rmSync(framesUpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      try { fs.rmSync(job.inputPath, { force: true }); } catch { /* ignore */ }
    }

    job.outFile = outFile;
    job.outSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    job.progress = 100; job.etaSec = 0;
    job.done = true; job.stage = "done";
    logger.info("compressor.done", { id: job.id, size: job.outSize, codec: job.codec, crf: job.crf });
  } catch (e) {
    job.error = String(e.message || e); job.stage = "error";
    logger.error("compressor.error", { id: job.id, error: job.error });
  }
}

function getJob(id) { return jobs.get(id) || null; }

module.exports = { jobs, startJob, getJob, probeDuration, probeVideoInfo, runFfmpeg, encoderArgs, findRealesrgan };

