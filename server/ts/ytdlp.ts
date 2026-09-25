import { execFile, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import settings from "./settings";
import logger from "./logger";
import * as proxy from "./proxy";
import type { InstallState, InstallStatus } from "./proxy";
import config from "./config";
import { downloadToFile } from "./download";

const { DIRS } = config;

/** Результат поиска ffmpeg: версия для UI не нужна. */
interface FfmpegBin {
  found: boolean;
  path: string | null;
}

/** Результат поиска yt-dlp: path и version (null — бинарь не найден). */
export interface YtdlpBin {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** Формат из yt-dlp, урезанный до полей, которые показывает UI. */
export interface VideoFormat {
  format_id: string;
  ext: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  note: string;
  filesize: number | null;
  tbr: number | null;
}

/** Сырой формат из JSON yt-dlp: полей десятки, значения приводим сами. */
interface RawFormat {
  format_id?: unknown;
  ext?: unknown;
  height?: unknown;
  width?: unknown;
  fps?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  format_note?: unknown;
  filesize?: unknown;
  tbr?: unknown;
}

/** Сырой ответ yt-dlp -J (мета видео или элемент поиска). */
interface RawInfo {
  formats?: RawFormat[];
  subtitles?: Record<string, { ext?: unknown }[]>;
  automatic_captions?: Record<string, { ext?: unknown }[]>;
  title?: unknown;
  webpage_url?: unknown;
  duration?: unknown;
  duration_string?: unknown;
  thumbnail?: unknown;
  is_live?: unknown;
  entries?: RawInfo[];
  extractor?: unknown;
  id?: unknown;
  artist?: unknown;
  uploader?: unknown;
  creator?: unknown;
  url?: unknown;
}

/** Мета видео для панели загрузки (sanitizeInfo). */
export interface VideoInfo {
  title: string;
  webUrl: string;
  duration: number | null;
  durationString: string;
  thumbnail: string | null;
  formats: VideoFormat[];
  heights: number[];
  subtitles: Record<string, unknown[]>;
  autoCaptions: Record<string, unknown[]>;
  isLive: boolean;
}

/** Найденный трек для страницы музыки (sanitizeTrack). */
export interface Track {
  id: string;
  title: string;
  artist: string;
  duration: number | null;
  durationString: string;
  thumbnail: string | null;
  webpageUrl: string;
}

/** Скачанный файл джобы. */
export interface JobFile {
  path: string;
  name: string;
  size?: number;
}

/** Джоба скачивания (JOBS): UI опрашивает её состояние. */
interface DownloadJob {
  id: string;
  url: string;
  title: string;
  token: string;
  state: "running" | "done" | "error";
  progress: number;
  error: string;
  stderrBuf: string;
  outDir: string;
  files: JobFile[];
  child?: ChildProcess;
}

/** Статус джобы для UI (jobStatus): при found=false остальные поля не приходят. */
export interface JobStatus {
  found?: boolean;
  id?: string;
  state?: string;
  progress?: number;
  error?: string;
  files?: { name: string; size?: number; key: string }[];
}

/** Аргументы старта видеозагрузки (приходят из тела запроса). */
interface StartDownloadArgs {
  url: string;
  info: VideoInfo;
  height?: number;
  container?: string;
  subs?: string[] | null;
  thumb?: { embed?: boolean } | null;
  proxyUrl?: string | null;
}

/** Аргументы старта аудиозагрузки (страница музыки). */
interface StartAudioArgs {
  url: string;
  format?: string;
  quality?: number;
  proxyUrl?: string | null;
}

// --- FFmpeg (нужен для слияния DASH) ---

const FFMPEG_BIN_DIR = path.join(DIRS.storage, "ffmpeg");
const BUNDLED_FFMPEG = path.join(FFMPEG_BIN_DIR, "ffmpeg.exe");

let ffmpegCache: FfmpegBin | null = null;
let ffmpegAt = 0;

function ffmpegCandidates(): string[] {
  const cfg = (settings.get("converter") || {}) as { ffmpegPath?: unknown };
  const explicit = String(cfg.ffmpegPath || "").trim();
  const list = [];
  if (explicit) {
    list.push(explicit);
    if (!path.extname(explicit)) list.push(explicit + ".exe");
  }
  list.push(BUNDLED_FFMPEG);
  list.push("ffmpeg");
  return list;
}

function runFfmpegVersion(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      bin,
      ["-version"],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout || "").split(/[\r\n]+/)[0] || "unknown");
      },
    );
  });
}

