/**
 * Лаунчер игр/приложений: карточки с иконкой/фоном/описанием, запуск по
 * клику, менеджер сохранений (версионный zip-бэкап по указанному пути) и
 * автосбор библиотеки из Steam/Epic.
 */
import { spawn, exec, execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
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
  /** Обложка со Steam CDN (header.jpg) — не грузим на диск, просто ссылка. */
  backgroundUrl: string | null;
  savePath: string | null;
  source: "manual" | "steam" | "epic";
  /** Steam AppID — есть только у source="steam", нужен для запуска через steam://rungameid (без предупреждения "нестандартные параметры запуска") и для обложки с CDN. */
  appId: string | null;
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

export async function create(input: {
  name: string;
  exePath: string;
  description?: string;
  iconDataUrl?: string | null;
  backgroundDataUrl?: string | null;
  savePath?: string | null;
}): Promise<GameEntry> {
  // Иконка не указана вручную — пробуем вытащить встроенную иконку .exe
  // (та самая, что видна в проводнике), чтобы карточка не была голым
  // градиентом. Best-effort: не получилось — просто нет иконки, не ошибка.
  let iconDataUrl = input.iconDataUrl || null;
  if (!iconDataUrl && input.exePath && fs.existsSync(input.exePath)) {
    iconDataUrl = await extractExeIcon(input.exePath).catch(() => null);
  }
  const entry: GameEntry = {
    id: crypto.randomUUID(),
    name: String(input.name || "").trim() || path.basename(input.exePath),
    exePath: String(input.exePath || ""),
    description: String(input.description || ""),
    iconDataUrl,
    backgroundDataUrl: input.backgroundDataUrl || null,
    backgroundUrl: null,
    savePath: input.savePath || null,
    source: "manual",
    appId: null,
    createdAt: Date.now(),
  };
  const all = readLibrary();
  all.push(entry);
  writeLibrary(all);
  logger.info("games.create", { id: entry.id, name: entry.name, hasIcon: !!iconDataUrl });
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

/**
 * Запускает игру/приложение отсоединённым процессом (не привязан к жизни
 * сервера). Для Steam-игр — через протокол steam://rungameid/<appid>, а не
 * прямым запуском .exe: запуск exe в обход Steam почти всегда показывает
 * предупреждение "запустить с пользовательскими параметрами" (игра видит,
 * что её запустили не из-под Steam) и ломает оверлей/облачные сохранения.
 */
export function launch(id: string): { ok: boolean; error?: string } {
  const entry = readLibrary().find((x) => x.id === id);
  if (!entry) return { ok: false, error: "not_found" };

  if (entry.source === "steam" && entry.appId) {
    try {
      // "start" — встроенная команда cmd, не отдельный бинарь; без неё
      // Windows не понимает протокол steam:// как исполняемый файл.
      const child = spawn("cmd", ["/c", "start", "", `steam://rungameid/${entry.appId}`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      logger.info("games.launch.steam_protocol", { id, appId: entry.appId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

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

/**
 * Достаёт встроенную иконку .exe (ту же, что видна в проводнике Windows) через
 * .NET System.Drawing.Icon.ExtractAssociatedIcon — без новых npm-зависимостей,
 * тот же приём PowerShell, что уже используется в server/ts/elevate.ts.
 */
function extractExeIcon(exePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const tmpPng = path.join(os.tmpdir(), `moonapp-icon-${crypto.randomBytes(6).toString("hex")}.png`);
    const script = `
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${exePath.replace(/'/g, "''")}')
if ($icon -eq $null) { exit 1 }
$bmp = $icon.ToBitmap()
$bmp.Save('${tmpPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10000, windowsHide: true },
      (err) => {
        if (err || !fs.existsSync(tmpPng)) return resolve(null);
        try {
          const buf = fs.readFileSync(tmpPng);
          fs.rmSync(tmpPng, { force: true });
          resolve(`data:image/png;base64,${buf.toString("base64")}`);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Best-effort угадывание папки сохранений по самым частым конвенциям Windows-игр.
 * Ничего не гарантирует (тысячи игр — тысячи схем), поэтому используется только
 * как подсказка при автосборе библиотеки — пользователь всегда может поправить
 * путь вручную. Возвращает первую реально существующую папку.
 */
function guessSavePath(gameName: string): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Saved Games", gameName),
    path.join(home, "Documents", "My Games", gameName),
    path.join(home, "Documents", gameName),
    path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), gameName),
    path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), gameName),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* skip */
    }
  }
  return null;
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

/** Эвристика: самый крупный .exe в папке игры, за вычетом типовых не-игровых бинарей.
 * Используется только как fallback, когда у appmanifest нет отдельного launcher exe
 * (сам запуск всё равно идёт через steam://rungameid, не через это exe — оно нужно
 * только для менеджера сохранений/отображения, exe без appid никогда не запускается напрямую). */
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

interface AppManifest {
  appId: string;
  name: string;
  installDir: string;
}

/** Разбор appmanifest_<id>.acf — формат Steam для установленных приложений
 * (не путать с libraryfolders.vdf): содержит настоящий appid, официальное
 * имя и installdir. Гораздо надёжнее, чем угадывать exe по размеру файла. */
function parseAppManifest(acfPath: string): AppManifest | null {
  try {
    const raw = fs.readFileSync(acfPath, "utf8");
    const appId = raw.match(/"appid"\s+"(\d+)"/i)?.[1];
    const name = raw.match(/"name"\s+"([^"]+)"/i)?.[1];
    const installDir = raw.match(/"installdir"\s+"([^"]+)"/i)?.[1];
    if (!appId || !name || !installDir) return null;
    return { appId, name, installDir };
  } catch {
    return null;
  }
}

async function scanSteam(): Promise<GameEntry[]> {
  const root = await findSteamRoot();
  if (!root) return [];
  const libFile = path.join(root, "steamapps", "libraryfolders.vdf");
  const libs = new Set<string>([root, ...parseLibraryFolders(libFile)]);
  const out: GameEntry[] = [];
  for (const lib of libs) {
    const steamappsDir = path.join(lib, "steamapps");
    let acfFiles: string[];
    try {
      acfFiles = fs.readdirSync(steamappsDir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const acf of acfFiles) {
      const manifest = parseAppManifest(path.join(steamappsDir, acf));
      if (!manifest) continue;
      const gameDir = path.join(steamappsDir, "common", manifest.installDir);
      // exePath хранится только для менеджера сохранений/отображения — сам
      // запуск идёт через steam://rungameid, exePath может быть неточным.
      const exePath = pickLikelyExe(gameDir) || gameDir;
      out.push({
        id: crypto.randomUUID(),
        name: manifest.name,
        exePath,
        description: "",
        iconDataUrl: null,
        backgroundDataUrl: null,
        // Официальная обложка магазина Steam — надёжнее и красивее, чем
        // извлекать иконку из exe, и не требует скачивания на диск.
        backgroundUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${manifest.appId}/header.jpg`,
        savePath: guessSavePath(manifest.name),
        source: "steam",
        appId: manifest.appId,
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
      const name = data.DisplayName || path.basename(data.InstallLocation);
      out.push({
        id: crypto.randomUUID(),
        name,
        exePath,
        description: "",
        iconDataUrl: await extractExeIcon(exePath).catch(() => null),
        backgroundDataUrl: null,
        backgroundUrl: null,
        savePath: guessSavePath(name),
        source: "epic",
        appId: null,
        createdAt: Date.now(),
      });
    } catch {
      /* битый манифест — пропускаем */
    }
  }
  return out;
}

/** Сканирует Steam+Epic и добавляет в библиотеку только новые записи (по appId
 * для Steam — exePath там лишь best-effort и может отличаться между сканами;
 * по exePath для остальных источников). */
export async function autoScan(): Promise<{ added: number; scanned: { steam: number; epic: number } }> {
  const [steam, epic] = await Promise.all([scanSteam(), scanEpic()]);
  const all = readLibrary();
  const knownAppIds = new Set(all.filter((x) => x.appId).map((x) => x.appId));
  const knownExe = new Set(all.filter((x) => !x.appId).map((x) => x.exePath.toLowerCase()));
  let added = 0;
  for (const g of [...steam, ...epic]) {
    const isDup = g.appId ? knownAppIds.has(g.appId) : knownExe.has(g.exePath.toLowerCase());
    if (isDup) continue;
    all.push(g);
    if (g.appId) knownAppIds.add(g.appId);
    else knownExe.add(g.exePath.toLowerCase());
    added++;
  }
  writeLibrary(all);
  logger.info("games.autoScan", { added, steam: steam.length, epic: epic.length });
  return { added, scanned: { steam: steam.length, epic: epic.length } };
}
