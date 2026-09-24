/**
 * Лаунчер игр/приложений: карточки с иконкой/фоном/описанием, запуск по
 * клику, менеджер сохранений (версионный zip-бэкап по указанному пути) и
 * автосбор библиотеки из Steam/Epic.
 */
import { spawn, exec } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import config from "./config";
import logger from "./logger";

const { DIRS, FILES } = config;

export interface GameEntry {
  id: string;
  name: string;
  exePath: string;
  description: string;
  iconDataUrl: string | null;
  backgroundDataUrl: string | null;
  savePath: string | null;
  source: "manual" | "steam" | "epic";
  createdAt: number;
}

function readLibrary(): GameEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.gamesLibrary, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeLibrary(items: GameEntry[]): void {
  fs.writeFileSync(FILES.gamesLibrary, JSON.stringify(items, null, 2), "utf8");
}

export function list(): GameEntry[] {
  return readLibrary().sort((a, b) => a.name.localeCompare(b.name));
}

export function create(input: {
  name: string;
  exePath: string;
  description?: string;
  iconDataUrl?: string | null;
  backgroundDataUrl?: string | null;
  savePath?: string | null;
}): GameEntry {
  const entry: GameEntry = {
    id: crypto.randomUUID(),
    name: String(input.name || "").trim() || path.basename(input.exePath),
    exePath: String(input.exePath || ""),
    description: String(input.description || ""),
    iconDataUrl: input.iconDataUrl || null,
    backgroundDataUrl: input.backgroundDataUrl || null,
    savePath: input.savePath || null,
    source: "manual",
    createdAt: Date.now(),
  };
  const all = readLibrary();
  all.push(entry);
  writeLibrary(all);
  logger.info("games.create", { id: entry.id, name: entry.name });
  return entry;
}

export function update(
  id: string,
  input: Partial<Omit<GameEntry, "id" | "source" | "createdAt">>,
): GameEntry | null {
  const all = readLibrary();
  const idx = all.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...input };
  writeLibrary(all);
  return all[idx];
}

export function remove(id: string): boolean {
  const all = readLibrary();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeLibrary(next);
  // Бэкапы сохранений намеренно НЕ удаляются вместе с карточкой — это
  // единственная копия сейвов пользователя, потеря данных недопустима.
  return true;
}

/** Запускает игру/приложение отсоединённым процессом (не привязан к жизни сервера). */
export function launch(id: string): { ok: boolean; error?: string } {
  const entry = readLibrary().find((x) => x.id === id);
  if (!entry) return { ok: false, error: "not_found" };
  if (!fs.existsSync(entry.exePath)) return { ok: false, error: "exe_not_found" };
  try {
    const child = spawn(entry.exePath, [], {
      cwd: path.dirname(entry.exePath),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    logger.info("games.launch", { id, exePath: entry.exePath });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* --- Менеджер сохранений: версионный zip-бэкап папки savePath --- */

export interface SaveVersion {
  file: string;
  createdAt: number;
  size: number;
}

function saveDirFor(gameId: string): string {
  return path.join(DIRS.gameSaves, gameId);
}

export function backupSave(gameId: string): { ok: boolean; error?: string; file?: string } {
  const entry = readLibrary().find((x) => x.id === gameId);
  if (!entry) return { ok: false, error: "not_found" };
  if (!entry.savePath) return { ok: false, error: "no_save_path" };
  if (!fs.existsSync(entry.savePath)) return { ok: false, error: "save_path_missing" };

  const dir = saveDirFor(gameId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `save_${stamp}.zip`);

  const zip = new AdmZip();
  const stat = fs.statSync(entry.savePath);
  if (stat.isDirectory()) zip.addLocalFolder(entry.savePath);
  else zip.addLocalFile(entry.savePath);
  zip.writeZip(file);

  logger.info("games.backupSave", { gameId, file: path.basename(file) });
  return { ok: true, file: path.basename(file) };
}

export function listSaveVersions(gameId: string): SaveVersion[] {
  const dir = saveDirFor(gameId);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, createdAt: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function restoreSave(gameId: string, file: string): { ok: boolean; error?: string } {
  const entry = readLibrary().find((x) => x.id === gameId);
  if (!entry) return { ok: false, error: "not_found" };
  if (!entry.savePath) return { ok: false, error: "no_save_path" };
  // Защита от path traversal: имя архива — только базовое имя внутри saveDirFor.
  const safeName = path.basename(file);
  const zipPath = path.join(saveDirFor(gameId), safeName);
  if (!fs.existsSync(zipPath)) return { ok: false, error: "version_not_found" };

  try {
    const zip = new AdmZip(zipPath);
    fs.mkdirSync(entry.savePath, { recursive: true });
    zip.extractAllTo(entry.savePath, true);
    logger.info("games.restoreSave", { gameId, file: safeName });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* --- Автосбор библиотеки: Steam + Epic (best-effort, Windows) --- */

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout || ""));
    });
  });
}

