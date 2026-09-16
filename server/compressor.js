"use strict";

/**
 * Видеосжатие: единый встроенный пайплайн с матрицей энкодеров.
 *
 * Архитектура (rebuild 2.0):
 *  - Один шаг кодирования поверх исходника: масштабирование (-vf scale) и
 *    звук идут прямо в кодирующую команду. Промежуточных перекодирований нет.
 *  - Матрица методов: CPU (libsvtav1, libx265, libx264, libaom-av1, rav1e,
 *    Av1an-оркестратор) и GPU (NVENC/QSV/AMF через ffmpeg + rigaya-обёртки
 *    NVEncC/QSVEncC/VCEEncC). Всё обнаруживается автоматически (encoders.js).
 *  - Режимы качества: CRF/CQP, целевой битрейт (2-pass), ограниченное
 *    качество (CRF + maxrate).
 *  - Graceful fallback: недоступный/неудачный энкодер отбрасывается, очередь
 *    кандидатов заканчивается программным H.264 (есть почти в любой сборке).
 *  - Очередь: одно активное задание, TTL-чистка временных папок 24 ч.
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const encoders = require("./encoders");
const logger = require("./logger");
const { DIRS } = require("./config");
const { detectFfmpeg } = require("./convertEngine");
// Входной файл назван по исходному имени (кириллица сохраняется), а fs.rmSync
// такие пути на Windows молча не удаляет — исходники копились бы в storage.
const { removePath } = require("./fsUtil");
const { createQueue, trimJobs } = require("./jobStore");

// id -> job; завершённые остаются для скачивания, самые старые вытесняет trimJobs.
const jobs = new Map();
const JOB_LIMIT = 30;
const TTL_MS = 24 * 60 * 60 * 1000;

// --- Очередь: одно активное задание, остальные ждут (server/ts/jobStore.ts) ---
const queue = createQueue("compressor");

// --- TTL-чистка временных папок при загрузке модуля ---
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

function probeDuration(ffprobe, file) {
  return new Promise((resolve) => {
    execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? 0 : parseFloat(String(stdout).trim()) || 0));
  });
}

function probeVideoInfo(ffprobe, file) {
  return new Promise((resolve) => {
    // Берём ВСЕ видеопотоки и выбираем основной (максимальное разрешение) —
    // первым потоком в контейнере может оказаться обложка (mjpeg/png).
    execFile(ffprobe, ["-v", "error", "-select_streams", "v",
      "-show_entries", "stream=width,height,codec_name,avg_frame_rate,bit_rate", "-of", "json", file],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const streams = JSON.parse(String(stdout)).streams || [];
          const s = streams.filter((x) => x && x.codec_name)
            .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] || {};
          resolve({ width: s.width, height: s.height, codec: s.codec_name, fps: s.avg_frame_rate, bitRate: Number(s.bit_rate) || 0 });
        } catch { resolve({}); }
      });
  });
}


// Запуск процесса (ffmpeg/rigaya/av1an) с парсингом прогресса.
function runProc(cmd, args, onProgress, totalSec) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let errTail = "";
    child.stderr.on("data", (d) => {
      const s = String(d);
      errTail = (errTail + s).slice(-4000);
      emitProgress(s, onProgress, totalSec);
    });
    child.stdout.on("data", (d) => {
      const s = String(d);
      emitProgress(s, onProgress, totalSec);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(String(cmd))} exit ${code}: ${errTail.slice(-300)}`)));
  });
}

// ffmpeg даёт out_time_us; rigaya/av1an — проценты в выводе.
function emitProgress(s, onProgress, totalSec) {
  if (!onProgress) return;
  const um = /out_time_us=(\d+)/.exec(s);
  if (um) { onProgress(Number(um[1]) / 1e6); return; }
  const pm = /\s(\d{1,3}(?:\.\d+)?)\s*%/.exec(s.slice(-300));
  if (pm && totalSec > 0) onProgress((parseFloat(pm[1]) / 100) * totalSec);
}

function setStage(job, stage, weightBase, weightSpan) {
  job.stage = stage;
  job.weightBase = weightBase;
  job.weightSpan = weightSpan;
}

// Прогресс: доля шага * вес + база. totalSec — длительность видео.
function tracker(job, totalSec) {
  return (sec) => {
    const frac = totalSec > 0 ? Math.min(1, sec / totalSec) : 0;
    job.progress = Math.min(99, Math.round((job.weightBase + frac * job.weightSpan) * 100));
    const now = Date.now();
    if (job.startedAt) {
      const elapsed = (now - job.startedAt) / 1000;
      if (job.progress > 2) job.etaSec = Math.max(0, Math.round((elapsed / job.progress) * (100 - job.progress)));
    }
  };
}

// ================== СИСТЕМНЫЕ ПРЕСЕТЫ ==================
// targetMB — пресеты с лимитом размера: фронт считает битрейт из длительности
// и шлёт targetKbps. Подписи пресетов — в i18n (cmp.preset_<id>).
const SYSTEM_PRESETS = [
  { id: "discord",   codec: "av1",  engine: "auto",   qualityMode: "bitrate", crf: null, speed: "8",      tenBit: false, targetHeight: "1080", audio: "aac",  audioKbps: 128, targetMB: 25 },
  { id: "archival",  codec: "av1",  engine: "svtav1", qualityMode: "crf",     crf: 20,   speed: "4",      tenBit: true,  targetHeight: "original", audio: "copy", audioKbps: 192 },
  { id: "fastgpu",   codec: "av1",  engine: "nvenc",  qualityMode: "crf",     crf: 26,   speed: "P5",     tenBit: false, targetHeight: "original", audio: "copy", audioKbps: 192 },
  { id: "smallest",  codec: "av1",  engine: "auto",   qualityMode: "crf",     crf: 28,   speed: "6",      tenBit: false, targetHeight: "720",  audio: "opus", audioKbps: 96 },
  { id: "universal", codec: "h264", engine: "x264",   qualityMode: "crf",     crf: 22,   speed: "medium", tenBit: false, targetHeight: "original", audio: "aac",  audioKbps: 192 },
];

// ================== НОРМАЛИЗАЦИЯ ПАРАМЕТОВ ==================
const CODECS = ["av1", "hevc", "h264"];
const QUALITY_MODES = ["crf", "bitrate", "constrained"];
const HEIGHTS = ["original", "2160", "1440", "1080", "720", "480"];
const ENGINES = ["auto", "svtav1", "x265", "x264", "aom", "rav1e", "av1an", "nvenc", "qsv", "amf", "nvencc", "qsvencc", "vceencc"];

function clamp(n, a, b) { return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : a; }

function defaultSpeed(engine) {
  switch (engine) {
    case "svtav1": case "av1an": return "6";
    case "x265": case "x264": return "medium";
    case "aom": return "4";
    case "nvenc": return "P5";
    case "qsv": return "medium";
    case "amf": return "balanced";
    default: return "6";
  }
}

function normalizeParams(raw) {
  const p = {
    codec: CODECS.includes(raw.codec) ? raw.codec : "av1",
    engine: ENGINES.includes(raw.engine) ? raw.engine : "auto",
    qualityMode: QUALITY_MODES.includes(raw.qualityMode) ? raw.qualityMode : "crf",
    crf: clamp(Number(raw.crf ?? 23), 0, 51),
    targetKbps: clamp(Number(raw.targetKbps ?? 0), 0, 200000),
    maxKbps: clamp(Number(raw.maxKbps ?? 0), 0, 200000),
    speed: String(raw.speed || "").slice(0, 12),
    tenBit: raw.tenBit === true || raw.tenBit === "true",
    targetHeight: HEIGHTS.includes(String(raw.targetHeight)) ? String(raw.targetHeight) : "original",
    audio: ["copy", "aac", "opus"].includes(raw.audio) ? raw.audio : "aac",
    audioKbps: clamp(Number(raw.audioKbps ?? 192), 32, 320),
    presetId: String(raw.presetId || "").slice(0, 40),
  };
  if (!p.speed) p.speed = defaultSpeed(p.engine);
  return p;
}

// ================== КАНДИДАТЫ ЭНКОДЕРОВ (порядок fallback) ==================
// Для выбранного движка: [выбранный, ...однокодекные запасные, x264-страховка].
function engineCandidates(engine, codec, methods) {
  const perCodec = {
    av1:  ["svtav1", "nvenc", "qsv", "amf", "aom", "rav1e", "av1an"],
    hevc: ["x265", "nvenc", "qsv", "amf"],
    h264: ["x264", "nvenc", "qsv", "amf"],
  };
  const list = engine === "auto" ? perCodec[codec] : [engine, ...perCodec[codec].filter((e) => e !== engine)];
  const ok = list.filter((e) => methods[e] === true);
  // Кросс-кодек страховка: программный H.264 есть почти в любой сборке.
  if (codec !== "h264" && methods.x264 && !ok.includes("x264")) ok.push("x264");
  return ok;
}

// ================== СБОРКА АРГУМЕНТОВ ==================
const isWin = /^win/i.test(process.platform);

function quoteCmd(cmd, args) {
  const q = (s) => /\s/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
  return [cmd, ...args.map(q)].join(" ");
}

// Флаги качества под энкодер (CRF-подобное поведение).
function qualityFlags(enc, crf) {
  if (enc.endsWith("_nvenc")) return ["-rc", "vbr", "-cq", String(clamp(crf, 0, 51))];
  if (enc.endsWith("_qsv")) return ["-global_quality", String(clamp(crf, 0, 51))];
  if (enc.endsWith("_amf")) return ["-rc", "cqp", "-qp_i", String(clamp(crf, 0, 51)), "-qp_p", String(clamp(crf + 2, 0, 51))];
  return ["-crf", String(clamp(crf, 0, 51))];
}

// Пресет скорости под энкодер.
function speedArgs(enc, speed) {
  if (!speed) return [];
  if (enc === "libsvtav1") return ["-preset", String(clamp(parseInt(speed, 10) || 6, 0, 13))];
  if (enc === "libaom-av1") return ["-cpu-used", String(clamp(parseInt(speed, 10) || 4, 0, 8))];
  if (enc === "libx264" || enc === "libx265") return ["-preset", speed];
  if (enc.endsWith("_nvenc")) return ["-preset", /^P[1-7]$/i.test(speed) ? speed.toLowerCase() : "p5"];
  if (enc.endsWith("_qsv")) return ["-preset", speed];
  if (enc.endsWith("_amf")) return ["-quality", speed];
  return [];
}

// ffmpeg-вариант: полная команда кодирования. opts.pass 1/2 — двухпроходный
// битрейт; opts.maxrateCap — ограниченный режим (CRF + потолок).
function ffmpegArgs(job, ffEnc, opts = {}) {
  const { crf, targetKbps, maxKbps, speed, tenBit, targetHeight, audio, audioKbps } = job;
  const args = ["-y", "-i", job.inputPath];
  if (opts.pass === 1) {
    args.push("-map", "0:v:0", "-an"); // первый проход: только видео, без вывода
  } else {
    args.push("-map", "0:v:0", "-map", "0:a?"); // «?» — не падать без дорожки
  }
  if (targetHeight !== "original") args.push("-vf", `scale=-2:${targetHeight}`);
  const hw = /_(nvenc|qsv|amf|mf)$/.test(ffEnc);
  if (tenBit) args.push("-pix_fmt", hw ? "p010le" : "yuv420p10le");
  args.push("-c:v", ffEnc);
  if (opts.pass === 1 || opts.pass === 2) {
    args.push("-b:v", `${targetKbps}k`, "-pass", String(opts.pass));
  } else if (job.qualityMode === "bitrate" && targetKbps > 0) {
    args.push("-b:v", `${targetKbps}k`);
    if (maxKbps > 0) args.push("-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`);
  } else if (job.qualityMode === "constrained" && maxKbps > 0) {
    args.push(...qualityFlags(ffEnc, crf), "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`);
  } else {
    args.push(...qualityFlags(ffEnc, crf));
  }
  const sp = speedArgs(ffEnc, speed);
  if (sp.length) args.push(...sp);
  if (ffEnc === "libx264" || ffEnc === "libx265") args.push("-threads", String(Math.min(16, os.cpus().length)));
  if (opts.pass === 1) {
    args.push("-f", "null", isWin ? "NUL" : "/dev/null");
  } else {
    if (audio === "copy") args.push("-c:a", "copy");
    else if (audio === "opus") args.push("-c:a", "libopus", "-b:a", `${audioKbps}k`);
    else args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
    args.push("-shortest", opts.outFile);
  }
  return args;
}

// rigaya-обёртка (NVEncC/QSVEncC/VCEEncC): кодек + CQP/VBR + аудио.
function rigayaArgs(job, opts = {}) {
  const { crf, codec, speed, audio, audioKbps, targetHeight, tenBit } = job;
  const args = ["--input", job.inputPath, "--output", opts.outFile, "--codec", codec];
  if (job.qualityMode === "bitrate" && job.targetKbps > 0) {
    args.push("--vbr", String(job.targetKbps));
  } else if (job.qualityMode === "constrained" && job.maxKbps > 0) {
    args.push("--qvbr", String(clamp(crf, 0, 51)), "--max-bitrate", String(job.maxKbps));
  } else {
    args.push("--cqp", `${clamp(crf, 0, 51)}:${clamp(crf + 2, 0, 51)}:${clamp(crf + 2, 0, 51)}`);
  }
  if (speed && speed.startsWith("--")) args.push(speed);
  args.push("--output-depth", tenBit ? "10" : "8");
  if (targetHeight !== "original") args.push("--resize", `-,${targetHeight}`);
  if (audio === "copy") args.push("--audio-copy");
  else if (audio === "opus") args.push("--audio-codec", "libopus", "--audio-bitrate", String(audioKbps));
  else args.push("--audio-codec", "aac", "--audio-bitrate", String(audioKbps));
  return args;
}

// Av1an: параллельное кодирование по сценам (оркестратор над svt-av1).
function av1anArgs(job, opts = {}) {
  const workers = Math.max(1, Math.min(os.cpus().length, 16));
  return ["-i", job.inputPath, "-e", "svt-av1",
    "-v", `--crf ${clamp(job.crf, 0, 63)} --preset ${clamp(parseInt(job.speed, 10) || 6, 0, 13)}`,
    "--workers", String(workers), "-o", opts.outFile];
}

// Контейнер под аудио/кодек: opus в mp4 проблемный → webm (av1) или mkv.
function outExt(job) {
  if (job.audio === "opus") return job.codec === "av1" ? ".webm" : ".mkv";
  return ".mp4";
}

// ================== ЗАПУСК И ВЫПОЛНЕНИЕ ЗАДАНИЯ ==================
function startJob(raw) {
  const params = normalizeParams(raw);
  const id = crypto.randomUUID();
  const job = {
    id, createdAt: Date.now(), startedAt: 0,
    inputPath: raw.inputPath, name: raw.name || "video", size: raw.size || 0,
    ...params,
    stage: "queued", progress: 0, etaSec: null, steps: [],
    engineUsed: null, fallbacks: [], command: "",
    done: false, error: "", outSize: 0, outFile: null,
    info: {}, durationSec: 0,
    weightBase: 0, weightSpan: 1,
  };
  jobs.set(id, job);
  trimJobs(jobs, JOB_LIMIT);
  queue.enqueue(() => runJob(job));
  return job;
}

async function runJob(job) {
  const stamp = Date.now();
  const passLog = path.join(DIRS.compressorOut, `pl_${stamp}`);
  let lastErr = null;
  try {
    setStage(job, "analyze", 0, 0.05);
    job.startedAt = Date.now();
    const ff = await detectFfmpeg();
    if (!ff.found) throw new Error("ffmpeg_missing");
    const hw = await encoders.detectAll();
    job.info = await probeVideoInfo(ff.ffprobe, job.inputPath);
    job.durationSec = await probeDuration(ff.ffprobe, job.inputPath);
    job.steps.push("analyze");

    // Кандидаты: выбранный движок → запасные того же кодека → x264.
    const cands = engineCandidates(job.engine, job.codec, hw.methods);
    if (!cands.length) throw new Error(`no_encoder_${job.codec}`);
    job.engineUsed = cands[0];

    setStage(job, "encode", 0.05, 0.95);
    const ext = outExt(job);
    const outFile = path.join(DIRS.compressorOut, `cmp_${stamp}${ext}`);
    const onProg = tracker(job, job.durationSec || 0);

    for (const method of cands) {
      try {
        const cmd = await encodeWithMethod(job, method, hw, ff, { outFile, passLog, onProg });
        if (cmd) { job.command = cmd; break; }
      } catch (e) {
        lastErr = e;
        job.fallbacks.push(method);
        logger.warn("compressor.fallback", { method, err: String(e.message || e).slice(0, 200) });
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
      }
    }
    if (!job.command) throw lastErr || new Error(`no_working_encoder_${job.codec}`);

    job.outFile = outFile;
    job.outSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    job.progress = 100; job.etaSec = 0;
    job.done = true; job.stage = "done";
    job.steps.push("encode");
    logger.info("compressor.done", { id: job.id, size: job.outSize, engine: job.engineUsed, codec: job.codec, fallbacks: job.fallbacks });
  } catch (e) {
    job.error = String(e.message || e); job.stage = "error";
    logger.error("compressor.error", { id: job.id, error: job.error });
  } finally {
    try { removePath(job.inputPath); } catch { /* ignore */ }
    try { fs.rmSync(`${passLog}-0.log`, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(`${passLog}-0.log.mbtree`, { force: true }); } catch { /* ignore */ }
  }
}

