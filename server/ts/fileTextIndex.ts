/**
 * Текст файлов из выбранных папок для поиска (PDF, текстовые файлы, картинки через OCR).
 *
 * Здесь только извлечение и кэш: кэш лежит в storage/semantic/file-texts.json и
 * обновляется по размеру и времени изменения. Сам поиск (слова + векторы) делает
 * semantic.ts — он берёт документы отсюда как источник «file».
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "./config";
import logger from "./logger";
import { walkFiles } from "./fileInsights";
import { scheduler } from "./jobQueue";

const DIR = (): string => path.join(config.DIRS.storage, "semantic");
const FOLDERS = (): string => path.join(DIR(), "file-folders.json");
const CACHE = (): string => path.join(DIR(), "file-texts.json");

export const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".html", ".htm", ".xml"]);
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);
export const PDF_EXT = new Set([".pdf"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 60_000;
const MAX_FILES = 5_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export type FileKind = "text" | "pdf" | "image";

export function kindOf(file: string): FileKind | null {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return "text";
  if (PDF_EXT.has(ext)) return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  title: string;
  text: string;
  kind: FileKind;
}
type Cache = Record<string, CacheEntry>;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function getFolders(): string[] {
  const raw = readJson<unknown>(FOLDERS(), []);
  return Array.isArray(raw) ? raw.map(String) : [];
}

export function setFolders(folders: string[]): string[] {
  const clean = [...new Set(folders.map((f) => String(f).trim()).filter((f) => path.isAbsolute(f)))];
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(FOLDERS(), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

export async function extract(file: string, kind: FileKind): Promise<string> {
  if (kind === "text") {
    const raw = fs.readFileSync(file, "utf8");
    return /\.html?$/i.test(file) ? htmlToText(raw) : raw;
  }
  if (kind === "pdf") {
    const { extractText } = require("./pdfTools") as typeof import("./pdfTools");
    const { text } = await extractText(fs.readFileSync(file));
    return text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, " "); // служебные метки страниц
  }
  const ocr = require("./ocr") as typeof import("./ocr");
  return (await ocr.recognize(fs.readFileSync(file))).text;
}

export interface ScanState {
  running: boolean;
  total: number;
  done: number;
  indexed: number;
  failed: number;
  error: string;
  startedAt: number;
}
let state: ScanState = {
  running: false,
  total: 0,
  done: 0,
  indexed: 0,
  failed: 0,
  error: "",
  startedAt: 0,
};
export const scanState = (): ScanState => state;

/** Обходит папки, обновляет кэш текстов; удалённые файлы из кэша убираются. */
export function startScan(onDone?: () => void): ScanState {
  if (state.running) return state;
  state = { running: true, total: 0, done: 0, indexed: 0, failed: 0, error: "", startedAt: Date.now() };
  void scheduler
    .withSlot("cpu", async () => {
      const folders = getFolders();
      const found = (await walkFiles(folders, { maxFiles: MAX_FILES })).filter((f) => kindOf(f.path));
      state.total = found.length;
      const cache = readJson<Cache>(CACHE(), {});
      const next: Cache = {};
      for (const f of found) {
        const kind = kindOf(f.path) as FileKind;
        const prev = cache[f.path];
        state.done++;
        if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
          next[f.path] = prev;
          continue;
        }
        if ((kind === "text" && f.size > MAX_TEXT_BYTES) || (kind === "image" && f.size > MAX_IMAGE_BYTES)) {
          continue;
        }
        try {
          const text = (await extract(f.path, kind)).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
          if (text.length >= 3) {
            next[f.path] = {
              size: f.size,
              mtimeMs: f.mtimeMs,
              title: path.basename(f.path),
              text,
              kind,
            };
            state.indexed++;
          }
        } catch (e) {
          state.failed++;
          logger.warn("fileTextIndex.extract", { file: f.path, error: String((e as Error).message) });
        }
      }
      fs.mkdirSync(DIR(), { recursive: true });
      fs.writeFileSync(CACHE(), JSON.stringify(next), "utf8");
    })
    .catch((e: unknown) => {
      state.error = String((e as Error)?.message ?? e).slice(0, 300);
    })
    .finally(() => {
      state.running = false;
      try {
        onDone?.();
      } catch (e) {
        logger.warn("fileTextIndex.onDone", { error: String((e as Error).message) });
      }
    });
  return state;
}

export interface FileDoc {
  ref: string;
  title: string;
  text: string;
}

/** Документы для индекса: путь файла, имя и текст. */
export function fileDocs(): FileDoc[] {
  return Object.entries(readJson<Cache>(CACHE(), {})).map(([ref, e]) => ({
    ref,
    title: e.title,
    text: e.text,
  }));
}

export function cacheStamp(): string {
  const c = readJson<Cache>(CACHE(), {});
  return crypto.createHash("sha1").update(Object.keys(c).sort().join("|")).digest("hex").slice(0, 8);
}
