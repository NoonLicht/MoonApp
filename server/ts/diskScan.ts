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
 *  - Обход директорий идёт через очередь задач и пул воркеров ФИКСИРОВАННОГО
 *    размера (WORKER_POOL), а НЕ через рекурсивный Promise.all по всем
 *    подпапкам сразу. Наивная рекурсия (walk() вызывает walk() на всех детей
 *    через Promise.all) заводит один JS-промис на КАЖДУЮ директорию дерева
 *    одновременно — на диске с сотнями тысяч папок это сотни тысяч подвешенных
 *    асинхронных вызовов в памяти разом, даже если сами fs-syscall'ы
 *    throttled семафором. Именно это и вызывало зависание/неограниченный
 *    рост памяти на реальных дисках (а не на node_modules, где папок мало).
 *    Очередь + пул воркеров держат в памяти пропорционально WORKER_POOL
 *    активных обходов плюс лёгкие (десятки байт) объекты-задачи в очереди —
 *    это и даёт стабильную память и скорость, близкую к WinDirStat.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
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
  /** Только в "плоской" выдаче getNode(): есть ли у ЭТОГО ребёнка свои
   *  дети на сервере (можно ли углубиться кликом), без их пересылки. */
  hasChildren?: boolean;
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

/** Максимальная глубина дерева — дополнительная защита на случай, если
 *  проверка visited почему-то не сработает (например ino недоступен на сетевом диске). */
const MAX_DEPTH = 60;
/** Сколько директорий обходится ОДНОВРЕМЕННО (readdir/lstat/своя пачка файлов) —
 *  главный предохранитель памяти: сколько бы миллионов папок ни было в очереди,
 *  активных обходов в моменте не больше этого числа. */
const WORKER_POOL = 48;
/** Сколько файлов ОДНОЙ директории стятся параллельно внутри одного воркера. */
const FILE_STAT_CONCURRENCY = 8;
/** Сколько узлов держим в children одной папки перед сворачиванием в "…ещё N" —
 *  защищает от папок с тысячами прямых подпапок (например node_modules). */
const MAX_CHILDREN_PER_NODE = 60;
/** Сколько файлов отдаём за один ленивый запрос listFiles(). */
const LIST_FILES_MAX = 2000;

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

interface ScanTask {
  dir: string;
  depth: number;
  node: DiskNode;
  parent: ScanTask | null;
  pendingChildren: number;
}

/**
 * Обходит поддерево `root`, используя очередь задач вместо рекурсивного
 * Promise.all — см. пояснение вверху файла. Каждая задача обрабатывает ровно
 * одну директорию (свой readdir + lstat + свои файлы), а подпапки кладёт в
 * общую очередь как НОВЫЕ задачи, а не рекурсивные вызовы. Родитель
 * завершается (finish), когда завершились все его дети — по счётчику
 * pendingChildren, без дополнительных промисов на ожидание.
 */
async function scanTree(root: string, job: Job): Promise<DiskNode> {
  return new Promise<DiskNode>((resolvePromise) => {
    const queue: ScanTask[] = [];
    let active = 0;
    let settled = false;

    function finish(task: ScanTask) {
      task.node.children = collapseChildren(task.node.children || []);
      const parent = task.parent;
      if (parent) {
        parent.node.children = parent.node.children || [];
        parent.node.children.push(task.node);
        parent.node.size += task.node.size;
        parent.node.fileCount += task.node.fileCount;
        parent.pendingChildren--;
        if (parent.pendingChildren === 0) finish(parent);
      } else if (!settled) {
        settled = true;
        resolvePromise(task.node);
      }
    }

    async function process(task: ScanTask) {
      active++;
      try {
        if (job.cancelled || task.depth >= MAX_DEPTH) {
          task.pendingChildren = 0;
          finish(task);
          return;
        }

        // lstat, а не доверие entry.isSymbolicLink() из readdir: directory
        // junction (reparse point) на Windows не всегда помечается как
        // symlink в Dirent, но всегда виден через lstat().isSymbolicLink().
        // Без этой проверки обход зацикливается на связках вроде
        // "C:\Documents and Settings" → "C:\Users".
        let st: fs.Stats;
        try {
          st = await fs.promises.lstat(task.dir);
        } catch {
          task.pendingChildren = 0;
          finish(task);
          return;
        }
        if (st.isSymbolicLink()) {
          task.pendingChildren = 0;
          finish(task);
          return;
        }
        const key = `${st.dev}:${st.ino}`;
        if (st.ino !== 0) {
          if (job.visited.has(key)) {
            task.pendingChildren = 0;
            finish(task);
            return;
          }
          job.visited.add(key);
        }

        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(task.dir, { withFileTypes: true });
        } catch {
          task.pendingChildren = 0;
          finish(task);
          return;
        }

        const dirEntries = entries.filter((e) => !e.isSymbolicLink() && e.isDirectory());
        const fileEntries = entries.filter((e) => !e.isSymbolicLink() && e.isFile());
        job.scannedEntries += entries.length;

        // Файлы папки не превращаются в отдельные узлы — только суммарный
        // размер + один узел-бакет. Индивидуальный список считается лениво
        // через listFiles().
        let ownFilesSize = 0;
        if (fileEntries.length > 0 && !job.cancelled) {
          await mapLimit(fileEntries, FILE_STAT_CONCURRENCY, async (e) => {
            if (job.cancelled) return;
            try {
              const fst = await fs.promises.stat(path.join(task.dir, e.name));
              ownFilesSize += fst.size;
            } catch {
              /* файл исчез/недоступен — пропускаем */
            }
          });
          task.node.children = task.node.children || [];
          task.node.children.push({
            name: `Файлы (${fileEntries.length})`,
            path: task.dir,
            size: ownFilesSize,
            isDir: false,
            fileCount: fileEntries.length,
            isFilesBucket: true,
          });
        }
        task.node.size += ownFilesSize;
        task.node.fileCount += fileEntries.length;

        if (dirEntries.length === 0 || job.cancelled) {
          task.pendingChildren = 0;
          finish(task);
          return;
        }

        task.pendingChildren = dirEntries.length;
        for (const e of dirEntries) {
          const childDir = path.join(task.dir, e.name);
          enqueue({
            dir: childDir,
            depth: task.depth + 1,
            node: { name: e.name, path: childDir, size: 0, isDir: true, fileCount: 0, children: [] },
            parent: task,
            pendingChildren: 0,
          });
        }
      } finally {
        active--;
        pump();
      }
    }

    function pump() {
      while (active < WORKER_POOL && queue.length > 0) {
        const t = queue.shift();
        if (t) void process(t);
      }
    }

    function enqueue(task: ScanTask) {
      queue.push(task);
      pump();
    }

    enqueue({
      dir: root,
      depth: 0,
      node: { name: path.basename(root) || root, path: root, size: 0, isDir: true, fileCount: 0, children: [] },
      parent: null,
      pendingChildren: 0,
    });
  });
}

