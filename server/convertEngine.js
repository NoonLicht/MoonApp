"use strict";

/**
 * Движок конвертации файлов.
 *
 * Вместо стороннего ConvertX (который требовал вендоренного рантайма Bun
 * и внешних CLI) конвертация выполняется через FFmpeg прямо в приложении.
 * FFmpeg берётся в PATH либо по пути из настроек (settings.json →
 * converter.ffmpegPath). При первом запуске ничего не качается — всё локально.
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const logger = require("./logger");
const { DIRS } = require("./config");

/* ------------ Формат-каталог: что во что можно перегонять ------------ */

const CATEGORIES = [
  {
    id: "video",
    inputs: ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "ts", "mpeg", "mpg", "gif", "3gp"],
    outputs: ["mp4", "webm", "mkv", "avi", "mov", "gif"],
  },
  {
    id: "audio",
    inputs: ["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "wma", "m4b", "aiff", "aif"],
    outputs: ["mp3", "wav", "flac", "ogg", "opus", "m4a"],
  },
  {
    id: "image",
    inputs: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"],
    outputs: ["png", "jpg", "webp", "gif", "bmp", "tiff"],
  },
];

// Расширение файла без точки, в нижнем регистре.
function extOf(name) {
  return path.extname(String(name || "")).toLowerCase().replace(/^\./, "");
}

// Категория определяется по расширению. → объект категории или null.
function categoryOf(name) {
  const e = extOf(name);
  return CATEGORIES.find((c) => c.inputs.includes(e)) || null;
}

// --- Поиск FFmpeg ---

// Сюда приложение само ставит FFmpeg (см. installFfmpeg ниже).
const BIN_DIR = path.join(DIRS.storage, "ffmpeg");
const BUNDLED_BIN = path.join(BIN_DIR, "ffmpeg.exe");
// Официальный стабильный release (essentials) с gyan.dev — он редиректит на GitHub.
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_MAX_BYTES = 300 * 1024 * 1024; // запас по размеру архива (~130 МБ)

// Где ищется ffmpeg: явный путь из настроек, локальный бинарь (в т.ч. в
// подпапках storage/ffmpeg — пользователь мог положить архив целиком), PATH.
function ffmpegCandidates() {
  const cfg = settings.get("converter") || {};
  const explicit = String(cfg.ffmpegPath || "").trim();
  const list = [];
  if (explicit) {
    list.push(explicit);
    if (!path.extname(explicit)) list.push(explicit + ".exe");
  }
  list.push(BUNDLED_BIN);
  // Локальная установка «как скачалось»: storage/ffmpeg/<что угодно>/ffmpeg.exe.
  try {
    if (fs.existsSync(BIN_DIR)) {
      for (const e of fs.readdirSync(BIN_DIR, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const p = path.join(BIN_DIR, e.name, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
          if (fs.existsSync(p)) list.push(p);
        }
      }
    }
  } catch { /* не критично */ }
  list.push("ffmpeg");
  return list;
}

// ffmpeg.exe/ffprobe.exe переносятся из распакованной папки в BIN_DIR.
function finalizeBins(srcDir) {
  let moved = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^ff(mpeg|probe)\.exe$/i.test(e.name)) {
        try {
          fs.copyFileSync(p, path.join(BIN_DIR, e.name));
          moved++;
        } catch (err) {
          logger.warn("ffmpeg.install.copy_failed", { name: e.name, error: err.message });
        }
      }
    }
  };
  walk(srcDir);
  return moved;
}

// Кэш на 12 сек — настройки могут меняться, но каждый раз вызывать exec дорого.
let detectCache = null;
let detectAt = 0;

function runVersion(cmd) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      ["-version"],
      { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || "").split(/[\r\n]/)[0] || "";
        const m = line.match(/ffmpeg version\s+([^\s]+)/i);
        resolve((m && m[1]) || line.trim() || "unknown");
      }
    );
  });
}

// Находится рабочий бинарь ffmpeg (+ ffprobe рядом). →
// { found, path, version, ffmpeg, ffprobe } — поля ffmpeg/ffprobe содержат
// готовые пути (их ждут compressor.js/tts.js/sitebak.js).
async function detectFfmpeg({ force = false } = {}) {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;

  let result = { found: false, path: null, version: null, ffmpeg: null, ffprobe: null };
  for (const cmd of ffmpegCandidates()) {
    // Для явного пути / локальной установки проверяется наличие файла,
    // иначе подхватывается из PATH.
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const version = await runVersion(cmd);
    if (version) {
      // ffprobe ищется рядом с найденным ffmpeg, затем в PATH.
      const probeNext = path.join(path.dirname(cmd), /^win/i.test(process.platform) ? "ffprobe.exe" : "ffprobe");
      const probeCandidates = [probeNext, "ffprobe"];
      let ffprobe = null;
      for (const p of probeCandidates) {
        if (p.includes("/") || p.includes("\\") ? fs.existsSync(p) : true) {
          const pv = await runVersionAny(p);
          if (pv) { ffprobe = p; break; }
        }
      }
      result = { found: true, path: cmd, version, ffmpeg: cmd, ffprobe };
      break;
    }
  }

  detectCache = result;
  detectAt = now;
  return result;
}

