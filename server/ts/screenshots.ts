/**
 * Библиотека скриншотов и записей экрана страницы «Скриншоты»: единое
 * хранилище storage/screenshots — файлы (png/webm) + index.json с метаданными.
 * Раньше страница только скачивала файлы на диск пользователя (saveBlob) —
 * теперь они ещё и сохраняются в приложении, чтобы внизу страницы была
 * общая библиотека скриншотов и скринкастов с превью и плеером.
 */
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import { detectFfmpeg } from "./convertEngine";
import logger from "./logger";

const { DIRS, FILES } = config;

function probeDuration(ffprobeBin: string, file: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      ffprobeBin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        const n = Number(String(stdout || "").trim());
        resolve(!err && Number.isFinite(n) && n > 0 ? n : 0);
      },
    );
  });
}

/**
 * Перегоняет сырую запись MediaRecorder (webm: VP9/VP8/AV1 + Opus — то, что
 * реально умеют браузеры) в mp4 (H.264 + AAC) через связанный ffmpeg. Причины:
 *  - webm из MediaRecorder часто пишется БЕЗ длительности в контейнере
 *    (известное поведение — плеер либо не видит длину, либо считает её по
 *    первому куску индекса и ошибается — отсюда "6 секунд записи, а на шкале
 *    перемотки 3"); mp4 после ffmpeg получает нормальный duration в moov-атоме.
 *  - mp4/H.264+AAC проигрывается практически везде, в отличие от webm с
 *    VP9/AV1 + Opus.
 * ffmpeg не найден — просто отдаём исходный webm как есть (честно, без
 * притворного mp4-расширения на нерабочем файле).
 */
export async function finalizeRecording(
  tmpWebmPath: string,
  bitrateMbps: number,
): Promise<{ path: string; ext: string; mime: string; durationSec: number }> {
  const info = await detectFfmpeg();
  if (!info.found || !info.ffmpeg) {
    return { path: tmpWebmPath, ext: "webm", mime: "video/webm", durationSec: 0 };
  }
  const outPath = tmpWebmPath.replace(/\.webm$/i, "") + ".mp4";
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      tmpWebmPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      `${Math.max(1, Math.round(bitrateMbps || 8))}M`,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath,
    ];
    const child = spawn(info.ffmpeg as string, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
  fs.rmSync(tmpWebmPath, { force: true });
  const durationSec = info.ffprobe ? await probeDuration(info.ffprobe, outPath) : 0;
  return { path: outPath, ext: "mp4", mime: "video/mp4", durationSec };
}

export interface MediaItem {
  id: string;
  type: "image" | "video";
  file: string; // имя файла внутри DIRS.screenshots
  createdAt: number;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes: number;
  mime: string;
}

function readAll(): MediaItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.screenshotsIndex, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(items: MediaItem[]): void {
  fs.writeFileSync(FILES.screenshotsIndex, JSON.stringify(items, null, 2), "utf8");
}

export function list(): MediaItem[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function filePath(item: MediaItem): string {
  return path.join(DIRS.screenshots, item.file);
}

export function findById(id: string): MediaItem | null {
  return readAll().find((m) => m.id === id) || null;
}

export interface SaveOpts {
  type: "image" | "video";
  ext: string;
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

/** Перемещает уже сохранённый на диск временный файл (multer) в библиотеку. */
export function saveFromTemp(tmpPath: string, opts: SaveOpts): MediaItem {
  const id = crypto.randomBytes(8).toString("hex");
  const file = `${id}.${opts.ext}`;
  const dest = filePath({ file } as MediaItem);
  fs.renameSync(tmpPath, dest);
  const stat = fs.statSync(dest);
  const item: MediaItem = {
    id,
    type: opts.type,
    file,
    createdAt: Date.now(),
    width: opts.width,
    height: opts.height,
    durationSec: opts.durationSec,
    sizeBytes: stat.size,
    mime: opts.mime,
  };
  const items = readAll();
  items.push(item);
  writeAll(items);
  logger.action("screenshots.saved", { id, type: item.type, sizeBytes: item.sizeBytes });
  return item;
}

export function remove(id: string): boolean {
  const items = readAll();
  const idx = items.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  const [item] = items.splice(idx, 1);
  writeAll(items);
  try {
    fs.unlinkSync(filePath(item));
  } catch {
    /* уже удалён с диска — не критично */
  }
  return true;
}
