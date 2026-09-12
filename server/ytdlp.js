"use strict";

/**
 * Движок загрузки видео через yt-dlp (https://github.com/yt-dlp/yt-dlp).
 *
 * Работает с большинством сайтов: YouTube, Twitter/X, TikTok, Instagram,
 * Reddit, Twitch и т.д. Фильтрации доменов нет — принимается любой https-URL.
 * Для слияния раздельных video+audio (DASH) нужен ffmpeg (его умеет ставить
 * конвертер). yt-dlp берётся в PATH, из settings.media.ytdlpPath или локально
 * из storage/ytdlp/ (портативный exe без Python); может быть установлен из GitHub.
 */

const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const logger = require("./logger");
const proxy = require("./proxy");
const { DIRS } = require("./config");

// --- FFmpeg (нужен для слияния DASH) ---

const FFMPEG_BIN_DIR = path.join(DIRS.storage, "ffmpeg");
const BUNDLED_FFMPEG = path.join(FFMPEG_BIN_DIR, "ffmpeg.exe");

let ffmpegCache = null;
let ffmpegAt = 0;

function ffmpegCandidates() {
  const cfg = settings.get("converter") || {};
  const explicit = String(cfg.ffmpegPath || "").trim();
  const list = [];
  if (explicit) { list.push(explicit); if (!path.extname(explicit)) list.push(explicit + ".exe"); }
  list.push(BUNDLED_FFMPEG);
  list.push("ffmpeg");
  return list;
}

function runFfmpegVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["-version"], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || "").split(/[\r\n]+/)[0] || "unknown");
    });
  });
}

async function detectFfmpeg() {
  const now = Date.now();
  if (ffmpegCache && now - ffmpegAt < 12000) return ffmpegCache;
  let result = { found: false, path: null };
  for (const cmd of ffmpegCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) { if (!fs.existsSync(cmd)) continue; }
    const ver = await runFfmpegVersion(cmd);
    if (ver) { result = { found: true, path: cmd }; break; }
  }
  ffmpegCache = result;
  ffmpegAt = now;
  return result;
}
// --- Бинарь yt-dlp ---

const BIN_DIR = path.join(DIRS.storage, "ytdlp");
const BUNDLED_BIN = path.join(BIN_DIR, "yt-dlp.exe");
// Официальный портативный exe (PyInstaller), на машине не нужен Python.
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_MAX_BYTES = 300 * 1024 * 1024;

let detectCache = null;
let detectAt = 0;

function ytdlpCandidates() {
  const cfg = settings.get("media") || {};
  const explicit = String(cfg.ytdlpPath || "").trim();
  const list = [];
  if (explicit) {
    list.push(explicit);
    if (!path.extname(explicit)) list.push(explicit + ".exe");
  }
  list.push(BUNDLED_BIN);
  list.push("yt-dlp");
  return list;
}

function runVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || "").trim() || "unknown");
    });
  });
}

// Находится рабочий yt-dlp. → { found, path, version }.
async function detectYtDlp({ force = false } = {}) {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;
  let result = { found: false, path: null, version: null };
  for (const cmd of ytdlpCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const version = await runVersion(cmd);
    if (version) { result = { found: true, path: cmd, version }; break; }
  }
  detectCache = result;
  detectAt = now;
  return result;
}

// Финальный resolve (без кэша) — чтобы запустить дочерний процесс.
async function resolvedBin() {
  const d = await detectYtDlp({ force: true });
  if (!d.found) throw new Error("yt-dlp not found");
  return d.path;
}
// --- Парсинг форматов ---

// Гигантские структуры режутся до нужных UI-полей.
function sanitizeInfo(info) {
  const formats = (info.formats || [])
    .filter((f) => f && (f.vcodec !== "none" || f.acodec !== "none"))
    .map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      height: f.height || null,
      width: f.width || null,
      fps: f.fps || null,
      vcodec: f.vcodec === "none" ? null : f.vcodec,
      acodec: f.acodec === "none" ? null : f.acodec,
      note: f.format_note || "",
      filesize: f.filesize || null,
      tbr: f.tbr || null,
    }));

  // Уникальные разрешения (только видео-ряды), от макс к мин.
  const heights = [...new Set(formats.filter((f) => f.height).map((f) => f.height))].sort((a, b) => b - a);

  const subs = {};
  for (const lang of Object.keys(info.subtitles || {})) subs[lang] = (info.subtitles[lang] || []).map((x) => x.ext);
  const auto = {};
  for (const lang of Object.keys(info.automatic_captions || {})) auto[lang] = (info.automatic_captions[lang] || []).map((x) => x.ext);

  return {
    title: info.title || "Untitled",
    webUrl: info.webpage_url || "",
    duration: info.duration || null,
    durationString: info.duration_string || "",
    thumbnail: info.thumbnail || null,
    formats,
    heights,
    subtitles: subs,
    autoCaptions: auto,
    isLive: !!info.is_live,
  };
}

