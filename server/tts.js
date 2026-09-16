"use strict";

/**
 * Аудиокнижный TTS-движок (F5-TTS + Coqui XTTS v2), v2.
 *
 * Архитектура:
 *  - Движки — персистентные python-сайдкары (JSON-lines через stdin/stdout):
 *    server/engines/f5_wrapper.py и server/engines/xtts_wrapper.py.
 *    Модель загружается один раз на задание, чанки приходят по конвейеру —
 *    между чанками strict GC (torch.cuda.empty_cache) в том же процессе.
 *  - Железо: nvidia-smi → имя GPU, total VRAM, used, утилизация (для
 *    VRAM-монитора и «[Optimal for Your PC]» бейджей UI).
 *  - Задание: массив чанков (уже отредактированных в UI) + полный набор
 *    параметров. По чанкам: инференс → FFmpeg-конкатенация с кроссфейдом и
 *    паузами → EBU R128 (−16 LUFS) → mp3/wav/m4b с главами.
 *  - Пресеты: системные + пользовательские (presets.json).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const settings = require("./settings");
const logger = require("./logger");
const { DIRS } = require("../server/config");
const { detectFfmpeg } = require("./convertEngine");
const ruNlp = require("./ruNlp");
const { createQueue, trimJobs } = require("./jobStore");
const { removeOlderThan } = require("./fsUtil");

const jobs = new Map();
const JOB_LIMIT = 30;
const TTL_MS = 24 * 60 * 60 * 1000;

/* ------------- Очередь (одно задание на GPU): server/ts/jobStore.ts ------------ */

const queue = createQueue("tts");

/* ------------------------- TTL-чистка storage/tts ------------------------- */
/* (server/ts/fsUtil.ts): profiles.json и presets.json — пользовательские
   данные, их не трогаем; остальное — папки заданий старше суток. */

removeOlderThan({ dir: DIRS.tts, ttlMs: TTL_MS, keep: ["profiles.json", "presets.json"] });

/* ------------------------- Железо: GPU / VRAM ------------------------- */

let hwCache = null,
  hwAt = 0;

function round1(x) {
  return Math.round(x * 10) / 10;
}

// «Оптимально для вашего ПК»: рекомендации под конкретный GPU (для бейджей UI).
function buildOptimal(gpuName, totalMb) {
  const vram = totalMb / 1024;
  const isNvidia = /nvidia|geforce|rtx|gtx/i.test(gpuName);
  const smallVram = vram > 0 && vram <= 8;
  return {
    precision: smallVram ? "float16" : "bfloat16",
    precisionReason: smallVram ? `FP16 для ${vram.toFixed(0)}GB VRAM` : "BF16 для вашей карты",
    nfe: "32-48",
    cfg: "2.0-2.5",
    attention: "sdpa",
    temperature: "0.65-0.75",
    repetitionPenalty: "3.5-5.0",
    topP: "0.85",
    crossFadeMs: "50-100",
    sentencePauseMs: 400,
    paragraphPauseMs: 1200,
    loudnessTarget: -16,
    speed: 1.0,
    solver: "euler",
    isNvidia,
    vram,
  };
}

