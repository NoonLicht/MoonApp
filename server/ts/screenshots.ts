/**
 * Библиотека скриншотов и записей экрана страницы «Скриншоты»: единое
 * хранилище storage/screenshots — файлы (png/webm) + index.json с метаданными.
 * Раньше страница только скачивала файлы на диск пользователя (saveBlob) —
 * теперь они ещё и сохраняются в приложении, чтобы внизу страницы была
 * общая библиотека скриншотов и скринкастов с превью и плеером.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";

const { DIRS, FILES } = config;

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
