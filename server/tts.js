"use strict";

/**
 * F5-TTS: движок генерации аудиокниг (zero-shot voice cloning).
 *
 * Как это работает:
 *  1. Текст режется на чанки ~chunkSize (настройки voice.chunkSize, 200–300)
 *     СТРОГО по знакам препинания (. ! ? ;) — предложения не рвутся.
 *  2. Каждый чанк прогоняется через F5-TTS CLI (python/f5-tts_infer) на GPU
 *     с референсом voice.wav. По умолчанию FP16 (~4.5 ГБ VRAM), NFE 32–48.
 *     После каждого чанка: torch.cuda.empty_cache() — защита от OOM.
 *  3. WAV-чанки склеиваются FFmpeg'ом с кроссфейдом 50 мс (acrossfade),
 *     затем применяется EBU R128 loudnorm (voice.loudnessTarget LUFS).
 *  4. Результат: финальный .mp3/.wav в storage/tts.
 *
 * Если F5-TTS не установлен — detect возвращает ok:false,
 * задание падает с ошибкой f5_not_installed (UI показывает подсказку).
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const settings = require("./settings");
const logger = require("./logger");
const { DIRS } = require("./config");
const { detectFfmpeg } = require("./convertEngine");

const jobs = new Map();
const JOB_LIMIT = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

// --- Очередь: одно активное задание на модуль (С5), остальные ждут ---
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
    .catch((e) => logger.error("tts.queue", { error: String(e) }))
    .finally(() => { active = false; pump(); });
}

// --- TTL-чистка осиротевших референсов/чанков при загрузке модуля (С6) ---
function cleanupOld() {
  try {
    if (!fs.existsSync(DIRS.tts)) return;
    for (const name of fs.readdirSync(DIRS.tts)) {
      const p = path.join(DIRS.tts, name);
      try {
        const st = fs.statSync(p);
        // profiles.json не трогаем; всё старше суток (референсы, папки чанков) — в утиль.
        if (name !== "profiles.json" && Date.now() - st.mtimeMs > TTL_MS) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch { /* занят — пропускаем */ }
    }
  } catch { /* не критично */ }
}
cleanupOld();

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


/* ------------------------- Профили голоса ------------------------- */

const PROFILES_FILE = path.join(DIRS.tts, "profiles.json");

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); }
  catch { return []; }
}

function saveProfiles(list) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), "utf8");
}