function detectHardware() {
  return new Promise((resolve) => {
    if (hwCache && Date.now() - hwAt < 15000) return resolve(hwCache);
    const child = spawn(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    // stderr читаем и игнорируем: nvidia-smi шумит предупреждениями, но код
    // возврата и stdout достаточно для решения «GPU есть / fallback».
    child.stderr.on("data", () => {
      /* диагностика движка не нужна */
    });
    child.on("error", () => {
      hwCache = hwFallback();
      hwAt = Date.now();
      resolve(hwCache);
    });
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) {
        hwCache = hwFallback();
        hwAt = Date.now();
        return resolve(hwCache);
      }
      const [name, total, used, util, driver] = out
        .trim()
        .split(",")
        .map((s) => s.trim());
      const totalGb = Number(total) / 1024;
      hwCache = {
        gpu: {
          found: true,
          name: name || "NVIDIA GPU",
          vramTotalGb: round1(totalGb),
          vramUsedGb: round1(Number(used) / 1024),
          utilPct: Number(util) || 0,
          driver: driver || "",
        },
        cpu: { name: os.cpus()[0]?.model || "", cores: os.cpus().length },
        platform: process.platform,
        optimal: buildOptimal(name, totalMbToNumber(total)),
      };
      hwAt = Date.now();
      resolve(hwCache);
    });
    function hwFallback() {
      return {
        gpu: {
          found: false,
          name: "CPU / нет NVIDIA GPU",
          vramTotalGb: 0,
          vramUsedGb: 0,
          utilPct: 0,
          driver: "",
        },
        cpu: { name: os.cpus()[0]?.model || "", cores: os.cpus().length },
        platform: process.platform,
        optimal: buildOptimal("", 0),
      };
    }
    function totalMbToNumber(v) {
      return Number(v) || 0;
    }
  });
}

/* ------------------------- Профили голоса ------------------------- */

const PROFILES_FILE = path.join(DIRS.tts, "profiles.json");

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveProfiles(list) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), "utf8");
}

function saveProfile(p) {
  const refFile = String(p.refFile || "").replace(/^.*[\\/]/, "");
  if (refFile && !/^ref_[A-Za-z0-9._-]+$/.test(refFile)) throw new Error("invalid refFile");
  if (refFile && !fs.existsSync(path.join(DIRS.tts, refFile))) throw new Error("refFile not found");
  const list = loadProfiles();
  const profile = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(p.name || "voice").slice(0, 60),
    refFile,
    engine: p.engine === "xtts" ? "xtts" : "f5",
    language: p.language === undefined ? undefined : String(p.language).slice(0, 40),
    createdAt: Date.now(),
  };
  if (!profile.language) delete profile.language;
  list.push(profile);
  saveProfiles(list);
  return profile;
}

function deleteProfile(id) {
  const list = loadProfiles();
  const next = list.filter((p) => p.id !== id);
  saveProfiles(next);
  return next.length !== list.length;
}

/* ------------------------- Пресеты ------------------------- */

const BUILTIN_PRESETS = [
  {
    id: "sys-fiction-xtts",
    builtin: true,
    name: "Драматическая проза (XTTS v2)",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.72,
      repetitionPenalty: 4.0,
      topK: 50,
      topP: 0.85,
      speed: 1.0,
      crossFadeMs: 80,
      sentencePauseMs: 450,
      paragraphPauseMs: 1400,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 220,
      format: "m4b",
    },
  },
  {
    id: "sys-nonfiction-f5",
    builtin: true,
    name: "Нон-фикшн (F5-TTS быстро и чисто)",
    engine: "f5",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      nfe: 36,
      cfg: 2.2,
      solver: "euler",
      speed: 1.0,
      crossFadeMs: 60,
      sentencePauseMs: 400,
      paragraphPauseMs: 1200,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 380,
      format: "m4b",
    },
  },
  {
    id: "sys-dialogue",
    builtin: true,
    name: "Выразительные диалоги / актёрская игра",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.85,
      repetitionPenalty: 3.5,
      topK: 60,
      topP: 0.9,
      speed: 0.95,
      crossFadeMs: 100,
      sentencePauseMs: 600,
      paragraphPauseMs: 1500,
      loudnessTarget: -16,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 200,
      format: "mp3",
    },
  },
  {
    id: "sys-bedtime",
    builtin: true,
    name: "Сказка на ночь",
    engine: "xtts",
    params: {
      precision: "float16",
      attention: "sdpa",
      gcEveryChunks: 1,
      temperature: 0.65,
      repetitionPenalty: 5.0,
      topK: 40,
      topP: 0.8,
      speed: 0.85,
      crossFadeMs: 120,
      sentencePauseMs: 800,
      paragraphPauseMs: 2000,
      loudnessTarget: -18,
      expandNumbers: true,
      yoficate: true,
      markStress: true,
      chunkLimit: 200,
      format: "mp3",
    },
  },
];