async function findSteamRoot(): Promise<string | null> {
  const candidates = ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "steamapps"))) return c;
  }
  // Резервный путь — чтение реестра (только чтение, тот же приём, что и для
  // остального автообнаружения в проекте через child_process).
  const out = await execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath');
  const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
  if (m) {
    const p = m[1].trim().replace(/\//g, "\\");
    if (fs.existsSync(path.join(p, "steamapps"))) return p;
  }
  return null;
}

function parseLibraryFolders(vdfPath: string): string[] {
  try {
    const raw = fs.readFileSync(vdfPath, "utf8");
    const paths = [...raw.matchAll(/"path"\s+"([^"]+)"/gi)].map((m) => m[1].replace(/\\\\/g, "\\"));
    return paths;
  } catch {
    return [];
  }
}

/** Эвристика: самый крупный .exe в папке игры, за вычетом типовых не-игровых бинарей. */
function pickLikelyExe(dir: string): string | null {
  const SKIP = /unins|redist|vcredist|dxsetup|crashhandler|setup|installer|dotnet/i;
  let best: { file: string; size: number } | null = null;
  const walk = (d: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && /\.exe$/i.test(e.name) && !SKIP.test(e.name)) {
        try {
          const size = fs.statSync(full).size;
          if (!best || size > best.size) best = { file: full, size };
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(dir, 0);
  return best ? (best as { file: string; size: number }).file : null;
}

async function scanSteam(): Promise<GameEntry[]> {
  const root = await findSteamRoot();
  if (!root) return [];
  const libFile = path.join(root, "steamapps", "libraryfolders.vdf");
  const libs = new Set<string>([root, ...parseLibraryFolders(libFile)]);
  const out: GameEntry[] = [];
  for (const lib of libs) {
    const commonDir = path.join(lib, "steamapps", "common");
    let names: string[];
    try {
      names = fs.readdirSync(commonDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const gameDir = path.join(commonDir, name);
      let isDir: boolean;
      try {
        isDir = fs.statSync(gameDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const exe = pickLikelyExe(gameDir);
      if (!exe) continue;
      out.push({
        id: crypto.randomUUID(),
        name,
        exePath: exe,
        description: "",
        iconDataUrl: null,
        backgroundDataUrl: null,
        savePath: null,
        source: "steam",
        createdAt: Date.now(),
      });
    }
  }
  return out;
}

async function scanEpic(): Promise<GameEntry[]> {
  const manifestsDir = path.join(
    process.env.PROGRAMDATA || "C:\\ProgramData",
    "Epic",
    "EpicGamesLauncher",
    "Data",
    "Manifests",
  );
  let files: string[];
  try {
    files = fs.readdirSync(manifestsDir).filter((f) => f.endsWith(".item"));
  } catch {
    return [];
  }
  const out: GameEntry[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), "utf8")) as {
        DisplayName?: string;
        InstallLocation?: string;
        LaunchExecutable?: string;
      };
      if (!data.InstallLocation || !data.LaunchExecutable) continue;
      const exePath = path.join(data.InstallLocation, data.LaunchExecutable);
      if (!fs.existsSync(exePath)) continue;
      out.push({
        id: crypto.randomUUID(),
        name: data.DisplayName || path.basename(data.InstallLocation),
        exePath,
        description: "",
        iconDataUrl: null,
        backgroundDataUrl: null,
        savePath: null,
        source: "epic",
        createdAt: Date.now(),
      });
    } catch {
      /* битый манифест — пропускаем */
    }
  }
  return out;
}

/** Сканирует Steam+Epic и добавляет в библиотеку только новые (по exePath) записи. */
export async function autoScan(): Promise<{ added: number; scanned: { steam: number; epic: number } }> {
  const [steam, epic] = await Promise.all([scanSteam(), scanEpic()]);
  const all = readLibrary();
  const known = new Set(all.map((x) => x.exePath.toLowerCase()));
  let added = 0;
  for (const g of [...steam, ...epic]) {
    if (known.has(g.exePath.toLowerCase())) continue;
    all.push(g);
    known.add(g.exePath.toLowerCase());
    added++;
  }
  writeLibrary(all);
  logger.info("games.autoScan", { added, steam: steam.length, epic: epic.length });
  return { added, scanned: { steam: steam.length, epic: epic.length } };
}
