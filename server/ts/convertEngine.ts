/**
 * Движок конвертации файлов.
 *
 * Вместо стороннего ConvertX (который требовал вендоренного рантайма Bun
 * и внешних CLI) конвертация выполняется через FFmpeg прямо в приложении.
 * FFmpeg берётся в PATH либо по пути из настроек (settings.json →
 * converter.ffmpegPath). При первом запуске ничего не качается — всё локально.
 *
 * TS-исходник, как server/ts/downloads.ts: компилируется в server/convertEngine.js
 * командой `npm run compile:server`, поэтому `require("./convertEngine")` из
 * routes/convert.js, routes/compressor.js, compressor.js, encoders.js, sitebak.js
 * и tts.js продолжает работать с теми же именами.
 */
import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import settings from "./settings";
import logger from "./logger";
import config from "./config";
import { downloadToFile } from "./download";

const { DIRS } = config;

/* ------------ Формат-каталог: что во что можно перегонять ------------ */

/** Категория форматов: что принимаем на входе и что умеем отдавать. */
export interface ConvertCategory {
  id: string;
  inputs: string[];
  outputs: string[];
}

export const CATEGORIES: ConvertCategory[] = [
  {
    id: "video",
    inputs: [
      "mp4",
      "mkv",
      "avi",
      "mov",
      "webm",
      "flv",
      "wmv",
      "m4v",
      "ts",
      "mpeg",
      "mpg",
      "gif",
      "3gp",
    ],
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
/** Расширение файла без точки, в нижнем регистре. */
export function extOf(name: unknown): string {
  return path
    .extname(String(name || ""))
    .toLowerCase()
    .replace(/^\./, "");
}

/** Категория определяется по расширению. → объект категории или null. */
export function categoryOf(name: unknown): ConvertCategory | null {
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
function ffmpegCandidates(): string[] {
  const cfg = (settings.get("converter") || {}) as { ffmpegPath?: string };
  const explicit = String(cfg.ffmpegPath || "").trim();
  const list: string[] = [];
  if (explicit) {
    list.push(explicit);
    if (!path.extname(explicit)) list.push(explicit + ".exe");
  }
  list.push(BUNDLED_BIN);
  // Локальная установка «как скачалось»: storage/ffmpeg/**/ffmpeg.exe. Архив с
  // gyan.dev распаковывается в ffmpeg-<версия>-essentials_build/bin/, поэтому
  // ищем вглубь (до 3 уровней): иначе получается «FFmpeg лежит в storage, а
  // приложение его не видит» — ровно тот случай, когда бинарь просто в подпапке.
  list.push(...findBinsDeep(BIN_DIR));
  list.push("ffmpeg");
  return list;
}

/** Насколько вглубь storage/ffmpeg смотрим (сам архив и его распаковка). */
const BIN_MAX_DEPTH = 3;

/** Рекурсивный поиск ffmpeg внутри storage/ffmpeg (файл проверяет вызывающий). */
function findBinsDeep(dir: string, depth = 0): string[] {
  if (depth > BIN_MAX_DEPTH) return [];
  const want = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findBinsDeep(p, depth + 1));
    else if (e.name.toLowerCase() === want.toLowerCase()) out.push(p);
  }
  return out;
}

/** Где именно искали ffmpeg: показываем в UI, если не нашли (куда класть бинарь). */
export function ffmpegSearchPaths(): string[] {
  return ffmpegCandidates();
}

// ffmpeg.exe/ffprobe.exe переносятся из распакованной папки в BIN_DIR.
function finalizeBins(srcDir: string): number {
  let moved = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^ff(mpeg|probe)\.exe$/i.test(e.name)) {
        try {
          fs.copyFileSync(p, path.join(BIN_DIR, e.name));
          moved++;
        } catch (err) {
          logger.warn("ffmpeg.install.copy_failed", {
            name: e.name,
            error: (err as Error).message,
          });
        }
      }
    }
  };
  walk(srcDir);
  return moved;
}
/** Результат поиска бинаря: found=false — рабочих путей нет. */
export interface FfmpegInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}

// Кэш на 12 сек — настройки могут меняться, но каждый раз вызывать exec дорого.
let detectCache: FfmpegInfo | null = null;
let detectAt = 0;

function runVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        ["-version"],
        { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = String(stdout || "").split(/[\r\n]/)[0] || "";
          const m = line.match(/ffmpeg version\s+([^\s]+)/i);
          resolve((m && m[1]) || line.trim() || "unknown");
        },
      );
    } catch {
      // Windows: файл лежит в storage/ffmpeg, но не является запускаемым (обрывок
      // загрузки, пустая заглушка) — spawn бросает синхронно «spawn UNKNOWN».
      // Такой кандидат просто пропускаем, а не роняем определение целиком.
      resolve(null);
    }
  });
}

// Проверка любого CLI-бинаря (ffmpeg/ffprobe) на работоспособность.
function runVersionAny(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        ["-version"],
        { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || "").split(/[\r\n]/)[0] || "unknown"),
      );
    } catch {
      // Та же ловушка Windows, что и в runVersion: битый файл → spawn бросает.
      resolve(null);
    }
  });
}

