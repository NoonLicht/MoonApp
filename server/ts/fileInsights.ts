/**
 * Анализ файлов: дубликаты, забытые крупные файлы и похожие изображения.
 *
 * Дубликаты ищутся в три прохода, чтобы не читать лишнего: группы по размеру →
 * хэш первых 64 КБ → полный sha256 (только для тех, кто совпал на предыдущих шагах).
 * Хэши изображений (dHash) считает интерфейс: декодер картинок есть в браузере,
 * а в серверном процессе его нет. Здесь — только объединение близких хэшей по
 * расстоянию Хэмминга.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { scheduler } from "./jobQueue";

export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  atimeMs: number;
}

export interface DupGroup {
  hash: string;
  size: number;
  files: string[];
  /** Сколько места занимают лишние копии (size × (N − 1)). */
  wasted: number;
}

export interface ForgottenFile {
  path: string;
  size: number;
  /** Дней с последнего обращения или изменения. */
  idleDays: number;
}

export interface SimilarGroup {
  files: string[];
  /** Максимальное расстояние Хэмминга внутри группы. */
  maxDistance: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "$recycle.bin",
  "system volume information",
  "windows",
  "appdata",
  "proc",
  "sys",
  "dev",
]);
const HEAD_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;

export interface WalkOptions {
  maxFiles?: number;
  minSize?: number;
  signal?: { aborted: boolean };
  onProgress?: (scanned: number) => void;
}

/** Обход без рекурсии по промисам: стек папок, чтение по одной за раз. */
export async function walkFiles(roots: string[], opts: WalkOptions = {}): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const max = opts.maxFiles ?? 500_000;
  const minSize = opts.minSize ?? 0;
  const stack = [...roots];
  let scanned = 0;
  while (stack.length && out.length < max) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // нет доступа — пропускаем папку
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.stat(full);
        scanned++;
        if (st.size >= minSize && st.size > 0) {
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
          if (out.length >= max) break;
        }
        if (scanned % 500 === 0) opts.onProgress?.(scanned);
      } catch {
        /* файл исчез между readdir и stat */
      }
    }
  }
  opts.onProgress?.(scanned);
  return out;
}

async function hashFile(file: string, limit?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file, limit ? { start: 0, end: limit - 1 } : undefined);
    s.on("data", (c) => h.update(c));
    s.on("error", () => resolve(null));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Группирует записи по ключу, возвращая только группы из двух и более. */
function groupBy<T>(items: T[], key: (t: T) => string | null): T[][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k === null) continue;
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return [...m.values()].filter((g) => g.length > 1);
}

export async function findDuplicateGroups(
  files: FileEntry[],
  signal?: { aborted: boolean },
  onStep?: (done: number, total: number) => void,
): Promise<DupGroup[]> {
  const bySize = groupBy(files, (f) => String(f.size)).flat();
  const total = bySize.length;
  let done = 0;
  const heads = new Map<string, string | null>();
  for (const f of bySize) {
    if (signal?.aborted) return [];
    heads.set(f.path, await hashFile(f.path, HEAD_BYTES));
    onStep?.(++done, total * 2);
  }
  const candidates = groupBy(bySize, (f) => {
    const h = heads.get(f.path);
    return h ? f.size + ":" + h : null;
  }).flat();
  const groups: DupGroup[] = [];
  const full = new Map<string, string | null>();
  done = total;
  for (const f of candidates) {
    if (signal?.aborted) return [];
    // Файлы не больше головы уже прочитаны целиком — повторно не читаем.
    full.set(f.path, f.size <= HEAD_BYTES ? (heads.get(f.path) ?? null) : await hashFile(f.path));
    onStep?.(++done, total + candidates.length);
  }
  for (const g of groupBy(candidates, (f) => full.get(f.path) ?? null)) {
    groups.push({
      hash: full.get(g[0].path) as string,
      size: g[0].size,
      files: g.map((f) => f.path).sort(),
      wasted: g[0].size * (g.length - 1),
    });
  }
  return groups.sort((a, b) => b.wasted - a.wasted);
}