function runJson(bin, url) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-J", "--no-playlist", "--ignore-config", "--no-warnings", "--no-call-home", "--", url],
      { timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).split(/[\r\n]/).filter(Boolean).slice(-4).join(" ");
          return reject(new Error(msg || err.message));
        }
        resolve(stdout);
      }
    );
  });
}

// Достаётся мета и список форматов по URL.
async function fetchInfo(url) {
  const d = await detectYtDlp();
  if (!d.found) throw new Error("yt-dlp not found");
  const stdout = await runJson(d.path, url);
  return sanitizeInfo(JSON.parse(stdout));
}

// Селектор формата. Используются проверенные селекторы yt-dlp:
//  - bestvideo[height<=?T]+bestaudio — DASH (отдельные video+audio), авто-слияние
//  - best[height<=?T] — прогрессивный (всё в одном)
function planFormat(formats, height) {
  const t = height > 0 ? height : 9999;
  // Сначала пробуется прогрессивный (видео+аудио вместе)
  const progressive = formats
    .filter((f) => f.vcodec && f.acodec && (!f.height || f.height <= t))
    .sort((a, b) => (a.height || 0) - (b.height || 0));
  const chosen = progressive[progressive.length - 1];
  if (chosen) return { format: `best[height<=?${t}]`, needsMerge: false, container: chosen.ext };
  // Если прогрессивного нет → DASH: bestvideo + bestaudio, yt-dlp сам склеивает через ffmpeg
  return { format: `bestvideo[height<=?${t}]+bestaudio/best[height<=?${t}]`, needsMerge: true, container: "mp4" };
}
// --- Скачивание ---

const JOBS = new Map();  // jobId -> job
const FILES = new Map(); // fileKey -> { path, name }

function parseProgress(job, buf) {
  const s = buf.toString();
  const m = /\[download\]\s+([\d.]+)%/.exec(s);
  if (m) job.progress = Math.min(100, parseFloat(m[1]) || 0);
}

function scanOutFiles(job) {
  let list;
  try { list = fs.readdirSync(job.outDir); } catch { return; }
  const prefix = job.token + ".";
  for (const name of list) {
    if (!name.startsWith(prefix)) continue;
    const fp = path.join(job.outDir, name);
    try {
      const size = fs.statSync(fp).size || 0;
      if (!job.files.some((f) => f.path === fp)) job.files.push({ path: fp, name, size });
    } catch { /* skip */ }
  }
}

function finalizeJob(job, state, error) {
  if (job.state !== "running") return;
  job.state = state;
  if (error) job.error = error;
  if (state === "done") {
    job.progress = 100;
    // Файлы сканируются, потом переименовываются в название видео
    scanOutFiles(job);
    renameJobFiles(job);
  }
  logger.info("video.job." + state, { id: job.id, error: error || "" });
}

/** Санитизирует строку для безопасного имени файла на Windows. */
function safeFilename(s) {
  return String(s || "video")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "video";
}

/** Переименовывает файлы джобы из токен-имён в название видео. */
function renameJobFiles(job) {
  if (!job.title) return;
  const base = safeFilename(job.title);
  for (const f of job.files) {
    const ext = path.extname(f.name);
    const newName = `${base}${ext}`;
    const newPath = path.join(job.outDir, newName);
    // Такое имя уже есть — дописывается timestamp
    const finalPath = fs.existsSync(newPath)
      ? path.join(job.outDir, `${base}_${Date.now()}${ext}`)
      : newPath;
    try {
      fs.renameSync(f.path, finalPath);
      logger.info("video.job.rename", { from: f.name, to: path.basename(finalPath) });
      f.path = finalPath;
      f.name = path.basename(finalPath);
    } catch (e) {
      logger.warn("video.job.rename_failed", { name: f.name, error: e.message });
    }
  }
}