const PRESETS_FILE = path.join(DIRS.tts, "presets.json");

function listPresets() {
  let user = [];
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    /* пусто */
  }
  return [...BUILTIN_PRESETS, ...user];
}

function saveUserPreset(preset) {
  let user = [];
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    /* пусто */
  }
  const item = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(preset.name || "preset").slice(0, 80),
    engine: preset.engine === "xtts" ? "xtts" : "f5",
    params: preset.params || {},
    refFile: String(preset.refFile || "").replace(/^.*[\\/]/, ""),
    builtin: false,
    createdAt: Date.now(),
  };
  user.push(item);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(user, null, 2), "utf8");
  return item;
}

function deleteUserPreset(id) {
  let user;
  try {
    user = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch {
    return false;
  }
  const next = user.filter((p) => p.id !== id);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next.length !== user.length;
}

/* ------------------------- Python-сайдкар ------------------------- */

// Персистентный процесс движка: модель в VRAM один раз, чанки по конвейеру.
class EngineSidecar {
  constructor(engineName) {
    this.engine = engineName === "xtts" ? "xtts" : "f5";
    this.script = path.join(
      __dirname,
      "engines",
      this.engine === "f5" ? "f5_wrapper.py" : "xtts_wrapper.py",
    );
    this.child = null;
    this.buffer = "";
    this.waiters = [];
  }

  _start() {
    const python = String(settings.get("voice")?.pythonCmd || "python");
    this.child = spawn(python, [this.script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      this.buffer += String(d);
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const w = this.waiters.shift();
          if (w) w(msg);
        } catch {
          /* мусорная строка из stderr-мусора в stdout */
        }
      }
    });
    this.child.stderr.on("data", (d) =>
      logger.info(`tts.${this.engine}.stderr`, { tail: String(d).slice(-400) }),
    );
    return this;
  }

  // Отправить запрос и дождаться next-сообщения (с таймаутом).
  ask(obj, timeoutMs = 3600000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode != null) return reject(new Error("sidecar_dead"));
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("sidecar_timeout"));
      }, timeoutMs);
      const w = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(w);
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    });
  }

  kill() {
    try {
      this.child?.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.child?.kill();
      } catch {
        /* ignore */
      }
    }, 500);
  }
}

/* ------------------------- Задание ------------------------- */

const ENGINE_CHUNK_LIMIT = { f5: 380, xtts: 220 };