// Выполнение кодирования конкретным методом. Возвращает CLI-строку команды
// (для «копировать команду»), либо бросает исключение → fallback.
async function encodeWithMethod(job, method, hw, ff, ctx) {
  const { outFile, onProg } = ctx;
  const twoPass = job.qualityMode === "bitrate" && job.targetKbps > 0;

  if (method === "av1an") {
    // Оркестратор: параллелит SVT-AV1 по сценам. Фейл → следующий кандидат.
    const exe = hw.externals.av1an;
    const args = av1anArgs(job, { outFile });
    await runProc(exe, args, onProg, job.durationSec);
    return quoteCmd(exe, args);
  }
  if (method === "rav1e" && !hw.ffmpegEncoders.includes("librav1e")) {
    // Отдельный бинарь rav1e: элементарный поток .ivf, mux делает ffmpeg.
    const exe = hw.externals.rav1e;
    const ivf = outFile.replace(/\.\w+$/, "") + ".ivf";
    const args = [job.inputPath, "--output", ivf, "--crf", String(job.crf),
      "--speed", String(clamp(parseInt(job.speed, 10) || 6, 0, 10))];
    await runProc(exe, args, onProg, job.durationSec);
    const mux = ["-y", "-i", ivf, "-i", job.inputPath, "-map", "0:v", "-map", "1:a?",
      "-c", "copy", "-shortest", outFile];
    await runProc(ff.ffmpeg, mux, null, 0);
    try { fs.rmSync(ivf, { force: true }); } catch { /* ignore */ }
    return quoteCmd(exe, args);
  }
  if (method === "nvencc" || method === "qsvencc" || method === "vceencc") {
    const exe = hw.externals[method];
    const args = rigayaArgs(job, { outFile });
    await runProc(exe, args, onProg, job.durationSec);
    return quoteCmd(exe, args);
  }
  // ffmpeg-методы: svtav1/x265/x264/aom/nvenc/qsv/amf
  const prefs = encoders.METHOD_FFMPEG_ENC[method]?.[job.codec] || [];
  const avail = prefs.filter((e) => hw.ffmpegEncoders.includes(e));
  if (!avail.length) throw new Error(`ffmpeg_encoder_missing_${method}`);
  let lastErr = null;
  for (const ffEnc of avail) {
    try {
      if (twoPass) {
        // Проход 1 (45% веса), затем проход 2 (50%).
        setStage(job, "encode", 0.05, 0.45);
        const p1 = ffmpegArgs(job, ffEnc, { pass: 1 });
        await runProc(ff.ffmpeg, [...p1.slice(0, -3), "-passlogfile", ctx.passLog, ...p1.slice(-3)], onProg, job.durationSec);
        setStage(job, "encode", 0.5, 0.5);
        const p2 = ffmpegArgs(job, ffEnc, { pass: 2, outFile });
        const p2full = [...p2.slice(0, -1), "-passlogfile", ctx.passLog, p2[p2.length - 1]];
        await runProc(ff.ffmpeg, p2full, onProg, job.durationSec);
        return quoteCmd(ff.ffmpeg, p2full);
      }
      const args = ffmpegArgs(job, ffEnc, { outFile });
      await runProc(ff.ffmpeg, args, onProg, job.durationSec);
      job.ffEnc = ffEnc;
      return quoteCmd(ff.ffmpeg, args);
    } catch (e) {
      // Аппаратный энкодер может числиться в сборке, но не работать на машине.
      lastErr = e;
      logger.warn("compressor.ffEncFallback", { ffEnc, err: String(e.message || e).slice(0, 160) });
      try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error(`ffmpeg_method_failed_${method}`);
}

function getJob(id) { return jobs.get(id) || null; }

module.exports = {
  jobs, startJob, getJob, SYSTEM_PRESETS, normalizeParams, engineCandidates,
  probeDuration, probeVideoInfo,
};