function registerFiles(job) {
  scanOutFiles(job);
  return (job.files || []).map((f) => {
    const key = crypto.randomBytes(6).toString("hex");
    FILES.set(key, { path: f.path, name: f.name });
    return { name: f.name, size: f.size, key };
  });
}
function startDownload({ url, info, height, container, subs, thumb }) {
  const jobId = crypto.randomBytes(6).toString("hex");
  const token = `pa_${jobId}`;
  const outDir = DIRS.downloads;
  const outTemplate = path.join(outDir, `${token}.%(ext)s`);

  const plan = planFormat(info.formats, height);
  const wantEmbed = thumb && thumb.embed;

  // Юзер выбрал контейнер — берётся он, иначе fallback на MP4.
  const containerOut = (container && /^(mp4|mkv|webm)$/i.test(container))
    ? container.toLowerCase() : plan.container || "mp4";
  const needsMerge = plan.needsMerge || wantEmbed || containerOut !== (plan.container || "mp4");

  const args = [
    "--no-playlist", "--ignore-config", "--no-warnings", "--no-call-home", "--no-update",
    "--newline", "--retries", "3", "--fragment-retries", "3",
    "--restrict-filenames", "-o", outTemplate,
  ];
  const proxyUrl = proxy.getProxyUrl();
  if (proxyUrl) args.push("--proxy", proxyUrl);
  if (subs && subs.length) args.push("--write-subs", "--sub-langs", subs.join(","), "--sub-format", "best");
  if (thumb) args.push(wantEmbed ? "--embed-thumbnail" : "--write-thumbnail");
  if (needsMerge) args.push("--merge-output-format", containerOut);
  // С9: "--" перед URL — URL вида "-o…" не будет истолкован как опция.
  args.push("--format", plan.format, "--", url);

  const job = { id: jobId, url, title: info.title || "", token, state: "running", progress: 0, error: "", stderrBuf: "", outDir, files: [] };
  JOBS.set(jobId, job);

  resolvedBin().then(async (bin) => {
    // ffmpeg ищется — он нужен yt-dlp для слияния DASH video+audio
    const ffmpeg = await detectFfmpeg();
    const spawnArgs = [...args];
    if (ffmpeg.found) {
      spawnArgs.splice(spawnArgs.indexOf("--format"), 0, "--ffmpeg-location", ffmpeg.path);
    }
    const child = spawn(bin, spawnArgs, { windowsHide: true });
    job.child = child;
    child.stdout.on("data", (d) => parseProgress(job, d));
    child.stderr.on("data", (d) => {
      parseProgress(job, d);
      job.stderrBuf += d.toString();
      // Хранятся только последние ~2000 символов
      if (job.stderrBuf.length > 4000) job.stderrBuf = job.stderrBuf.slice(-2000);
    });
    child.on("error", (e) => finalizeJob(job, "error", e.message));
    child.on("close", (code) => {
      if (job.state !== "error") {
        if (code === 0) finalizeJob(job, "done");
        else {
          const errMsg = job.stderrBuf.split(/[\r\n]+/).filter(Boolean).slice(-5).join(" · ") || `yt-dlp exited with code ${code}`;
          finalizeJob(job, "error", errMsg);
        }
      }
    });
  }).catch((e) => { const jr = JOBS.get(jobId); if (jr) finalizeJob(jr, "error", e.message); });

  return { id: jobId };
}

function jobStatus(jobId) {
  const j = JOBS.get(jobId);
  if (!j) return { found: false };
  return {
    id: j.id, state: j.state, progress: j.progress, error: j.error,
    files: j.state === "done" ? registerFiles(j) : [],
  };
}

function getDownloadFile(key) {
  const entry = FILES.get(key);
  if (!entry) return null;
  FILES.delete(key);
  return entry;
}

// --- Тихая установка yt-dlp ---

let installState = { state: "idle", progress: 0, phase: "", error: "" };

function installStatus() { return { ...installState, installed: fs.existsSync(BUNDLED_BIN) }; }

