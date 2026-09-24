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

async function walk(dir: string, job: Job): Promise<DiskNode> {
  const name = path.basename(dir) || dir;
  if (job.cancelled) return { name, path: dir, size: 0, isDir: true, fileCount: 0 };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { name, path: dir, size: 0, isDir: true, fileCount: 0 };
  }

  const children: DiskNode[] = [];
  let totalSize = 0;
  let totalFiles = 0;

  for (const entry of entries) {
    if (job.cancelled) break;
    const full = path.join(dir, entry.name);
    job.scannedEntries++;
    // Каждые ~200 записей отдаём event loop — иначе сканирование крупного
    // диска блокирует остальные запросы к серверу (единый Node-процесс).
    if (job.scannedEntries % 200 === 0) await new Promise((r) => setImmediate(r));

    if (entry.isSymbolicLink()) continue; // не ходим по симлинкам — риск циклов
    if (entry.isDirectory()) {
      const sub = await walk(full, job);
      children.push(sub);
      totalSize += sub.size;
      totalFiles += sub.fileCount;
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = (await fs.promises.stat(full)).size;
      } catch {
        continue;
      }
      children.push({ name: entry.name, path: full, size, isDir: false, fileCount: 1 });
      totalSize += size;
      totalFiles += 1;
    }
  }

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