export function forgottenFiles(
  files: FileEntry[],
  opts: { minSize: number; olderThanDays: number; limit?: number; now?: number },
): ForgottenFile[] {
  const now = opts.now ?? Date.now();
  const out: ForgottenFile[] = [];
  for (const f of files) {
    if (f.size < opts.minSize) continue;
    const idle = Math.floor((now - Math.max(f.atimeMs, f.mtimeMs)) / DAY_MS);
    if (idle >= opts.olderThanDays) out.push({ path: f.path, size: f.size, idleDays: idle });
  }
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, opts.limit ?? 200);
}

/** Расстояние Хэмминга между двумя шестнадцатеричными хэшами одинаковой длины. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return Infinity;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Связные группы изображений, у которых хэши отличаются не более чем на maxDistance бит. */
export function groupSimilar(
  items: { path: string; hash: string }[],
  maxDistance = 6,
): SimilarGroup[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const dist = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = hamming(items[i].hash, items[j].hash);
      if (d <= maxDistance) {
        dist.set(i + ":" + j, d);
        parent[find(i)] = find(j);
      }
    }
  }
  const comps = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    const arr = comps.get(r);
    if (arr) arr.push(i);
    else comps.set(r, [i]);
  });
  const out: SimilarGroup[] = [];
  for (const idx of comps.values()) {
    if (idx.length < 2) continue;
    let maxD = 0;
    for (const i of idx) for (const j of idx) if (i < j) maxD = Math.max(maxD, dist.get(i + ":" + j) ?? 0);
    out.push({ files: idx.map((i) => items[i].path).sort(), maxDistance: maxD });
  }
  return out.sort((a, b) => b.files.length - a.files.length);
}

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
export const isImage = (p: string): boolean => IMAGE_EXT.has(path.extname(p).toLowerCase());

// ── Фоновые задачи ──────────────────────────────────────────────────────

export type InsightKind = "duplicates" | "forgotten" | "images";
export interface InsightJob {
  id: string;
  kind: InsightKind;
  stage: "scanning" | "hashing" | "done" | "error" | "cancelled";
  scanned: number;
  progress: number;
  error: string | null;
  duplicates?: DupGroup[];
  forgotten?: ForgottenFile[];
  images?: string[];
}

const jobs = new Map<string, InsightJob & { abort: { aborted: boolean } }>();
const MAX_JOBS = 20;

export function startInsight(
  kind: InsightKind,
  roots: string[],
  opts: { minSize?: number; olderThanDays?: number } = {},
): string {
  const id = crypto.randomBytes(6).toString("hex");
  const job: InsightJob & { abort: { aborted: boolean } } = {
    id,
    kind,
    stage: "scanning",
    scanned: 0,
    progress: 0,
    error: null,
    abort: { aborted: false },
  };
  jobs.set(id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value as string);
  void scheduler
    .withSlot("cpu", async () => {
      const files = await walkFiles(roots, {
        minSize: opts.minSize ?? (kind === "duplicates" ? 1024 : kind === "forgotten" ? 50 * 1024 ** 2 : 1),
        signal: job.abort,
        onProgress: (n) => (job.scanned = n),
      });
      if (job.abort.aborted) return;
      if (kind === "forgotten") {
        job.forgotten = forgottenFiles(files, {
          minSize: opts.minSize ?? 50 * 1024 ** 2,
          olderThanDays: opts.olderThanDays ?? 180,
        });
      } else if (kind === "images") {
        job.images = files.filter((f) => isImage(f.path)).map((f) => f.path);
      } else {
        job.stage = "hashing";
        job.duplicates = await findDuplicateGroups(files, job.abort, (d, t) => {
          job.progress = Math.round((d / Math.max(1, t)) * 100);
        });
      }
    })
    .then(() => {
      job.stage = job.abort.aborted ? "cancelled" : "done";
      job.progress = 100;
    })
    .catch((e: unknown) => {
      job.stage = "error";
      job.error = String((e as Error)?.message ?? e).slice(0, 300);
    });
  return id;
}

export function getInsight(id: string): InsightJob | null {
  const j = jobs.get(id);
  if (!j) return null;
  const { abort: _a, ...pub } = j;
  return pub;
}

export function cancelInsight(id: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  j.abort.aborted = true;
  return true;
}
