/**
 * Анализатор занятого места на диске (аналог WinDirStat): рекурсивный обход
 * папки/диска с агрегацией размеров снизу вверх, отдаёт дерево для
 * treemap-визуализации на фронте (recharts Treemap). Долгая операция —
 * работает как фоновая job и регистрируется в общем taskRegistry, чтобы
 * попасть в существующий глобальный UI задач без нового кода на фронте.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import logger from "./logger";
import { registerProvider, type TmTask } from "./taskRegistry";

export interface DiskNode {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  fileCount: number;
  children?: DiskNode[];
}

interface Job {
  id: string;
  root: string;
  stage: "scanning" | "done" | "error" | "cancelled";
  scannedEntries: number;
  error: string | null;
  result: DiskNode | null;
  cancelled: boolean;
  createdAt: number;
  /** Идентификаторы (dev:ino) уже посещённых директорий — защита от бесконечной
   *  рекурсии через junction/reparse-точки Windows (например "C:\Documents and
   *  Settings" → "C:\Users" или "C:\ProgramData" → "...\All Users"), которые
   *  readdir(withFileTypes) не всегда помечает как isSymbolicLink(). */
  visited: Set<string>;
}

/** Максимальная глубина рекурсии — дополнительная защита на случай, если
 *  проверка visited почему-то не сработает (например ino недоступен на сетевом диске). */
const MAX_DEPTH = 60;
/** Сколько stat-запросов на файлы делаем параллельно в одной директории — иначе
 *  полностью последовательные await на каждый файл делают скан огромного диска
 *  нестерпимо медленным. */
const STAT_CONCURRENCY = 16;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const jobs = new Map<string, Job>();

/** Сколько узлов держим на верхних уровнях дерева перед сворачиванием в "прочее" — иначе на C:\ ответ может весить сотни МБ JSON. */
const MAX_CHILDREN_PER_NODE = 60;

function collapseChildren(children: DiskNode[]): DiskNode[] {
  if (children.length <= MAX_CHILDREN_PER_NODE) return children;
  const sorted = [...children].sort((a, b) => b.size - a.size);
  const kept = sorted.slice(0, MAX_CHILDREN_PER_NODE - 1);
  const rest = sorted.slice(MAX_CHILDREN_PER_NODE - 1);
  const restSize = rest.reduce((s, n) => s + n.size, 0);
  const restFiles = rest.reduce((s, n) => s + n.fileCount, 0);
  kept.push({
    name: `… ещё ${rest.length} элементов`,
    path: "",
    size: restSize,
    isDir: true,
    fileCount: restFiles,
  });
  return kept;
}

async function walk(dir: string, job: Job, depth = 0): Promise<DiskNode> {
  const name = path.basename(dir) || dir;
  if (job.cancelled) return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
  if (depth >= MAX_DEPTH) return { name, path: dir, size: 0, isDir: true, fileCount: 0 };

  // lstat, а не доверие entry.isSymbolicLink() из readdir: на Windows
  // directory junction (reparse point) не всегда помечается как symlink в
  // Dirent, но всегда виден через lstat().isSymbolicLink(). Без этой
  // проверки обход зацикливается на связках вроде "C:\Documents and
  // Settings" → "C:\Users" и никогда не завершается.
  try {
    const st = await fs.promises.lstat(dir);
    if (st.isSymbolicLink()) return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
    const key = `${st.dev}:${st.ino}`;
    if (st.ino !== 0 && job.visited.has(key)) {
      return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
    }
    if (st.ino !== 0) job.visited.add(key);
  } catch {
    return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
  }

  const children: DiskNode[] = [];
  let totalSize = 0;
  let totalFiles = 0;

  const dirEntries = entries.filter((e) => !e.isSymbolicLink() && e.isDirectory());
  const fileEntries = entries.filter((e) => !e.isSymbolicLink() && e.isFile());

  for (const entry of dirEntries) {
    if (job.cancelled) break;
    const full = path.join(dir, entry.name);
    job.scannedEntries++;
    if (job.scannedEntries % 200 === 0) await new Promise((r) => setImmediate(r));
    const sub = await walk(full, job, depth + 1);
    children.push(sub);
    totalSize += sub.size;
    totalFiles += sub.fileCount;
  }

  await mapLimit(fileEntries, STAT_CONCURRENCY, async (entry) => {
    if (job.cancelled) return;
    const full = path.join(dir, entry.name);
    job.scannedEntries++;
    if (job.scannedEntries % 200 === 0) await new Promise((r) => setImmediate(r));
    let size: number;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      return;
    }
    children.push({ name: entry.name, path: full, size, isDir: false, fileCount: 1 });
    totalSize += size;
    totalFiles += 1;
  });

  return {
    name,
    path: dir,
    size: totalSize,
    isDir: true,
    fileCount: totalFiles,
    children: collapseChildren(children),
  };
}

export function startScan(root: string): { id: string } {
  const id = crypto.randomBytes(6).toString("hex");
  const job: Job = {
    id,
    root,
    stage: "scanning",
    scannedEntries: 0,
    error: null,
    result: null,
    cancelled: false,
    createdAt: Date.now(),
    visited: new Set<string>(),
  };
  jobs.set(id, job);

  void (async () => {
    try {
      const result = await walk(root, job);
      if (job.cancelled) {
        job.stage = "cancelled";
      } else {
        job.result = result;
        job.stage = "done";
      }
    } catch (e) {
      job.stage = "error";
      job.error = (e as Error).message;
      logger.error("diskScan.error", { root, error: job.error });
    }
  })();

  logger.info("diskScan.start", { id, root });
  return { id };
}

export function getJob(id: string): Job | null {
  return jobs.get(id) || null;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.stage !== "scanning") return false;
  job.cancelled = true;
  return true;
}

/** Известные корни для быстрого выбора (буквы дисков на Windows). */
export async function listRoots(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const out: string[] = [];
  for (const letter of "CDEFGH") {
    const p = `${letter}:\\`;
    try {
      await fs.promises.access(p);
      out.push(p);
    } catch {
      /* диска нет — пропускаем */
    }
  }
  return out;
}

// --- Регистрация в общем Task Manager (см. server/ts/taskRegistry.ts) ---
registerProvider({
  engine: "diskscan",
  list(): TmTask[] {
    const out: TmTask[] = [];
    for (const job of jobs.values()) {
      if (job.stage === "done" || job.stage === "cancelled") continue;
      out.push({
        id: job.id,
        engine: "diskscan",
        label: job.root,
        stage: job.stage,
        progress: -1, // общее число файлов заранее неизвестно
        createdAt: job.createdAt,
        done: false,
        error: job.error,
        canCancel: true,
        canPause: false,
        paused: false,
      });
    }
    return out;
  },
  cancel(id: string): boolean {
    return cancelJob(id);
  },
});