function shallowNode(node: DiskNode): DiskNode {
  return {
    name: node.name,
    path: node.path,
    size: node.size,
    isDir: node.isDir,
    fileCount: node.fileCount,
    isFilesBucket: node.isFilesBucket,
    children: node.children?.map((c) => ({
      name: c.name,
      path: c.path,
      size: c.size,
      isDir: c.isDir,
      fileCount: c.fileCount,
      isFilesBucket: c.isFilesBucket,
      hasChildren: !!(c.children && c.children.length > 0),
    })),
  };
}

function findNodeByPath(node: DiskNode, targetPath: string): DiskNode | null {
  if (node.path === targetPath) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const found = findNodeByPath(c, targetPath);
    if (found) return found;
  }
  return null;
}

/**
 * Отдаёт ОДИН уровень дерева (сам узел + его прямые дети, без вложенных
 * внуков), а не всё поддерево целиком. Полное дерево (job.result) держится
 * только в памяти сервера. Раньше фронт получал сразу всё поддерево на
 * каждый клик — при полном скане диска это десятки МБ вложенного JSON,
 * которые оседали в памяти рендерера Electron и удерживались там, вызывая
 * периодические паузы сборщика мусора (заметные как секундная задержка при
 * наведении на любую кнопку во всём приложении, не только на этой странице).
 */
export function getNode(jobId: string, targetPath: string): DiskNode | null {
  const job = jobs.get(jobId);
  if (!job || !job.result) return null;
  const found = targetPath ? findNodeByPath(job.result, targetPath) : job.result;
  return found ? shallowNode(found) : null;
}

function psQuote(p: string): string {
  return p.replace(/'/g, "''");
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`))));
  });
}

/** Открыть проводник с выделенным файлом/папкой. */
export function revealInExplorer(p: string): void {
  if (process.platform === "win32") {
    spawn("explorer", ["/select,", p], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", p], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [path.dirname(p)], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Открыть терминал с рабочей директорией на этом пути (для файла — на его папке). */
export function openConsole(p: string, isDir: boolean): void {
  const dir = isDir ? p : path.dirname(p);
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", "cmd.exe"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("x-terminal-emulator", [], { cwd: dir, detached: true, stdio: "ignore" }).unref();
  }
}

/** Удаление в корзину (не насовсем) — на Windows через .NET FileSystem API,
 *  восстановимо из корзины, как обычное удаление в проводнике. */
export async function deleteToTrash(p: string, isDir: boolean): Promise<void> {
  if (process.platform !== "win32") {
    await fs.promises.rm(p, { recursive: true, force: true });
    return;
  }
  const method = isDir ? "DeleteDirectory" : "DeleteFile";
  const script =
    `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${psQuote(p)}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  await runPowerShell(script);
}

/** Сжатие в .zip рядом с исходником — запускается в фоне (fire-and-forget),
 *  чтобы не держать HTTP-запрос открытым на время архивации большой папки. */
export function compressPath(p: string): string {
  const dest = `${p.replace(/[\\/]+$/, "")}.zip`;
  if (process.platform === "win32") {
    const script = `Compress-Archive -LiteralPath '${psQuote(p)}' -DestinationPath '${psQuote(dest)}' -Force`;
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("zip", ["-r", dest, p], { detached: true, stdio: "ignore" }).unref();
  }
  return dest;
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
  const results = await mapLimit(fileEntries, WORKER_POOL, async (e): Promise<DiskNode> => {
    const full = path.join(dirPath, e.name);
    let size = 0;
    try {
      size = (await fs.promises.stat(full)).size;
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

  void (async () => {
    try {
      const result = await scanTree(root, job);
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