// Находится рабочий бинарь ffmpeg (+ ffprobe рядом). →
// { found, path, version, ffmpeg, ffprobe } — поля ffmpeg/ffprobe содержат
// готовые пути (их ждут compressor.js/tts.js/sitebak.js).
export async function detectFfmpeg({
  force = false,
}: { force?: boolean } = {}): Promise<FfmpegInfo> {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;

  let result: FfmpegInfo = { found: false, path: null, version: null, ffmpeg: null, ffprobe: null };
  for (const cmd of ffmpegCandidates()) {
    // Для явного пути / локальной установки проверяется наличие файла,
    // иначе подхватывается из PATH.
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const version = await runVersion(cmd);
    if (version) {
      // ffprobe ищется рядом с найденным ffmpeg, затем в PATH.
      const probeNext = path.join(
        path.dirname(cmd),
        /^win/i.test(process.platform) ? "ffprobe.exe" : "ffprobe",
      );
      const probeCandidates = [probeNext, "ffprobe"];
      let ffprobe: string | null = null;
      for (const p of probeCandidates) {
        if (p.includes("/") || p.includes("\\") ? fs.existsSync(p) : true) {
          const pv = await runVersionAny(p);
          if (pv) {
            ffprobe = p;
            break;
          }
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
/** Отчёт для UI: готовность движка + доступные категории/форматы. */
export interface ConvertTools {
  ready: boolean;
  ffmpeg: FfmpegInfo;
  categories: ConvertCategory[];
}

/** Полный отчёт для UI: готовность + категории/форматы. */
export async function tools(): Promise<ConvertTools> {
  const ff = await detectFfmpeg();
  return {
    ready: ff.found,
    ffmpeg: ff,
    categories: CATEGORIES.map(({ id, inputs, outputs }) => ({ id, inputs, outputs })),
  };
}

// --- Собственно FFmpeg ---

// Доп. аргументы кодека/качества под целевой формат.
function codecArgs(to: string): string[] {
  switch (to) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2"];
    case "m4a":
    case "aac":
      return ["-c:a", "aac"];
    case "ogg":
      return ["-c:a", "libvorbis"];
    case "opus":
      return ["-c:a", "libopus"];
    case "webm":
      return ["-c:v", "libvpx", "-c:a", "libvorbis"];
    case "gif":
      return ["-f", "gif"];
    default:
      return [];
  }
}

function runFfmpeg(bin: string, inputPath: string, outPath: string, to: string): Promise<void> {
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
      },
    );
  });
}

// Конвертация входного файла в outPath (формат определяется расширением).
// {@code to} — целевое расширение без точки.
export async function convert({
  inputPath,
  to,
  outPath,
}: {
  inputPath: string;
  to: string;
  outPath: string;
}): Promise<{ size: number }> {
  const ff = await detectFfmpeg({ force: detectCache?.found === false });
  if (!ff.found) throw new Error("ffmpeg not found");

  logger.info("convert.start", { to });
  const started = Date.now();
  await runFfmpeg(ff.path as string, inputPath, outPath, to);

  if (!fs.existsSync(outPath)) throw new Error("no output produced");
  const size = fs.statSync(outPath).size;
  logger.info("convert.done", { to, size, ms: Date.now() - started });
  return { size };
}
// --- Тихая установка FFmpeg ---

/** Состояние тихой установки. */
export interface InstallState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
}

// Состояние установки (за раз только один инстанс).
let installState: InstallState = { state: "idle", progress: 0, phase: "", error: "" };

/** Состояние + факт, что локальный бинарь уже лежит. */
export function installStatus(): InstallState & { installed: boolean } {
  return { ...installState, installed: fs.existsSync(BUNDLED_BIN) };
}

function unpackWithTar(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // tar (libarchive) на Windows 10+ тихо распаковывает zip.
    const child = spawn("tar", ["-xf", zipPath, "-C", destDir], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
    });
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
export function installFfmpeg(): InstallState {
  if (installState.state === "working") return installState;

  installState = { state: "working", progress: 0, phase: "download", error: "" };

  const workDir = path.join(DIRS.storage, "ffmpeg");
  const zipPath = path.join(workDir, "ffmpeg.zip");
  const srcDir = path.join(workDir, "_src");

  void (async () => {
    fs.mkdirSync(workDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    try {
      // --- Скачивание с прогрессом (общий потоковый загрузчик) ---
      installState.phase = "download";
      await downloadToFile(FFMPEG_URL, zipPath, {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        headers: { Accept: "*/*" },
        maxBytes: FFMPEG_MAX_BYTES,
        httpErrorText: (status: number) => `HTTP ${status} при скачивании FFmpeg`,
        tooLargeText: () => "FFmpeg-архив подозрительно большой",
        interruptedPrefix: "Загрузка прервана: ",
        onProgress: ({ total, received }) => {
          installState.progress = total ? Math.min(100, Math.round((100 * received) / total)) : 0;
        },
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
      installState = { state: "error", progress: 0, phase: "", error: (e as Error).message };
      logger.error("ffmpeg.install.error", { error: (e as Error).message });
    }
  })();

  return installState;
}