// Сохранение профиля: имя + референс (только имя файла внутри storage/tts —
// путь клиенту не доверяем, С1) + гиперпараметры (1-click reload).
function saveProfile(p) {
  const refFile = String(p.refFile || "").replace(/^.*[\\/]/, "");
  if (refFile && !/^ref_[A-Za-z0-9._\-]+$/.test(refFile)) {
    throw new Error("invalid refFile");
  }
  if (refFile && !fs.existsSync(path.join(DIRS.tts, refFile))) {
    throw new Error("refFile not found");
  }
  const list = loadProfiles();
  const profile = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(p.name || "voice").slice(0, 60),
    refFile,
    language: p.language === undefined ? undefined : String(p.language).slice(0, 40),
    exaggeration: Number(p.exaggeration) || 1.0,
    cfgWeight: Number(p.cfgWeight) || 2.0,
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

/* ------------------------- Детект F5-TTS ------------------------- */

// Доступность: явная команда из настроек (voice.f5Cmd), иначе f5-tts_infer
// из PATH, иначе python с установленной библиотекой f5_tts. Кэш на 60 сек.
let detectCache = null;
let detectAt = 0;

function detect() {
  return new Promise((resolve) => {
    if (detectCache && Date.now() - detectAt < 60000) return resolve(detectCache);
    const cfg = settings.get("voice") || {};
    const done = (r) => { detectCache = r; detectAt = Date.now(); resolve(r); };
    const tryRun = (cmd, args) => new Promise((ok) => {
      execFile(cmd, args, { timeout: 20000, windowsHide: true, maxBuffer: 512 * 1024 }, (err) => ok(!err));
    });
    (async () => {
      const explicit = String(cfg.f5Cmd || "").trim();
      if (explicit) {
        const ok = await tryRun(explicit, ["--help"]);
        return done({ ok, cmd: explicit, args: "cli", python: false });
      }
      if (await tryRun("f5-tts_infer", ["--help"])) {
        return done({ ok: true, cmd: "f5-tts_infer", args: "cli", python: false });
      }
      if (await tryRun("python", ["-c", "import f5_tts"])) {
        return done({ ok: true, cmd: "python", args: "module", python: true });
      }
      return done({ ok: false, error: "f5_not_installed", cmd: "", args: "", python: false });
    })();
  });
}

/* ------------------------- Чанкинг ------------------------- */

// Разбивка текста по знакам препинания (. ! ? ;) с целевым размером чанка.
// Предложение длиннее лимита целиком уходит в чанк; гигантские абзацы без
// знаков режутся по запятым/пробелам — посреди слова никогда не рвём.
function chunkText(text, target = 250) {
  const sentences = String(text || "").split(/(?<=[.!?;])\s+/).filter((s) => s.trim());
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > target + 50) {
      chunks.push(cur.trim());
      cur = s;
    } else if (!cur && s.length > target + 200) {
      let rest = s;
      while (rest.length > target + 200) {
        const comma = rest.lastIndexOf(",", target);
        const cut = comma > 0 ? comma : rest.lastIndexOf(" ", target);
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function deleteProfile(id) {
  const list = loadProfiles();
  const next = list.filter((p) => p.id !== id);
  saveProfiles(next);
  return next.length !== list.length;
}

/* ------------------------- Задание ------------------------- */

function startJob(opts) {
  const id = crypto.randomBytes(6).toString("hex");
  const cfg = settings.get("voice") || {};
  // С1: refPath принимает только имя ref_* внутри storage/tts — клиент не
  // может подсунуть произвольный путь файла в аргументы CLI.
  const refFile = String(opts.refPath || "").replace(/^.*[\\/]/, "");
  if (!/^ref_[A-Za-z0-9._\-]+$/.test(refFile)) throw new Error("invalid_reference");
  const refPath = path.join(DIRS.tts, refFile);
  if (!fs.existsSync(refPath)) throw new Error("reference_not_found");
  const job = {
    id, stage: "queued", progress: 0, chunkIndex: 0, chunksTotal: 0,
    error: "", done: false, outFile: "", outSize: 0, createdAt: Date.now(),
    opts: {
      refFile, text: opts.text,
      language: opts.language || cfg.defaultLanguage || "English",
      exaggeration: Number(opts.exaggeration ?? cfg.exaggeration ?? 1.0),
      cfgWeight: Number(opts.cfgWeight ?? cfg.cfgWeight ?? 2.0),
      format: opts.format === "wav" ? "wav" : "mp3",
    },
  };
  jobs.set(id, job);
  trimJobs();
  // Очередь (С5): TTS инференс тяжёлый — гоняем строго по одному заданию.
  enqueue(() => runPipeline(job));
  return job;
}

async function runPipeline(job) {
  try {
    const engine = await detect();
    if (!engine.ok) throw new Error("f5_not_installed");

    const cfg = settings.get("voice") || {};
    const precision = cfg.precision === "fp32" ? "float32" : "float16";
    const nfe = Math.max(32, Math.min(48, Number(cfg.nfeSteps) || 32));
    const chunks = chunkText(job.opts.text, Math.max(100, Math.min(400, Number(cfg.chunkSize) || 250)));
    job.chunksTotal = chunks.length;
    if (!chunks.length) throw new Error("empty_text");

    const { ffmpeg } = await detectFfmpeg();
    if (!ffmpeg) throw new Error("ffmpeg_missing");

    const chunkDir = path.join(DIRS.tts, job.id);
    fs.mkdirSync(chunkDir, { recursive: true });
    job.stage = "infer";

    // Гиперпараметры передаются через окружение: env не виден в списке
    // процессов (в отличие от argv) и читается python-обёрткой f5_wrapper.py,
    // которая вызывает f5_tts API напрямую (FP16, NFE, empty_cache после
    // каждого чанка В ТОМ ЖЕ процессе — это реально чистит VRAM).
    const env = {
      ...process.env,
      F5_PRECISION: precision,
      F5_EXAGGERATION: String(job.opts.exaggeration),
      F5_CFG: String(job.opts.cfgWeight),
      F5_NFE: String(nfe),
      F5_VRAM: String(Number(cfg.vramGb) || 4.5),
    };

    // --- Инференс по чанкам ---
    for (let i = 0; i < chunks.length; i++) {
      job.chunkIndex = i;
      job.progress = Math.round((80 * i) / chunks.length);
      const wav = path.join(chunkDir, `chunk_${String(i).padStart(4, "0")}.wav`);
      const textFile = path.join(chunkDir, `text_${String(i).padStart(4, "0")}.txt`);
      // Текст чанка идёт файлом: большие чанки ломают лимит argv на Windows.
      fs.writeFileSync(textFile, chunks[i], "utf8");
      env.F5_REF = job.opts.refFile ? path.join(DIRS.tts, job.opts.refFile) : job.opts.refPath;
      env.F5_OUT = wav;
      let args;
      if (engine.python) {
        // API-режим через обёртку: точный контроль precision/exagg/cfg/VRAM.
        args = [path.join(__dirname, "f5_wrapper.py")];
        env.F5_TEXT = chunks[i];
      } else {
        // CLI f5-tts_infer: флаги совместимы с реальным CLI (output_dir),
        // ref_text пуст — zero-shot без транскрипции.
        args = ["--model", "F5-TTS", "--ref_audio", env.F5_REF, "--gen_text", chunks[i],
                "--output_dir", chunkDir, "--output_file", path.basename(wav), "--nfe", String(nfe)];
      }
      await new Promise((resolve, reject) => {
        const child = spawn(engine.cmd, args, { windowsHide: true, env, cwd: __dirname });
        let errTail = "";
        child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-3000); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`f5 exit ${code}: ${errTail.slice(-200)}`)));
      });
      try { fs.rmSync(textFile, { force: true }); } catch { /* ignore */ }
      if (!fs.existsSync(wav)) throw new Error(`f5_no_output_chunk_${i}`);
    }
    // empty_cache() выполняет сама обёртка внутри python-процесса —
    // отдельный «python -c» чужой контекст CUDA чистить не может.

    // --- Склейка: цепочка acrossfade 50 мс (гасит щелчки на стыках) ---
    job.stage = "stitch"; job.progress = 90;
    const n = chunks.length;
    const stitched = path.join(chunkDir, "stitched.wav");
    const pad = (i) => String(i).padStart(4, "0");
    const inputs = chunks.flatMap((_, i) => ["-i", path.join(chunkDir, `chunk_${pad(i)}.wav`)]);
    let fc = "";
    let prev = "0:a";
    if (n === 1) {
      fc = "[0:a]anull[out]";
    } else {
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? "out" : `a${i}`;
        fc += `[${prev}][${i}:a]acrossfade=d=0.05:c1=tri:c2=tri[${out}];`;
        prev = out;
      }
    }
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-y", ...inputs, "-filter_complex", fc, "-map", "[out]", stitched], { windowsHide: true });
      let errTail = "";
      child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-3000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg stitch exit ${code}: ${errTail.slice(-200)}`)));
    });

    // --- EBU R128 нормализация + финальный формат ---
    job.stage = "normalize"; job.progress = 96;
    const lufs = Number(cfg.loudnessTarget) || -16;
    const outFile = path.join(DIRS.tts, `audiobook_${Date.now()}.${job.opts.format}`);
    const fmtArgs = job.opts.format === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "libmp3lame", "-b:a", "192k"];
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-y", "-i", stitched, "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, ...fmtArgs, outFile], { windowsHide: true });
      let errTail = "";
      child.stderr.on("data", (d) => { errTail = (errTail + String(d)).slice(-3000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg norm exit ${code}: ${errTail.slice(-200)}`)));
    });

    // Чанки больше не нужны — экономим место (папка задания целиком).
    try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch { /* ignore */ }

    job.outFile = outFile;
    job.outSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    job.progress = 100; job.done = true; job.stage = "done";
    logger.info("tts.done", { id: job.id, chunks: n, size: job.outSize });
  } catch (e) {
    job.error = String(e.message || e); job.stage = "error";
    logger.error("tts.error", { id: job.id, error: job.error });
  }
}

function getJob(id) { return jobs.get(id) || null; }

module.exports = { startJob, getJob, detect, chunkText, saveProfile, deleteProfile, loadProfiles };
