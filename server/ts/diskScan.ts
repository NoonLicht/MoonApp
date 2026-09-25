/**
 * Анализатор занятого места на диске (аналог WinDirStat).
 *
 * Первая версия строила узел дерева на КАЖДЫЙ отдельный файл — на реальном
 * диске с миллионами файлов это означало миллионы JS-объектов, удерживаемых
 * в памяти одновременно (несколько ГБ), плюс огромный JSON на выходе, из-за
 * чего сервер зависал и ничего не показывал. WinDirStat не хранит все файлы
 * плоско — он агрегирует размеры по папкам и группирует файлы внутри
 * каждой папки в общий "остаток". Здесь сделано так же:
 *
 *  - Итоговое дерево строится ТОЛЬКО из папок. Обычные файлы внутри каждой
 *    папки не превращаются в отдельные узлы — их размеры суммируются, и на
 *    папку добавляется один синтетический узел-"бакет" ("Файлы: N"), без
 *    накопления по одному объекту на файл. Из-за этого пиковая память
 *    сканера пропорциональна числу ПАПОК на диске, а не числу файлов —
 *    как правило, на 1-2 порядка меньше.
 *  - Список отдельных файлов внутри конкретной папки считается лениво, по
 *    клику на такой бакет (см. listFiles ниже) — это мгновенно, потому что
 *    сканируется одна папка, а не всё поддерево.
 *  - Обход директорий идёт конкурентно (а не строго по одной папке за раз)
 *    через общий семафор на число одновременных fs-вызовов на job — это и
 *    даёт основной прирост скорости на SSD.
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
  /** Узел — агрегат обычных файлов папки, а не сама папка/файл; клик по
   *  нему должен лениво запросить listFiles() вместо использования children. */
  isFilesBucket?: boolean;
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
/** Сколько fs-вызовов (readdir/lstat/stat) одновременно в полёте на один job —
 *  общий предохранитель скорости/нагрузки для ВСЕГО обхода, а не только
 *  файлов одной директории, как было раньше. */
const FS_CONCURRENCY = 64;
/** Сколько узлов держим в children одной папки перед сворачиванием в "…ещё N" —
 *  защищает от папок с тысячами прямых подпапок (например node_modules). */
const MAX_CHILDREN_PER_NODE = 60;
/** Сколько файлов отдаём за один ленивый запрос listFiles(). */
const LIST_FILES_MAX = 2000;

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  constructor(max: number) {
    this.available = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.available--;
    try {
      return await fn();
    } finally {
      this.available++;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

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

function emptyNode(dir: string): DiskNode {
  return { name: path.basename(dir) || dir, path: dir, size: 0, isDir: true, fileCount: 0 };
}

async function walk(dir: string, job: Job, sem: Semaphore, depth: number): Promise<DiskNode> {
  if (job.cancelled || depth >= MAX_DEPTH) return emptyNode(dir);

  // lstat, а не доверие entry.isSymbolicLink() из readdir: directory junction
  // (reparse point) на Windows не всегда помечается как symlink в Dirent, но
  // всегда виден через lstat().isSymbolicLink(). Без этой проверки обход
  // зацикливается на связках вроде "C:\Documents and Settings" → "C:\Users".
  let st: fs.Stats;
  try {
    st = await sem.run(() => fs.promises.lstat(dir));
  } catch {
    return emptyNode(dir);
  }
  if (st.isSymbolicLink()) return emptyNode(dir);
  const key = `${st.dev}:${st.ino}`;
  if (st.ino !== 0) {
    if (job.visited.has(key)) return emptyNode(dir);
    job.visited.add(key);
  }

  let entries: fs.Dirent[];
  try {
    entries = await sem.run(() => fs.promises.readdir(dir, { withFileTypes: true }));
  } catch {
    return emptyNode(dir);
  }

  const dirEntries = entries.filter((e) => !e.isSymbolicLink() && e.isDirectory());
  const fileEntries = entries.filter((e) => !e.isSymbolicLink() && e.isFile());

  job.scannedEntries += entries.length;
  await new Promise((r) => setImmediate(r));

  const subResults = job.cancelled
    ? []
    : await Promise.all(dirEntries.map((e) => walk(path.join(dir, e.name), job, sem, depth + 1)));

  const children: DiskNode[] = [];
  let dirsSize = 0;
  let dirsFiles = 0;
  for (const sub of subResults) {
    children.push(sub);
    dirsSize += sub.size;
    dirsFiles += sub.fileCount;
  }

  // Файлы папки не превращаются в отдельные узлы — только суммарный размер +
  // один узел-бакет. Индивидуальный список считается лениво через listFiles().
  let ownFilesSize = 0;
  if (!job.cancelled && fileEntries.length > 0) {
    await mapLimit(fileEntries, FS_CONCURRENCY, async (e) => {
      if (job.cancelled) return;
      try {
        const fst = await sem.run(() => fs.promises.stat(path.join(dir, e.name)));
        ownFilesSize += fst.size;
      } catch {
        /* файл исчез/недоступен — пропускаем */
      }
    });
  }
  if (fileEntries.length > 0) {
    children.push({
      name: `Файлы (${fileEntries.length})`,
      path: dir,
      size: ownFilesSize,
      isDir: false,
      fileCount: fileEntries.length,
      isFilesBucket: true,
    });
  }

  return {
    name: path.basename(dir) || dir,
    path: dir,
    size: dirsSize + ownFilesSize,
    isDir: true,
    fileCount: dirsFiles + fileEntries.length,
    children: collapseChildren(children),
  };
}

/** Ленивый список файлов ОДНОЙ папки (без рекурсии) — вызывается по клику на
 *  бакет "Файлы (N)" в дереве. Быстро, т.к. это всегда одна директория. */
export async function listFiles(dirPath: string): Promise<DiskNode[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const fileEntries = entries.filter((e) => e.isFile() && !e.isSymbolicLink());
  const sem = new Semaphore(FS_CONCURRENCY);
  const results = await mapLimit(fileEntries, FS_CONCURRENCY, async (e): Promise<DiskNode> => {
    const full = path.join(dirPath, e.name);
    let size = 0;
    try {
      size = (await sem.run(() => fs.promises.stat(full))).size;
    } catch {
      /* файл исчез/недоступен — оставляем 0 */
    }
    return { name: e.name, path: full, size, isDir: false, fileCount: 1 };
  });
  results.sort((a, b) => b.size - a.size);
  if (results.length <= LIST_FILES_MAX) return results;
  const kept = results.slice(0, LIST_FILES_MAX - 1);
  const rest = results.slice(LIST_FILES_MAX - 1);
  const restSize = rest.reduce((s, f) => s + f.size, 0);
  kept.push({ name: `… ещё ${rest.length} файлов`, path: "", size: restSize, isDir: false, fileCount: rest.length });
  return kept;
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

  const sem = new Semaphore(FS_CONCURRENCY);
  void (async () => {
    try {
      const result = await walk(root, job, sem, 0);
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