async function detectFfmpeg(): Promise<FfmpegBin> {
  const now = Date.now();
  if (ffmpegCache && now - ffmpegAt < 12000) return ffmpegCache;
  let result: FfmpegBin = { found: false, path: null };
  for (const cmd of ffmpegCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const ver = await runFfmpegVersion(cmd);
    if (ver) {
      result = { found: true, path: cmd };
      break;
    }
  }
  ffmpegCache = result;
  ffmpegAt = now;
  return result;
}
// --- Бинарь yt-dlp ---

const BIN_DIR = path.join(DIRS.storage, "ytdlp");
const BUNDLED_BIN = path.join(BIN_DIR, "yt-dlp.exe");
// Бинарь из комплекта инсталлятора: server/vendor/ytdlp/yt-dlp.exe
// (в собранной сборке — app.asar.unpacked, см. build.asarUnpack).
const VENDOR_BIN = config.vendorPath("ytdlp", "yt-dlp.exe");
// Официальный портативный exe (PyInstaller), на машине не нужен Python.
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_MAX_BYTES = 300 * 1024 * 1024;

let detectCache: YtdlpBin | null = null;
let detectAt = 0;

function ytdlpCandidates(): string[] {
  const cfg = (settings.get("media") || {}) as { ytdlpPath?: unknown };
  const explicit = String(cfg.ytdlpPath || "").trim();
  const list = [];
  if (explicit) {
    list.push(explicit);
    if (!path.extname(explicit)) list.push(explicit + ".exe");
  }
  list.push(BUNDLED_BIN);
  list.push(VENDOR_BIN);
  list.push("yt-dlp");
  return list;
}

function runVersion(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      bin,
      ["--version"],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout || "").trim() || "unknown");
      },
    );
  });
}

// Находится рабочий yt-dlp. → { found, path, version }.
async function detectYtDlp({ force = false }: { force?: boolean } = {}): Promise<YtdlpBin> {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;
  let result: YtdlpBin = { found: false, path: null, version: null };
  for (const cmd of ytdlpCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const version = await runVersion(cmd);
    if (version) {
      result = { found: true, path: cmd, version };
      break;
    }
  }
  detectCache = result;
  detectAt = now;
  return result;
}

// Финальный resolve (без кэша) — чтобы запустить дочерний процесс.
async function resolvedBin(): Promise<string> {
  const d = await detectYtDlp({ force: true });
  if (!d.found || !d.path) throw new Error("yt-dlp not found");
  return d.path;
}
// --- Парсинг форматов ---