function startJob(opts) {
  const id = crypto.randomBytes(6).toString("hex");
  const cfg = settings.get("voice") || {};
  // С1: refFile — только имя ref_* внутри storage/tts (клиент не доверенный).
  const refFile = String(opts.refFile || "").replace(/^.*[\\/]/, "");
  if (!/^ref_[A-Za-z0-9._-]+$/.test(refFile)) throw new Error("invalid_reference");
  if (!fs.existsSync(path.join(DIRS.tts, refFile))) throw new Error("reference_not_found");
  const engine = opts.engine === "xtts" ? "xtts" : "f5";

  // Чанки приходят готовыми из Batch Editor UI; если их нет — режем на сервере.
  let items =
    Array.isArray(opts.chunks) && opts.chunks.length
      ? opts.chunks
          .map((c) => (typeof c === "string" ? { text: c } : c))
          .filter((c) => c.text || c.pauseMs)
      : ruNlp.chunkText(ruNlp.normalize(opts.text || "", opts), ENGINE_CHUNK_LIMIT[engine]);
  items = items.slice(0, 4000);
  if (!items.length) throw new Error("empty_text");

  const job = {
    id,
    engine,
    stage: "queued",
    progress: 0,
    chunkIndex: 0,
    chunksTotal: items.length,
    error: "",
    done: false,
    outFile: "",
    outSize: 0,
    createdAt: Date.now(),
    vram: null,
    items,
    // Грубая оценка длительности для глав: ~75 знаков/мин чтения вслух ≈ 80 мс/симв.
    estimateTotalMs: Math.max(
      1000,
      items.reduce((s, i) => s + (i.text?.length || 0), 0) * 80 +
        items.reduce((s, i) => s + (i.pauseMs || 0), 0),
    ),
    opts: {
      refFile,
      language: opts.language || cfg.defaultLanguage || "ru",
      // Глобальные
      precision: ["float16", "bfloat16", "float32", "int8"].includes(opts.precision)
        ? opts.precision
        : "float16",
      attention: ["sdpa", "flash", "eager"].includes(opts.attention) ? opts.attention : "sdpa",
      gcEveryChunks: Math.max(1, Number(opts.gcEveryChunks) || 1),
      // F5
      nfe: Math.max(16, Math.min(100, Number(opts.nfe) || 32)),
      cfg: Math.max(1.0, Math.min(10.0, Number(opts.cfg) || 2.2)),
      solver: ["euler", "midpoint", "rk4"].includes(opts.solver) ? opts.solver : "euler",
      exaggeration: Math.max(0.5, Math.min(2.0, Number(opts.exaggeration) || 1.0)),
      // XTTS
      temperature: Math.max(0.01, Math.min(1.5, Number(opts.temperature) || 0.7)),
      repetitionPenalty: Math.max(1.0, Math.min(15.0, Number(opts.repetitionPenalty) || 3.5)),
      topK: Math.max(1, Math.min(100, Number(opts.topK) || 50)),
      topP: Math.max(0.05, Math.min(1.0, Number(opts.topP) || 0.85)),
      // Общие
      speed: Math.max(0.5, Math.min(2.0, Number(opts.speed) || 1.0)),
      crossFadeMs: Math.max(0, Math.min(500, Number(opts.crossFadeMs) || 60)),
      sentencePauseMs: Math.max(100, Math.min(1500, Number(opts.sentencePauseMs) || 400)),
      paragraphPauseMs: Math.max(500, Math.min(3000, Number(opts.paragraphPauseMs) || 1200)),
      loudnessTarget: Math.max(-24, Math.min(-10, Number(opts.loudnessTarget) || -16)),
      format: ["mp3", "wav", "m4b"].includes(opts.format) ? opts.format : "mp3",
      title: String(opts.title || "Audiobook").slice(0, 120),
      author: String(opts.author || "").slice(0, 120),
      coverImage: typeof opts.coverImage === "string" ? opts.coverImage.slice(0, 3_000_000) : null,
      // NLP-опции (для серверного чанкинга если чанков не прислали)
      expandNumbers: opts.expandNumbers !== false,
      yoficate: opts.yoficate !== false,
      markStress: !!opts.markStress,
    },
  };
  jobs.set(id, job);
  trimJobs(jobs, JOB_LIMIT);
  queue.enqueue(() => runPipeline(job));
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

/* ------------------------- Пайплайн ------------------------- */

function spawnFFmpeg(args) {
  return new Promise((resolve, reject) => {
    detectFfmpeg()
      .then(({ ffmpeg }) => {
        if (!ffmpeg) return reject(new Error("ffmpeg_missing"));
        const child = spawn(ffmpeg, args, { windowsHide: true });
        let errTail = "";
        child.stderr.on("data", (d) => {
          errTail = (errTail + String(d)).slice(-3000);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errTail.slice(-200)}`)),
        );
      })
      .catch(reject);
  });
}

async function runPipeline(job) {
  try {
    const cfg = job.opts;
    const sidecar = new EngineSidecar(job.engine)._start();
    const chunkDir = path.join(DIRS.tts, job.id);
    fs.mkdirSync(chunkDir, { recursive: true });
    job.stage = "model_load";
    job.progress = 2;

    // init: модель в VRAM один раз на всё задание
    const ready = await sidecar.ask(
      {
        type: "init",
        precision: cfg.precision,
        attention: cfg.attention,
        solver: cfg.solver,
        speed: cfg.speed,
        vramBudgetGb: 4.5,
        gcEveryChunks: cfg.gcEveryChunks,
      },
      600000,
    );
    if (ready.type === "error") throw new Error(ready.message);

    job.stage = "infer";
    const refPath = path.join(DIRS.tts, cfg.refFile);
    const wavs = [];

    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      if (item.pauseMs && !item.text) continue; // чистая пауза — на этапе склейки
      const wav = path.join(chunkDir, `chunk_${String(wavs.length).padStart(4, "0")}.wav`);
      const msg = await sidecar.ask(
        {
          type: "infer",
          ref: refPath,
          text: item.text,
          out: wav,
          cfg: cfg.cfg,
          nfe: cfg.nfe,
          exaggeration: cfg.exaggeration,
          temperature: cfg.temperature,
          repetitionPenalty: cfg.repetitionPenalty,
          topK: cfg.topK,
          topP: cfg.topP,
          speed: cfg.speed,
          language: cfg.language,
        },
        600000,
      );
      if (msg.type === "error") throw new Error(msg.message);
      job.chunkIndex = i;
      job.progress = Math.round((85 * (i + 1)) / job.items.length);
      if (msg.type === "vram") job.vram = msg;
      wavs.push({ wav, pauseMs: item.pauseMs || 0 });
    }
    if (!wavs.length) throw new Error("empty_result");
    sidecar.kill();

    // --- Склейка: паузы (anullsrc) + кроссфейд между чанками ---
    job.stage = "stitch";
    job.progress = 88;
    const stitched = path.join(chunkDir, "stitched.wav");
    await stitchWavs(
      wavs.map((w) => w.wav),
      wavs.map((w) => w.pauseMs),
      cfg.crossFadeMs,
      stitched,
    );

    // --- EBU R128 мастеринг + финальный формат ---
    job.stage = "master";
    job.progress = 94;
    const loudnorm = `loudnorm=I=${cfg.loudnessTarget}:TP=-1.5:LRA=11`;
    const outFile = path.join(DIRS.tts, `audiobook_${job.id}.${cfg.format}`);
    const tags = ["-metadata", `title=${cfg.title}`, "-metadata", `artist=${cfg.author}`];
    if (cfg.format === "wav") {
      await spawnFFmpeg([
        "-y",
        "-i",
        stitched,
        "-af",
        loudnorm,
        "-c:a",
        "pcm_s16le",
        ...tags,
        outFile,
      ]);
    } else {
      // MP3 (id3v2) / M4B (AAC): главы через ffmetadata; фолбэк — без глав.
      const metaFile = path.join(chunkDir, "meta.txt");
      fs.writeFileSync(metaFile, buildFfmetadata(job), "utf8");
      const codec =
        cfg.format === "m4b"
          ? ["-c:a", "aac", "-b:a", "128k"]
          : ["-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3"];
      await spawnFFmpeg([
        "-y",
        "-i",
        stitched,
        "-i",
        metaFile,
        "-map_metadata",
        "1",
        "-af",
        loudnorm,
        ...codec,
        ...tags,
        outFile,
      ]).catch(async () => {
        await spawnFFmpeg(["-y", "-i", stitched, "-af", loudnorm, ...codec, ...tags, outFile]);
      });
    }

    // Чанки больше не нужны
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(outFile)) throw new Error("render_no_output");

    job.outFile = outFile;
    job.outSize = fs.statSync(outFile).size;
    job.progress = 100;
    job.done = true;
    job.stage = "done";
    logger.info("tts.done", { id: job.id, chunks: job.items.length, size: job.outSize });
  } catch (e) {
    job.error = String(e.message || e);
    job.stage = "error";
    logger.error("tts.error", { id: job.id, error: job.error });
  }
}

// Склейка с паузами и кроссфейдом.
async function stitchWavs(wavs, pauses, crossFadeMs, outFile) {
  const n = wavs.length;
  if (n === 1) {
    await spawnFFmpeg(["-y", "-i", wavs[0], outFile]);
    return;
  }
  const hasPauses = pauses.some((p) => p > 0);
  if (!hasPauses) {
    const inputs = wavs.flatMap((w) => ["-i", w]);
    let fc = "",
      prev = "0:a";
    const d = (crossFadeMs / 1000).toFixed(3);
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? "out" : `a${i}`;
      fc += `[${prev}][${i}:a]acrossfade=d=${d}:c1=tri:c2=tri[${out}];`;
      prev = out;
    }
    await spawnFFmpeg(["-y", ...inputs, "-filter_complex", fc, "-map", "[out]", outFile]);
    return;
  }
  // С паузами: anullsrc-вставки между чанками + concat.
  const inputs = [];
  const concatParts = [];
  let inputIdx = 0;
  wavs.forEach((w, i) => {
    inputs.push("-i", w);
    concatParts.push(`[${inputIdx}:a]`);
    inputIdx++;
    if (pauses[i] > 0) {
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=24000:cl=mono:d=${(pauses[i] / 1000).toFixed(3)}`,
      );
      concatParts.push(`[${inputIdx}:a]`);
      inputIdx++;
    }
  });
  const fc = `${concatParts.join("")}concat=n=${concatParts.length}:v=0:a=1[out]`;
  await spawnFFmpeg(["-y", ...inputs, "-filter_complex", fc, "-map", "[out]", outFile]);
}

// ffmetadata с главами (для M4B / MP3). Длительность — оценка из счётчика чанков.
function buildFfmetadata(job) {
  const cfg = job.opts;
  let t = ";FFMETADATA1\n";
  t += `title=${cfg.title}\n`;
  if (cfg.author) t += `artist=${cfg.author}\n`;
  const textChunks = job.items.filter((i) => i.text).length;
  const perChunkMs = Math.max(
    1000,
    (job.estimateTotalMs || textChunks * 12000) / Math.max(1, textChunks),
  );
  const groupsPerChapter = Math.max(1, Math.ceil(textChunks / 50));
  let start = 0;
  for (let g = 0; g * groupsPerChapter < textChunks; g++) {
    const count = Math.min(groupsPerChapter, textChunks - g * groupsPerChapter);
    const end = start + count * perChunkMs;
    t += "\n[CHAPTER]\nTIMEBASE=1/1000\n";
    t += `START=${Math.round(start)}\nEND=${Math.round(end)}\n`;
    t += `title=Часть ${g + 1}\n`;
    start = end;
  }
  return t;
}

/* ------------------------- Preview / NLP / Reveal ------------------------- */

// Предпросмотр чанков без генерации (для Batch Editor UI).
function previewChunks(text, engine, nlpOpts) {
  const e = engine === "xtts" ? "xtts" : "f5";
  const normalized = ruNlp.normalize(text, nlpOpts || {});
  return ruNlp.chunkText(normalized, ENGINE_CHUNK_LIMIT[e]);
}

function revealInExplorer(filePath) {
  const p = String(filePath || "");
  if (!p.startsWith(DIRS.tts) || p.includes("..")) throw new Error("forbidden_path");
  if (process.platform === "win32") {
    spawn("explorer", ["/select,", p], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", p], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [path.dirname(p)], { detached: true, stdio: "ignore" }).unref();
  }
  return true;
}

module.exports = {
  startJob,
  getJob,
  detectHardware,
  previewChunks,
  revealInExplorer,
  saveProfile,
  deleteProfile,
  loadProfiles,
  listPresets,
  saveUserPreset,
  deleteUserPreset,
};