function installYtDlp() {
  if (installState.state === "working") return installState;
  installState = { state: "working", progress: 0, phase: "download", error: "" };
  const dlFile = path.join(BIN_DIR, "yt-dlp.exe");
  fs.mkdirSync(BIN_DIR, { recursive: true });
  (async () => {
    try {
      installState.phase = "download";
      const res = await fetch(YTDLP_URL, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", Accept: "*/*" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > YTDLP_MAX_BYTES) throw new Error("yt-dlp подозрительно большой");
      let received = 0;
      const ws = fs.createWriteStream(dlFile);
      ws.on("error", () => {});
      try {
        for await (const chunk of res.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buf.length;
          installState.progress = declared ? Math.min(100, Math.round((100 * received) / declared)) : 0;
          if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
        }
      } catch (e) { try { ws.destroy(); fs.rmSync(dlFile, { force: true }); } catch {} throw new Error(`Загрузка прервана: ${e.message}`); }
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
      detectCache = null;
      installState = { state: "done", progress: 100, phase: "", error: "" };
      logger.info("ytdlp.install.done", { path: BUNDLED_BIN });
    } catch (e) { installState = { state: "error", progress: 0, phase: "", error: e.message }; logger.error("ytdlp.install.error", { error: e.message }); }
  })();
  return installState;
}

// --- Поиск музыки (через ytsearch:) ---

function sanitizeTrack(entry) {
  return {
    id: entry.id || "",
    title: entry.title || "Untitled",
    artist: entry.artist || entry.uploader || entry.creator || "Unknown",
    duration: entry.duration || null,
    durationString: entry.duration_string || "",
    thumbnail: entry.thumbnail || null,
    webpageUrl: entry.webpage_url || entry.url || "",
  };
}

async function searchTracks(query, limit = 15) {
  const d = await detectYtDlp();
  if (!d.found) throw new Error("yt-dlp not found");
  const searchUrl = `ytsearch${limit}:${query}`;
  const stdout = await runJson(d.path, searchUrl);
  const data = JSON.parse(stdout);
  const entries = data.entries || [data];
  const tracks = entries.filter((e) => e && e.title).map(sanitizeTrack);
  return { tracks, source: data.extractor || "youtube" };
}

// --- Скачивание аудио (через --extract-audio) ---

const AUDIO_FORMATS = ["mp3", "m4a", "flac", "opus", "wav"];
// quality: 0 = best (VBR ~320kbps для mp3), 9 = worst
const FORMAT_QUALITY_MAP = {
  "320 kbps": { format: "mp3", quality: 0 },
  "256 kbps": { format: "m4a", quality: 0 },
  "192 kbps": { format: "mp3", quality: 3 },
  "128 kbps": { format: "mp3", quality: 5 },
  "FLAC":     { format: "flac", quality: 0 },
  "OPUS":     { format: "opus", quality: 0 },
  "WAV":      { format: "wav", quality: 0 },
  "AAC":      { format: "m4a", quality: 1 },
};

function startAudioDownload({ url, format = "mp3", quality = 0 }) {
  const jobId = crypto.randomBytes(6).toString("hex");
  const token = `pa_${jobId}`;
  const outDir = DIRS.downloads;
  const outTemplate = path.join(outDir, `${token}.%(ext)s`);

  const args = [
    "--no-playlist", "--ignore-config", "--no-warnings", "--no-call-home", "--no-update",
    "--newline", "--retries", "3", "--fragment-retries", "3",
    "--restrict-filenames", "-o", outTemplate,
    "--extract-audio",
    "--audio-format", format,
    "--audio-quality", String(quality),
    "--embed-thumbnail",
    "--add-metadata",
    "--no-embed-subs",
    url,
  ];
  const proxyUrl = proxy.getProxyUrl();
  if (proxyUrl) args.push("--proxy", proxyUrl);
  args.push("--", url); // С9: URL после end-of-options

  const job = { id: jobId, url, title: "", token, state: "running", progress: 0, error: "", stderrBuf: "", outDir, files: [] };
  JOBS.set(jobId, job);

  resolvedBin().then(async (bin) => {
    const ffmpeg = await detectFfmpeg();
    const spawnArgs = [...args];
    if (ffmpeg.found) {
      spawnArgs.splice(spawnArgs.indexOf("--no-playlist"), 0, "--ffmpeg-location", ffmpeg.path);
    }
    const child = spawn(bin, spawnArgs, { windowsHide: true });
    job.child = child;
    child.stdout.on("data", (d) => parseProgress(job, d));
    child.stderr.on("data", (d) => {
      parseProgress(job, d);
      job.stderrBuf += d.toString();
      if (job.stderrBuf.length > 4000) job.stderrBuf = job.stderrBuf.slice(-2000);
    });
    child.on("error", (e) => finalizeJob(job, "error", e.message));
    child.on("close", (code) => {
      if (job.state !== "error") {
        if (code === 0) finalizeJob(job, "done");
        else {
          const errMsg = job.stderrBuf.split(/[\\r\\n]+/).filter(Boolean).slice(-5).join(" · ") || `yt-dlp exited with code ${code}`;
          finalizeJob(job, "error", errMsg);
        }
      }
    });
  }).catch((e) => { const jr = JOBS.get(jobId); if (jr) finalizeJob(jr, "error", e.message); });

  return { id: jobId };
}

module.exports = {
  BUNDLED_BIN, YTDLP_URL, YTDLP_MAX_BYTES,
  detectYtDlp, fetchInfo, startDownload, jobStatus, installStatus, installYtDlp,
  FILES, getDownloadFile,
  searchTracks, startAudioDownload, AUDIO_FORMATS, FORMAT_QUALITY_MAP,
};