// Гигантские структуры режутся до нужных UI-полей.
function sanitizeInfo(info: RawInfo): VideoInfo {
  // Значения из чужого JSON приводим к типам UI (undefined уходит в null):
  // поля уходят в JSON-ответ, где undefined не переживает сериализацию.
  const formats: VideoFormat[] = (info.formats || [])
    .filter((f) => f && (f.vcodec !== "none" || f.acodec !== "none"))
    .map((f) => ({
      format_id: f.format_id ? String(f.format_id) : "",
      ext: f.ext ? String(f.ext) : "",
      height: f.height ? Number(f.height) : null,
      width: f.width ? Number(f.width) : null,
      fps: f.fps ? Number(f.fps) : null,
      vcodec: f.vcodec === "none" ? null : f.vcodec ? String(f.vcodec) : null,
      acodec: f.acodec === "none" ? null : f.acodec ? String(f.acodec) : null,
      note: f.format_note ? String(f.format_note) : "",
      filesize: f.filesize ? Number(f.filesize) : null,
      tbr: f.tbr ? Number(f.tbr) : null,
    }));

  // Уникальные разрешения (только видео-ряды), от макс к мин.
  const heights = [...new Set(formats.map((f) => f.height).filter((h): h is number => !!h))].sort(
    (a, b) => b - a,
  );

  const subtitles = info.subtitles || {};
  const subs: Record<string, unknown[]> = {};
  for (const lang of Object.keys(subtitles)) subs[lang] = (subtitles[lang] || []).map((x) => x.ext);
  const captions = info.automatic_captions || {};
  const auto: Record<string, unknown[]> = {};
  for (const lang of Object.keys(captions)) auto[lang] = (captions[lang] || []).map((x) => x.ext);

  return {
    title: info.title ? String(info.title) : "Untitled",
    webUrl: info.webpage_url ? String(info.webpage_url) : "",
    duration: info.duration ? Number(info.duration) : null,
    durationString: info.duration_string ? String(info.duration_string) : "",
    thumbnail: info.thumbnail ? String(info.thumbnail) : null,
    formats,
    heights,
    subtitles: subs,
    autoCaptions: auto,
    isLive: !!info.is_live,
  };
}

/** Транзиентные сетевые/TLS-сбои (обрыв соединения, битый TLS-рекорд от
 * нестабильной сети/VPN и т.п.) — имеет смысл повторить попытку, в отличие
 * от смысловых ошибок вроде "Unsupported URL" или "Video unavailable". */
function isTransientNetworkError(msg: string): boolean {
  return /SSL|DECRYPTION_FAILED|bad record mac|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|Connection reset|Temporary failure/i.test(
    msg,
  );
}