// Проверка любого CLI-бинаря (ffmpeg/ffprobe) на работоспособность.
function runVersionAny(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ["-version"], { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || "").split(/[\r\n]/)[0] || "unknown"));
  });
}

// Полный отчёт для UI: готовность + категории/форматы.
async function tools() {
  const ff = await detectFfmpeg();
  return {
    ready: ff.found,
    ffmpeg: ff,
    categories: CATEGORIES.map(({ id, inputs, outputs }) => ({ id, inputs, outputs })),
  };
}

// --- Собственно FFmpeg ---

// Доп. аргументы кодека/качества под целевой формат.
function codecArgs(to) {
  switch (to) {
    case "mp3": return ["-c:a", "libmp3lame", "-q:a", "2"];
    case "m4a":
    case "aac": return ["-c:a", "aac"];
    case "ogg": return ["-c:a", "libvorbis"];
    case "opus": return ["-c:a", "libopus"];
    case "webm": return ["-c:v", "libvpx", "-c:a", "libvorbis"];
    case "gif": return ["-f", "gif"];
    default: return [];
  }
}

function runFfmpeg(bin, inputPath, outPath, to) {
  const args = ["-hide_banner", "-y", "-i", inputPath, ...codecArgs(to), outPath];
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || stdout)
            .split(/[\r\n]/)
            .filter(Boolean)
            .slice(-5)
            .join("\n");
          return reject(new Error(tail || err.message));
        }
        resolve();
      }
    );
  });
}

// Конвертация входного файла в outPath (формат определяется расширением).
// {@code to} — целевое расширение без точки.
async function convert({ inputPath, to, outPath }) {
  const ff = await detectFfmpeg({ force: detectCache?.found === false });
  if (!ff.found) throw new Error("ffmpeg not found");

  logger.info("convert.start", { to });
  const started = Date.now();
  await runFfmpeg(ff.path, inputPath, outPath, to);

  if (!fs.existsSync(outPath)) throw new Error("no output produced");
  const size = fs.statSync(outPath).size;
  logger.info("convert.done", { to, size, ms: Date.now() - started });
  return { size };
}

// --- Тихая установка FFmpeg ---

// Состояние установки (за раз только один инстанс).
let installState = { state: "idle", progress: 0, phase: "", error: "" };

// Состояние + факт, что локальный бинарь уже лежит.
function installStatus() {
  return { ...installState, installed: fs.existsSync(BUNDLED_BIN) };
}

function unpackWithTar(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // tar (libarchive) на Windows 10+ тихо распаковывает zip.
    const child = spawn("tar", ["-xf", zipPath, "-C", destDir], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Тихая установка FFmpeg: стабильный build (gyan.dev) скачивается в хранилище,
 * распаковывается без админ-прав, ffmpeg.exe/ffprobe.exe кладутся в storage/ffmpeg/.
 * В PATH и системе ничего не меняется. Состояние — в installState,
 * UI опрашивает GET /api/convert/install.
 */
function installFfmpeg() {
  if (installState.state === "working") return installState;

  installState = { state: "working", progress: 0, phase: "download", error: "" };

  const workDir = path.join(DIRS.storage, "ffmpeg");
  const zipPath = path.join(workDir, "ffmpeg.zip");
  const srcDir = path.join(workDir, "_src");

  (async () => {
    fs.mkdirSync(workDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    try {
      // --- Скачивание с прогрессом ---
      installState.phase = "download";
      const res = await fetch(FFMPEG_URL, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
          Accept: "*/*",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании FFmpeg`);
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > FFMPEG_MAX_BYTES) throw new Error("FFmpeg-архив подозрительно большой");

      let received = 0;
      const ws = fs.createWriteStream(zipPath);
      ws.on("error", () => { /* ошибка записи обрабатывается ниже */ });
      // res.body — это веб-ReadableStream (у fetch нет .on/.pipe), поэтому for-await.
      try {
        for await (const chunk of res.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buf.length;
          installState.progress = declared ? Math.min(100, Math.round((100 * received) / declared)) : 0;
          if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
        }
      } catch (e) {
        try { ws.destroy(); fs.rmSync(zipPath, { force: true }); } catch {}
        throw new Error(`Загрузка прервана: ${e.message}`);
      }
      await new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()));
      });

      // --- Распаковка ---
      installState.phase = "extract";
      installState.progress = 100;
      fs.mkdirSync(srcDir, { recursive: true });
      await unpackWithTar(zipPath, srcDir);

      // --- Перенос бинарей ---
      const moved = finalizeBins(srcDir);
      if (moved < 1) throw new Error("В архиве не найден ffmpeg.exe");
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });

      // Кэш сбрасывается, чтобы приложение сразу подхватило новый бинарь.
      detectCache = null;
      installState = { state: "done", progress: 100, phase: "", error: "" };
      logger.info("ffmpeg.install.done", { path: BUNDLED_BIN });
    } catch (e) {
      installState = { state: "error", progress: 0, phase: "", error: e.message };
      logger.error("ffmpeg.install.error", { error: e.message });
    }
  })();

  return installState;
}

module.exports = {
  CATEGORIES, extOf, categoryOf, detectFfmpeg, tools, convert,
  installFfmpeg, installStatus,
};