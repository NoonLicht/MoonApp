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
        const m = /^\s*[VAS][.\w]*\s+(\S+)/.exec(line);
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

// Все доступные кандидаты по порядку предпочтений. Нужен список, а не один
// энкодер: аппаратные (qsv/nvenc) присутствуют в любой сборке, но реально
// работают только при наличии соответствующего GPU — такие попытки падают
// с «stream received no packets», и надо откатываться на следующий.
async function encoderCandidates(ffmpeg, prefs, crf) {
  const avail = await availableEncoders(ffmpeg);
  const out = [];
  for (const enc of prefs) {
    if (!avail.has(enc)) continue;
    out.push({ enc, args: ["-c:v", enc, ...qualityArgs(enc, crf)] });
  }
  return out;
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
// Возвращает СПИСОК кандидатов (software → hardware): аппаратный энкодер
// может числиться в сборке, но не работать на конкретной машине (нет QSV/
// NVIDIA) — тогда пробуется следующий из списка.
async function codecEncoderCandidates(ffmpeg, codec, crf, gpuFirst) {
  const lists = {
    av1:  ["libsvtav1", "libaom-av1", "av1_nvenc", "av1_qsv"],
    hevc: ["libx265", "hevc_nvenc", "hevc_qsv"],
    h264: ["libx264", "libopenh264", "h264_nvenc", "h264_qsv", "mpeg4"],
  };
  let prefs = lists[codec] || lists.av1;
  // Быстрый режим: аппаратные энкодеры впереди (десятки раз быстрее CPU,
  // ценой чуть большего файла при том же CRF).
  if (gpuFirst) prefs = [...prefs.filter((e) => e.endsWith("_nvenc")), ...prefs.filter((e) => !e.endsWith("_nvenc"))];
  let cands = await encoderCandidates(ffmpeg, prefs, crf);
  // Кросс-кодек страховка: в сборках без software HEVC/AV1 (как у пользователя
  // только qsv) последний шанс — программный H.264, он есть почти везде.
  const swH264 = await encoderCandidates(ffmpeg, ["libx264", "libopenh264", "mpeg4"], crf);
  for (const c of swH264) c.args.push("-tag:v", "avc1");
  cands = cands.concat(swH264.map((c) => ({ ...c, cross: true })));
  // Пост-аргументы для конкретных энкодеров.
  for (const c of cands) {
    if (c.enc === "libsvtav1") c.args.push("-preset", "6");
    if (c.enc === "libx264") c.args.push("-preset", "medium"); // у openh264 нет -preset
    if (c.enc === "libx265") c.args.push("-preset", "medium", "-tag:v", "hvc1");
    if (c.enc === "hevc_nvenc" || c.enc === "hevc_qsv") c.args.push("-tag:v", "hvc1");
    if (c.enc === "av1_nvenc") c.args.push("-preset", "P5");
  }
  return cands;
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
    // Целевое разрешение апскейла (пользователь выбирает сам); none = без ИИ.
    upHeight: ["none", "1080", "1440", "2160", "4320"].includes(String(opts.upHeight))
      ? String(opts.upHeight)
      : (["1080", "1440", "2160", "4320"].includes(String(cfg.upHeight)) ? String(cfg.upHeight) : "none"),
    // Модель апскейла: x4plus — лучшее качество (медленно), animevideov3 —
    // специально для видео, в 3-5 раз быстрее.
    aiModel: ["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3-x2", "realesr-animevideov3-x4"].includes(opts.aiModel)
      ? opts.aiModel
      : (["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3-x2", "realesr-animevideov3-x4"].includes(cfg.aiModel) ? cfg.aiModel : "realesr-animevideov3-x4"),
    // GPU-first: аппаратный NVENC-энкодер впереди программного (быстро, файл больше).
    gpuFirst: opts.gpuFirst === true || cfg.gpuFirst === true,
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
  // Временные файлы задания (сегменты кадров, апскейл-кадры) — на уровне
  // функции, чтобы finally мог их почистить даже после ошибки в try.
  const tmpDirs = [];
  // Файл мог исчезнуть (TTL-чистка, ручное удаление) — честная ошибка вместо
  // каскада «no_working_encoder» от каждого энкодера.
  if (!fs.existsSync(job.inputPath)) {
    job.error = "input_missing"; job.stage = "error";
    logger.error("compressor.error", { id: job.id, error: job.error });
    return;
  }
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
    // Промежуточник: перебор H.264-энкодеров (software → hardware).
    // QSV/NVENC числятся в сборке, но работают только на совместимом GPU —
    // при неудаче берём следующего кандидата.
    const interCands = await codecEncoderCandidates(ffmpeg, "h264", 12, job.gpuFirst);
    if (!interCands.length) throw new Error("no_h264_encoder");
    if (workH) {
      let interDone = false;
      for (const c of interCands) {
        try {
          await runFfmpeg(ffmpeg,
            ["-y", "-i", job.inputPath, "-vf", `scale=-2:${workH}`, ...c.args,
             "-c:a", "aac", "-b:a", "192k", downscaled],
            tracker);
          interDone = true;
          break;
        } catch (e) {
          logger.warn("compressor.interEncoderFallback", { enc: c.enc, err: String(e.message || e).slice(0, 160) });
          try { fs.rmSync(downscaled, { force: true }); } catch { /* ignore */ }
        }
      }
      if (!interDone) throw new Error("no_working_h264_encoder");
      job.steps.push("downscale");
      if (cleanup) { try { fs.rmSync(job.inputPath, { force: true }); } catch { /* ignore */ } }
      job.inputPath = downscaled;
    }

    // --- Шаг 2: AI Upscale сегментной «лентой» ---
    // Кадры пишутся в JPEG (в разы дешевле PNG), декодер и Real-ESRGAN
    // работают параллельно: пока GPU апскейлит сегмент i, CPU уже пишет i+1.
    const realesrgan = findRealesrgan();
    let framesUpDir = null;
    const upH = ["1080", "1440", "2160", "4320"].includes(String(job.upHeight)) ? Number(job.upHeight) : null;
    if (job.aiWanted && upH && realesrgan) {
      setStage(job, "upscale", 2, workH ? 40 : 10, 20);
      const baseH = workH || Number(job.info.height) || 0;
      // Коэффициент апскейла = цель / рабочая высота. animevideov3 умеет -s 2/3/4,
      // x4plus-модели всегда 4x.
      const ratio = baseH > 0 ? upH / baseH : 4;
      const s = job.aiModel.startsWith("realesr-animevideov3")
        ? String(Math.max(2, Math.min(4, Math.round(ratio))))
        : "4";
      framesUpDir = path.join(DIRS.compressorOut, `fru_${stamp}`);
      fs.mkdirSync(framesUpDir, { recursive: true });
      tmpDirs.push(framesUpDir);
      const modelOk = fs.existsSync(path.join(DIRS.storage, "bin", "models", `${job.aiModel}.bin`))
        && fs.existsSync(path.join(DIRS.storage, "bin", "models", `${job.aiModel}.param`));
      if (!modelOk) {
        job.aiSkipped = true; job.aiSkipReason = "model_missing";
        logger.warn("compressor.aiModelMissing", { model: job.aiModel });
        framesUpDir = null;
      } else {
        // Сегментная лента: ffmpeg пишет сегмент N+1, GPU апскейлит сегмент N.
        // ВАЖНО: realesrgan-процесс всегда ОДИН (очередь сегментов) — каждый
        // процесс держит копию модели в VRAM/RAM, параллельные забивают память.
        const SEG_SEC = 15;
        const fpsN = Number(job.info.fps) || 30;
        const duration = await probeDuration(ffprobe, job.inputPath);
        const numSegs = Math.max(1, Math.ceil((duration || 60) / SEG_SEC));
        const totalFrames = Math.round((duration || 60) * fpsN);
        let nextNum = 1; // глобальный номер кадра; растёт по ФАКТИЧЕСКОМУ числу
        // кадров сегмента (см. ниже) — дыр в нумерации не бывает, поэтому
        // image2-демуксер не обрывает видео после первого сегмента.
        let nextSeg = 0;
        const upQueue = [];     // готовые к апскейлу сегменты
        let upRunning = false;  // сейчас работает GPU-процесс (0 или 1)
        let decodeDone = false;
        const segErr = [];
        await new Promise((resolve, reject) => {
          let finished = false;
          const maybeDone = () => {
            if (!finished && decodeDone && upQueue.length === 0 && !upRunning) {
              finished = true;
              // Ошибка важна, только если не апскейлился вообще ни один кадр.
              let produced = 0;
              try { produced = fs.readdirSync(framesUpDir).length; } catch { /* ignore */ }
              if (segErr.length && produced === 0) reject(new Error(segErr[0] || "upscale_failed"));
              else resolve();
            }
          };
          // Один запуск realesrgan на сегмент с ретраями тайла: 0 (авто) →
          // 128 → 64. Меньше тайл — меньше VRAM, чуть медленнее, но без
          // «квадратов» при нехватке видеопамяти.
          const runUpscale = (dir, tile) => new Promise((res2, rej2) => {
            const child = spawn(realesrgan,
              ["-i", dir, "-o", framesUpDir, "-n", job.aiModel, "-f", "jpg",
               "-s", s, "-t", String(tile), "-j", "2:4:4",
               ...(Number(cfg.gpuDeviceId) > 0 ? ["-g", String(Number(cfg.gpuDeviceId))] : [])],
              { windowsHide: true });
            let errTail = "";
            let done2 = false;
            const finish = (code, err) => {
              if (done2) return; done2 = true;
              code === 0 ? res2() : rej2(new Error(`realesrgan exit ${code}: ${err.slice(-150)}`));
            };
            child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-2000); });
            child.on("error", (e) => finish(1, String(e)));
            child.on("close", (code) => finish(code, errTail));
          });
          // Очередь апскейла: одновременно живёт максимум один realesrgan.
          const pump = () => {
            if (upRunning || upQueue.length === 0) { maybeDone(); return; }
            const dir = upQueue.shift();
            upRunning = true;
            const attempt = (tileIdx) => {
              const tiles = [0, 128, 64];
              if (tileIdx >= tiles.length) {
                segErr.push(`segment ${dir} upscale failed (all tile sizes)`);
                upRunning = false;
                try { fs.readdirSync(dir).forEach((f) => { try { fs.rmSync(path.join(framesUpDir, f), { force: true }); } catch { /* ignore */ } }); } catch { /* ignore */ }
                pump();
                return;
              }
              runUpscale(dir, tiles[tileIdx]).then(() => {
                // Прогресс по фактическому числу готовых кадров.
                try {
                  const done = fs.readdirSync(framesUpDir).length;
                  job.progress = Math.min(99, Math.round((workH ? 40 : 10) + 20 * (done / Math.max(1, totalFrames))));
                } catch { /* ignore */ }
                upRunning = false;
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
                pump();
              }).catch((e) => {
                logger.warn("compressor.upscaleRetry", { tile: tiles[tileIdx], err: String(e.message || e).slice(0, 160) });
                // Убираем частично обработанные кадры этого сегмента — ретрай заново.
                try { fs.readdirSync(dir).forEach((f) => { try { fs.rmSync(path.join(framesUpDir, f), { force: true }); } catch { /* ignore */ } }); } catch { /* ignore */ }
                upRunning = false;
                attempt(tileIdx + 1);
              });
            };
            attempt(0);
          };
          const startDecode = () => {
            if (nextSeg >= numSegs) {
              decodeDone = true; maybeDone(); return;
            }
            const i = nextSeg++;
            const dir = path.join(DIRS.compressorOut, `frs_${stamp}_${i}`);
            fs.mkdirSync(dir, { recursive: true });
            tmpDirs.push(dir);
            const start = i * SEG_SEC;
            const startNum = nextNum; // номер первого кадра ЭТОГО сегмента
            runFfmpeg(ffmpeg, ["-y", "-ss", String(start), "-t", String(SEG_SEC), "-i", job.inputPath,
              "-fps_mode", "passthrough", "-q:v", "2", "-start_number", String(startNum),
              path.join(dir, "f_%06d.jpg")], tracker).then(() => {
              // СЛЕДУЮЩИЙ глобальный номер = фактическое число кадров сегмента.
              // Никаких дыр в нумерации — image2 не обрывает видео.
              const written = fs.readdirSync(dir).length;
              nextNum = startNum + written;
              upQueue.push(dir);
              pump();               // GPU свободен — сразу берём следующий сегмент
              startDecode();        // декодер бежит вперёд, не ждёт GPU
            }).catch((e) => {
              logger.warn("compressor.segDecodeFail", { seg: i, err: String(e.message || e).slice(0, 160) });
              segErr.push(String(e.message || e));
              startDecode();
              if (nextSeg >= numSegs && upQueue.length === 0 && !upRunning) { decodeDone = true; reject(new Error(segErr[0] || "decode_failed")); }
            });
          };
          startDecode();
        });
        // Если какой-то сегмент так и не апскейлился — падаем с понятной
        // ошибкой, а НЕ отдаём обрезанные первые 15 секунд.
        const failedSegs = segErr.filter((e) => /upscale failed|segment .* upscale failed/.test(e));
        if (failedSegs.length) throw new Error("upscale_segment_failed");
        job.steps.push("ai-upscale");
      }
    } else if (job.aiWanted && upH) {
      job.aiSkipped = true; // включено, но бинарь Real-ESRGAN не найден
    }

    // --- Шаг 3: Кодирование AV1/HEVC/H.264 + звук из исходника ---
    setStage(job, "encode", 3, (framesUpDir) ? 60 : (workH ? 40 : 10), 40);
    const outFile = path.join(DIRS.compressorOut, `cmp_${stamp}.mp4`);
    // Итоговая высота: цель апскейла, если он был; иначе — рабочая (downscale).
    const finalH = framesUpDir ? upH : (workH || null);
    const fps = String(job.info.fps || "30");
    const fpsN = Number(job.info.fps) || 30;
    const fpsArg = /^\d+\/\d+$/.test(fps) ? fps : "30";
    const vf = finalH ? ["-vf", `scale=-2:${finalH}`] : [];
    // Звук всегда из исходного файла (-map 1:a); «?» — не падать без дорожки.
    const audioArgs = ["-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"];
    let imageSeq;
    if (framesUpDir) {
      // Кадры собираются через ffconcat-список: НЕ зависит от непрерывности
      // нумерации (realesrgan изредка пропускает кадр — image2 по номеру
      // обрывался на первой дыре, давая «15-секундное» видео).
      const files = fs.readdirSync(framesUpDir)
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort((a, b) => {
          const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
          const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
          return na - nb;
        });
      if (!files.length) throw new Error("upscale_empty");
      const listPath = path.join(framesUpDir, "list.ffconcat");
      const dur = (1 / fpsN).toFixed(6);
      let lst = "ffconcat version 1.0\n";
      for (const f of files) lst += `file '${f}'\nduration ${dur}\n`;
      lst += `file '${files[files.length - 1]}'\n`; // последний кадр без duration — фиксация длительности
      fs.writeFileSync(listPath, lst, "utf8");
      imageSeq = ["-f", "concat", "-safe", "0", "-i", listPath];
    } else {
      imageSeq = ["-i", job.inputPath];
    }
    const tryEncode = (vArgs) => runFfmpeg(ffmpeg,
      ["-y", ...imageSeq, "-i", job.inputPath, ...audioArgs, ...vf, ...vArgs, outFile], tracker);
    // Перебор энкодеров (software → hardware): QSV/NVENC могут числиться в
    // сборке, но не работать на машине (нет GPU / нет пакетов на выходе).
    const cands = await codecEncoderCandidates(ffmpeg, job.codec, job.crf, job.gpuFirst);
    if (!cands.length) throw new Error(`no_encoder_${job.codec}`);
    let encoded = false;
    for (const c of cands) {
      try {
        await tryEncode(c.args);
        encoded = true;
        break;
      } catch (e) {
        logger.warn("compressor.encoderFallback", { enc: c.enc, err: String(e.message || e).slice(0, 160) });
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
      }
    }
    if (!encoded) throw new Error(`no_working_encoder_${job.codec}`);

    job.outFile = outFile;
    job.outSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    job.progress = 100; job.etaSec = 0;
    job.done = true; job.stage = "done";
    // Длительность результата — для контроля целостности (лог/отладка).
    probeDuration(ffprobe, outFile).then((d) => { job.durationSec = d; logger.info("compressor.done", { id: job.id, size: job.outSize, codec: job.codec, crf: job.crf, steps: job.steps, durationSec: d }); });
  } catch (e) {
    job.error = String(e.message || e); job.stage = "error";
    logger.error("compressor.error", { id: job.id, error: job.error });
  } finally {
    // Очистка временных файлов: сегменты кадров, апскейл-кадры, вход и
    // промежуточник — и при успехе, и при ошибке (если включена cleanupTemp).
    if (cleanup) {
      for (const p of tmpDirs) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
      try { fs.rmSync(job.inputPath, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(DIRS.compressorOut, `ds_${stamp}.mp4`), { force: true }); } catch { /* ignore */ }
    }
  }
}

function getJob(id) { return jobs.get(id) || null; }

module.exports = { jobs, startJob, getJob, probeDuration, probeVideoInfo, runFfmpeg, codecEncoderCandidates, findRealesrgan };