function runJsonOnce(bin: string, url: string, proxyUrl?: string | null): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      "-J",
      "--no-playlist",
      "--ignore-config",
      "--no-warnings",
      "--socket-timeout",
      "30",
    ];
    if (proxyUrl) args.push("--proxy", proxyUrl);
    args.push("--", url);
    execFile(
      bin,
      args,
      { timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = meaningfulStderr(stderr || err.message);
          return reject(new Error(msg || err.message));
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

/** До 2 повторов с паузой при транзиентных сетевых/TLS-сбоях (например
 * SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC на нестабильном соединении) —
 * такие ошибки обычно проходят со второй попытки, без вмешательства юзера. */
async function runJson(bin: string, url: string, proxyUrl?: string | null): Promise<string> {
  const attempts = 3;
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runJsonOnce(bin, url, proxyUrl);
    } catch (e) {
      lastErr = e as Error;
      if (i < attempts - 1 && isTransientNetworkError(lastErr.message)) {
        logger.warn("ytdlp.runJson.retry", { attempt: i + 1, error: lastErr.message });
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("yt-dlp failed");
}

/**
 * yt-dlp подмешивает в stderr предупреждения (в т.ч. про deprecated-опции и
 * ссылку на issue), из-за которых настоящая строка «ERROR: …» терялась в хвосте.
 * Оставляем только содержательные строки. Заодно «Unsupported URL» превращаем в
 * понятный пользователю код.
 */
function meaningfulStderr(raw: unknown): string {
  const lines = String(raw || "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const filtered = lines.filter(
    (l) =>
      !/^Deprecated Feature:/i.test(l) &&
      !/deprecated/i.test(l) &&
      !/issues\/14198/.test(l) &&
      !/Please remove them/i.test(l) &&
      l !== "ERROR:",
  );
  const list = (filtered.length ? filtered : lines).slice(-5);
  return list.join(" · ");
}

// Достаётся мета и список форматов по URL.
async function fetchInfo(url: string, proxyUrl?: string | null): Promise<VideoInfo> {
  const d = await detectYtDlp();
  if (!d.found || !d.path) throw new Error("yt-dlp not found");
  const stdout = await runJson(d.path, url, proxyUrl);
  return sanitizeInfo(JSON.parse(stdout) as RawInfo);
}

// Селектор формата. Используются проверенные селекторы yt-dlp:
//  - bestvideo[height<=?T]+bestaudio — DASH (отдельные video+audio), авто-слияние
//  - best[height<=?T] — прогрессивный (всё в одном)
function planFormat(formats: VideoFormat[], height?: number) {
  const t = height && height > 0 ? height : 9999;
  // Сначала пробуется прогрессивный (видео+аудио вместе)
  const progressive = formats
    .filter((f) => f.vcodec && f.acodec && (!f.height || f.height <= t))
    .sort((a, b) => (a.height || 0) - (b.height || 0));
  const chosen = progressive[progressive.length - 1];
  if (chosen) return { format: `best[height<=?${t}]`, needsMerge: false, container: chosen.ext };
  // Если прогрессивного нет → DASH: bestvideo + bestaudio, yt-dlp сам склеивает через ffmpeg
  return {
    format: `bestvideo[height<=?${t}]+bestaudio/best[height<=?${t}]`,
    needsMerge: true,
    container: "mp4",
  };
}
// --- Скачивание ---

const JOBS = new Map<string, DownloadJob>(); // jobId -> job
const FILES = new Map<string, { path: string; name: string }>(); // fileKey -> { path, name }

function parseProgress(job: DownloadJob, buf: unknown): void {
  const s = String(buf ?? "");
  const m = /\[download\]\s+([\d.]+)%/.exec(s);
  if (m) job.progress = Math.min(100, parseFloat(m[1]) || 0);
}

function scanOutFiles(job: DownloadJob): void {
  let list: string[];
  try {
    list = fs.readdirSync(job.outDir);
  } catch {
    return;
  }
  const prefix = job.token + ".";
  for (const name of list) {
    if (!name.startsWith(prefix)) continue;
    const fp = path.join(job.outDir, name);
    try {
      const size = fs.statSync(fp).size || 0;
      if (!job.files.some((f) => f.path === fp)) job.files.push({ path: fp, name, size });
    } catch {
      /* skip */
    }
  }
}

function finalizeJob(job: DownloadJob, state: "done" | "error", error?: string): void {
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
function safeFilename(s: unknown): string {
  return (
    String(s || "video")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "video"
  );
}

/** Переименовывает файлы джобы из токен-имён в название видео. */
function renameJobFiles(job: DownloadJob): void {
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
      logger.warn("video.job.rename_failed", { name: f.name, error: (e as Error).message });
    }
  }
}

function registerFiles(job: DownloadJob): { name: string; size?: number; key: string }[] {
  scanOutFiles(job);
  return (job.files || []).map((f) => {
    const key = crypto.randomBytes(6).toString("hex");
    FILES.set(key, { path: f.path, name: f.name });
    return { name: f.name, size: f.size, key };
  });
}
function startDownload({
  url,
  info,
  height,
  container,
  subs,
  thumb,
  proxyUrl,
}: StartDownloadArgs): { id: string } {
  const jobId = crypto.randomBytes(6).toString("hex");
  const token = `pa_${jobId}`;
  const outDir = DIRS.downloads;
  const outTemplate = path.join(outDir, `${token}.%(ext)s`);

  const plan = planFormat(info.formats, height);
  const wantEmbed = thumb && thumb.embed;

  // Юзер выбрал контейнер — берётся он, иначе fallback на MP4.
  const containerOut =
    container && /^(mp4|mkv|webm)$/i.test(container)
      ? container.toLowerCase()
      : plan.container || "mp4";
  const needsMerge = plan.needsMerge || wantEmbed || containerOut !== (plan.container || "mp4");

  const args = [
    "--no-playlist",
    "--ignore-config",
    "--no-warnings",
    "--no-update",
    "--socket-timeout",
    "30",
    "--newline",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--restrict-filenames",
    "-o",
    outTemplate,
  ];
  // proxyUrl из per-page решения (req.proxyUrl); undefined → старое поведение.
  const effProxy = proxyUrl !== undefined ? proxyUrl : proxy.getProxyUrl();
  if (effProxy) args.push("--proxy", effProxy);
  if (subs && subs.length)
    args.push("--write-subs", "--sub-langs", subs.join(","), "--sub-format", "best");
  if (thumb) args.push(wantEmbed ? "--embed-thumbnail" : "--write-thumbnail");
  if (needsMerge) args.push("--merge-output-format", containerOut);
  // С9: "--" перед URL — URL вида "-o…" не будет истолкован как опция.
  args.push("--format", plan.format, "--", url);

  const job: DownloadJob = {
    id: jobId,
    url,
    title: info.title || "",
    token,
    state: "running",
    progress: 0,
    error: "",
    stderrBuf: "",
    outDir,
    files: [],
  };
  JOBS.set(jobId, job);

  resolvedBin()
    .then(async (bin) => {
      // ffmpeg ищется — он нужен yt-dlp для слияния DASH video+audio
      const ffmpeg = await detectFfmpeg();
      const spawnArgs = [...args];
      if (ffmpeg.found && ffmpeg.path) {
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
            const errMsg = meaningfulStderr(job.stderrBuf) || `yt-dlp exited with code ${code}`;
            finalizeJob(job, "error", errMsg);
          }
        }
      });
    })
    .catch((e) => {
      const jr = JOBS.get(jobId);
      if (jr) finalizeJob(jr, "error", e.message);
    });

  return { id: jobId };
}

