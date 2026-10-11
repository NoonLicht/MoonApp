/**
 * Манифест, проверка целостности и восстановление бэкапов.
 *
 * Раньше бэкап был «кучей файлов»: снимок БД, settings, secrets. Не было ни списка
 * того, что должно лежать внутри, ни проверки, ни восстановления — первая же
 * попытка вернуть данные упиралась в ручное копирование. Теперь каждый бэкап
 * содержит manifest.json: путь, размер и sha256 каждого файла.
 *
 * Раскладка каталога бэкапа:
 *   data.db, settings.json, secrets.json   — как раньше (совместимость)
 *   files/<путь от storage>                — файловые хранилища (заметки, дневник, …)
 *   meta.json                              — триггер и время
 *   manifest.json                          — список файлов с хэшами
 *
 * Восстановление БД «на лету» невозможно (файл открыт), поэтому data.db кладётся
 * рядом как data.db.restore и подменяется при следующем запуске, до открытия БД
 * (applyPendingDbRestore вызывается из db.ts).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
/** Файл крупнее этого в бэкап не берём (кэши, скачанные модели) — только в лог. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Что входит в бэкап (пути от storage). Всё пользовательское и не восстановимое. */
export const SOURCES: ReadonlyArray<string> = [
  "vault/notes",
  "vault/holts",
  "vault/assets",
  "notes",
  "diary",
  "quicknotes",
  "m3e",
  "bookmarks.json",
  "password-vault.json",
  "notes-git.json",
  // JSON-хранилища страниц (раньше в копию не попадали):
  "budget-transactions.json",
  "budget-recurring.json",
  "rss.json",
  "music-playlists.json",
  "automation-launchers.json",
  "automation-rules.json",
  "app-time-tracker.json",
  "conspectus_presets.json",
  "games/library.json",
  "games/benchmarks.json",
  "semantic/file-folders.json",
];

/** Подкаталоги источников, которые не копируются (временные файлы). */
const SKIP_SEGMENTS = new Set(["tmp", ".tmp", "node_modules", ".git"]);

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  version: number;
  createdAt: string;
  files: ManifestEntry[];
}

export interface VerifyResult {
  ok: boolean;
  hasManifest: boolean;
  checked: number;
  missing: string[];
  corrupted: string[];
}

export function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Все файлы каталога (относительные пути с «/»), без служебных подкаталогов. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Копирует источники из storage в <backupDir>/files. Возвращает пропущенные большие файлы. */
export function copySources(storage: string, backupDir: string): string[] {
  const skipped: string[] = [];
  for (const src of SOURCES) {
    const abs = path.join(storage, src);
    if (!fs.existsSync(abs)) continue;
    const files = fs.statSync(abs).isDirectory() ? walk(abs).map((f) => `${src}/${f}`) : [src];
    for (const rel of files) {
      const from = path.join(storage, rel);
      let size: number;
      try {
        size = fs.statSync(from).size;
      } catch {
        continue; // файл исчез между обходом и копированием
      }
      if (size > MAX_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      const to = path.join(backupDir, "files", rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  return skipped;
}

/** Считает хэши всех файлов бэкапа (кроме манифеста) и записывает manifest.json. */
export function writeManifest(backupDir: string): Manifest {
  const files: ManifestEntry[] = walk(backupDir)
    .filter((f) => f !== MANIFEST_FILE)
    .sort()
    .map((f) => {
      const abs = path.join(backupDir, f);
      return { path: f, size: fs.statSync(abs).size, sha256: sha256File(abs) };
    });
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(backupDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

function readManifest(backupDir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(backupDir, MANIFEST_FILE), "utf8")) as Manifest;
    return Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

/** Путь внутри каталога? Защита от «..» и абсолютных путей в манифесте. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  return abs.startsWith(base) ? abs : null;
}

/** Сверяет файлы бэкапа с манифестом. Бэкап без манифеста (старый) — ok=false, hasManifest=false. */
export function verifyBackup(backupDir: string): VerifyResult {
  const manifest = readManifest(backupDir);
  if (!manifest) {
    return { ok: false, hasManifest: false, checked: 0, missing: [], corrupted: [] };
  }
  const missing: string[] = [];
  const corrupted: string[] = [];
  for (const e of manifest.files) {
    const abs = inside(backupDir, e.path);
    if (!abs || !fs.existsSync(abs)) {
      missing.push(e.path);
      continue;
    }
    if (fs.statSync(abs).size !== e.size || sha256File(abs) !== e.sha256) corrupted.push(e.path);
  }
  return {
    ok: missing.length === 0 && corrupted.length === 0,
    hasManifest: true,
    checked: manifest.files.length,
    missing,
    corrupted,
  };
}

export interface RestoreResult {
  restoredFiles: number;
  /** БД подменится при следующем запуске приложения. */
  dbPending: boolean;
}

function atomicCopy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.restore-tmp`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/**
 * Возвращает данные из проверенного бэкапа. Вызывающий обязан сначала проверить
 * verifyBackup и сделать страховочный бэкап текущего состояния.
 */
export function restoreFiles(backupDir: string, storage: string): RestoreResult {
  const manifest = readManifest(backupDir);
  if (!manifest) throw new Error("backup.no_manifest");
  let restored = 0;
  let dbPending = false;
  for (const e of manifest.files) {
    const from = inside(backupDir, e.path);
    if (!from) throw new Error(`backup.bad_path: ${e.path}`);
    if (e.path === "data.db") {
      atomicCopy(from, path.join(storage, "data.db.restore"));
      dbPending = true;
    } else if (e.path.startsWith("files/")) {
      const to = inside(storage, e.path.slice("files/".length));
      if (!to) throw new Error(`backup.bad_path: ${e.path}`);
      atomicCopy(from, to);
      restored++;
    } else if (e.path === "settings.json" || e.path === "secrets.json") {
      atomicCopy(from, path.join(storage, e.path));
      restored++;
    }
  }
  return { restoredFiles: restored, dbPending };
}

/**
 * Подмена БД восстановленным снимком. Вызывается из db.ts ДО открытия базы.
 * Старый файл сохраняется как data.db.before-restore (на случай, если снимок не тот).
 */
export function applyPendingDbRestore(dbFile: string): boolean {
  const pending = `${dbFile}.restore`;
  if (!fs.existsSync(pending)) return false;
  try {
    if (fs.existsSync(dbFile)) fs.renameSync(dbFile, `${dbFile}.before-restore`);
    for (const ext of ["-wal", "-shm"]) {
      try {
        fs.rmSync(dbFile + ext, { force: true });
      } catch {
        /* sidecar-файла может не быть */
      }
    }
    fs.renameSync(pending, dbFile);
    return true;
  } catch {
    return false;
  }
}