function jobStatus(jobId: string): JobStatus {
  const j = JOBS.get(jobId);
  if (!j) return { found: false };
  return {
    id: j.id,
    state: j.state,
    progress: j.progress,
    error: j.error,
    files: j.state === "done" ? registerFiles(j) : [],
  };
}

function getDownloadFile(key: string): { path: string; name: string } | null {
  const entry = FILES.get(key);
  if (!entry) return null;
  FILES.delete(key);
  return entry;
}

// --- Тихая установка yt-dlp ---

let installState: InstallState = { state: "idle", progress: 0, phase: "", error: "" };

function installStatus(): InstallStatus {
  return { ...installState, installed: fs.existsSync(BUNDLED_BIN) || fs.existsSync(VENDOR_BIN) };
}

function installYtDlp(): InstallState {
  if (installState.state === "working") return installState;
  installState = { state: "working", progress: 0, phase: "download", error: "" };
  const dlFile = path.join(BIN_DIR, "yt-dlp.exe");
  fs.mkdirSync(BIN_DIR, { recursive: true });
  (async () => {
    try {
      installState.phase = "download";
      await downloadToFile(YTDLP_URL, dlFile, {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        headers: { Accept: "*/*" },
        maxBytes: YTDLP_MAX_BYTES,
        httpErrorText: (status) => `HTTP ${status}`,
        tooLargeText: () => "yt-dlp подозрительно большой",
        interruptedPrefix: "Загрузка прервана: ",
        onProgress: ({ total, received }) => {
          installState.progress = total ? Math.min(100, Math.round((100 * received) / total)) : 0;
        },
      });
      detectCache = null;
      installState = { state: "done", progress: 100, phase: "", error: "" };
      logger.info("ytdlp.install.done", { path: BUNDLED_BIN });
    } catch (e) {
      installState = { state: "error", progress: 0, phase: "", error: (e as Error).message };
      logger.error("ytdlp.install.error", { error: (e as Error).message });
    }
  })();
  return installState;
}

// --- Поиск музыки (через ytsearch:) ---

function sanitizeTrack(entry: RawInfo): Track {
  return {
    id: entry.id ? String(entry.id) : "",
    title: entry.title ? String(entry.title) : "Untitled",
    artist: entry.artist
      ? String(entry.artist)
      : entry.uploader
        ? String(entry.uploader)
        : entry.creator
          ? String(entry.creator)
          : "Unknown",
    duration: entry.duration ? Number(entry.duration) : null,
    durationString: entry.duration_string ? String(entry.duration_string) : "",
    thumbnail: entry.thumbnail ? String(entry.thumbnail) : null,
    webpageUrl: entry.webpage_url ? String(entry.webpage_url) : entry.url ? String(entry.url) : "",
  };
}

async function searchTracks(
  query: string,
  limit = 15,
  proxyUrl?: string | null,
): Promise<{ tracks: Track[]; source: string }> {
  const d = await detectYtDlp();
  if (!d.found || !d.path) throw new Error("yt-dlp not found");
  const searchUrl = `ytsearch${limit}:${query}`;
  const stdout = await runJson(d.path, searchUrl, proxyUrl);
  const data = JSON.parse(stdout) as RawInfo;
  const entries = data.entries || [data];
  const tracks = entries.filter((e) => e && e.title).map(sanitizeTrack);
  return { tracks, source: data.extractor ? String(data.extractor) : "youtube" };
}

// --- Скачивание аудио (через --extract-audio) ---

const AUDIO_FORMATS: string[] = ["mp3", "m4a", "flac", "opus", "wav"];
// quality: 0 = best (VBR ~320kbps для mp3), 9 = worst
const FORMAT_QUALITY_MAP: Record<string, { format: string; quality: number }> = {
  "320 kbps": { format: "mp3", quality: 0 },
  "256 kbps": { format: "m4a", quality: 0 },
  "192 kbps": { format: "mp3", quality: 3 },
  "128 kbps": { format: "mp3", quality: 5 },
  FLAC: { format: "flac", quality: 0 },
  OPUS: { format: "opus", quality: 0 },
  WAV: { format: "wav", quality: 0 },
  AAC: { format: "m4a", quality: 1 },
};

function startAudioDownload({ url, format = "mp3", quality = 0, proxyUrl }: StartAudioArgs): {
  id: string;
} {
  const jobId = crypto.randomBytes(6).toString("hex");
  const token = `pa_${jobId}`;
  const outDir = DIRS.downloads;
  const outTemplate = path.join(outDir, `${token}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--ignore-config",
    "--no-warnings",
    "--no-update",
    "--socket-timeout",
    "30",
    "--newline",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--restrict-filenames",
    "-o",
    outTemplate,
    "--extract-audio",
    "--audio-format",
    format,
    "--audio-quality",
    String(quality),
    "--embed-thumbnail",
    "--add-metadata",
    "--no-embed-subs",
    url,
  ];
  const effProxy = proxyUrl !== undefined ? proxyUrl : proxy.getProxyUrl();
  if (effProxy) args.push("--proxy", effProxy);
  args.push("--", url); // С9: URL после end-of-options

  const job: DownloadJob = {
    id: jobId,
    url,
    title: "",
    token,
    state: "running",
    progress: 0,
    error: "",
    stderrBuf: "",
    outDir,
    files: [],
  };
  JOBS.set(jobId, job);

  resolvedBin()
    .then(async (bin) => {
      const ffmpeg = await detectFfmpeg();
      const spawnArgs = [...args];
      if (ffmpeg.found && ffmpeg.path) {
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
            const errMsg =
              job.stderrBuf
                .split(/[\\r\\n]+/)
                .filter(Boolean)
                .slice(-5)
                .join(" · ") || `yt-dlp exited with code ${code}`;
            finalizeJob(job, "error", errMsg);
          }
        }
      });
    })
    .catch((e) => {
      const jr = JOBS.get(jobId);
      if (jr) finalizeJob(jr, "error", e.message);
    });

  return { id: jobId };
}

export {
  BUNDLED_BIN,
  YTDLP_URL,
  YTDLP_MAX_BYTES,
  detectYtDlp,
  fetchInfo,
  startDownload,
  jobStatus,
  installStatus,
  installYtDlp,
  FILES,
  getDownloadFile,
  searchTracks,
  startAudioDownload,
  AUDIO_FORMATS,
  FORMAT_QUALITY_MAP,
};
