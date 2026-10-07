/**
 * Движок вкладки «Приватность»: удаляет конкретные файлы/ключи реестра/записи
 * логов из уже работающей системы (история оболочки, недавние файлы, кэши,
 * системные логи, история USB, буфер обмена, DNS-кэш, кэш браузеров).
 *
 * НЕ является стиранием диска: не трогает документы, фото, проекты и т.п. —
 * только служебные следы использования. См. server/ts/privacyCatalog.ts.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { removePath } from "./fsUtil";
import config from "./config";
import logger from "./logger";
import { runPs, isAdmin } from "./tuningEngine";
import { WIPE_BY_ID, WIPE_ITEMS, itemsFor } from "./privacyCatalog";
import type { PanicLogEntry, WipeOutcome } from "./privacyTypes";

function execFileAsync(
  cmd: string,
  args: string[],
  timeout = 15000,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err?.message || "") });
    });
  });
}

/** Элевация на Linux: pkexec (тот же приём, что в killSwitchLinux.ts). */
async function runPrivilegedLinux(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; error?: string }> {
  const r = await execFileAsync("pkexec", [cmd, ...args], 30000);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || "elevation_failed" };
}

function statSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Удалить все файлы/папки в каталоге (не сам каталог), опционально по маске имени. */
function wipeDirContents(dir: string, match?: RegExp): WipeOutcome {
  let removed = 0;
  let bytes = 0;
  try {
    if (!fs.existsSync(dir)) return { ok: true, removed: 0, bytes: 0 };
    for (const name of fs.readdirSync(dir)) {
      if (match && !match.test(name)) continue;
      const full = path.join(dir, name);
      bytes += dirSize(full);
      if (removePath(full)) removed++;
    }
  } catch (e) {
    return { ok: false, removed, bytes, error: (e as Error).message };
  }
  return { ok: true, removed, bytes };
}

function dirSize(p: string): number {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const name of fs.readdirSync(p)) sum += dirSize(path.join(p, name));
    return sum;
  } catch {
    return 0;
  }
}

function wipeFile(p: string): WipeOutcome {
  const bytes = statSize(p);
  if (!fs.existsSync(p)) return { ok: true, removed: 0, bytes: 0 };
  return { ok: removePath(p), removed: 1, bytes };
}

function mergeOutcomes(list: WipeOutcome[]): WipeOutcome {
  return list.reduce(
    (a, b) => ({
      ok: a.ok && b.ok,
      removed: a.removed + b.removed,
      bytes: a.bytes + b.bytes,
      error: a.error || b.error,
    }),
    { ok: true, removed: 0, bytes: 0 } as WipeOutcome,
  );
}

// ───────────────────────────────── Windows ─────────────────────────────────

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const WINDIR = process.env.WINDIR || "C:\\Windows";

async function regDeleteKey(key: string): Promise<WipeOutcome> {
  const r = await execFileAsync("reg.exe", ["delete", key, "/f"]);
  // reg delete возвращает ошибку и для «ключа не существует» — это не провал зачистки.
  if (!r.ok && !/unable to find|не удается найти/i.test(r.stderr))
    return { ok: false, removed: 0, bytes: 0, error: r.stderr.trim() };
  return { ok: true, removed: 1, bytes: 0 };
}

const WIN_EXEC: Record<string, () => Promise<WipeOutcome>> = {
  "shell-history": async () =>
    wipeFile(
      path.join(
        APPDATA,
        "Microsoft",
        "Windows",
        "PowerShell",
        "PSReadLine",
        "ConsoleHost_history.txt",
      ),
    ),
  "run-mru": () =>
    regDeleteKey("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RunMRU"),
  "search-history": () =>
    regDeleteKey("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\WordWheelQuery"),
  "recent-files": async () =>
    mergeOutcomes([
      wipeDirContents(path.join(APPDATA, "Microsoft", "Windows", "Recent")),
      wipeDirContents(
        path.join(APPDATA, "Microsoft", "Windows", "Recent", "AutomaticDestinations"),
      ),
      wipeDirContents(path.join(APPDATA, "Microsoft", "Windows", "Recent", "CustomDestinations")),
    ]),
  "activity-history": async () => {
    const base = path.join(LOCALAPPDATA, "ConnectedDevicesPlatform");
    let out: WipeOutcome = { ok: true, removed: 0, bytes: 0 };
    try {
      for (const sub of fs.existsSync(base) ? fs.readdirSync(base) : []) {
        out = mergeOutcomes([out, wipeFile(path.join(base, sub, "ActivitiesCache.db"))]);
      }
    } catch {
      /* каталога нет — нечего чистить */
    }
    return out;
  },
  "thumbnail-cache": () =>
    Promise.resolve(
      wipeDirContents(
        path.join(LOCALAPPDATA, "Microsoft", "Windows", "Explorer"),
        /^(thumbcache|iconcache)_.*\.db$/i,
      ),
    ),
  "temp-files": async () =>
    mergeOutcomes([
      wipeDirContents(path.join(LOCALAPPDATA, "Temp")),
      wipeDirContents(path.join(WINDIR, "Temp")),
    ]),
  "recycle-bin": async () => {
    const r = await runPs("Clear-RecycleBin -Force -ErrorAction SilentlyContinue");
    return { ok: true, removed: r.code === 0 ? 1 : 0, bytes: 0 };
  },
  clipboard: async () => {
    const r = await runPs(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear(); " +
        "try { [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime] | Out-Null; " +
        "[Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory() | Out-Null } catch {}",
    );
    return { ok: r.code === 0, removed: 1, bytes: 0 };
  },
  "dns-cache": async () => {
    const r = await execFileAsync("ipconfig", ["/flushdns"]);
    return { ok: r.ok, removed: r.ok ? 1 : 0, bytes: 0, error: r.ok ? undefined : r.stderr };
  },
  "browser-chrome": () =>
    Promise.resolve(
      wipeBrowserProfile(path.join(LOCALAPPDATA, "Google", "Chrome", "User Data", "Default")),
    ),
  "browser-edge": () =>
    Promise.resolve(
      wipeBrowserProfile(path.join(LOCALAPPDATA, "Microsoft", "Edge", "User Data", "Default")),
    ),
  "browser-firefox": () =>
    Promise.resolve(wipeFirefoxProfiles(path.join(APPDATA, "Mozilla", "Firefox", "Profiles"))),
  "event-logs": async () => {
    let removed = 0;
    const fails: string[] = [];
    for (const log of ["Application", "Security", "System", "Setup"]) {
      const r = await execFileAsync("wevtutil.exe", ["cl", log]);
      if (r.ok) removed++;
      else fails.push(log);
    }
    return {
      ok: fails.length === 0,
      removed,
      bytes: 0,
      error: fails.length ? `failed: ${fails.join(", ")}` : undefined,
    };
  },
  prefetch: () => Promise.resolve(wipeDirContents(path.join(WINDIR, "Prefetch"), /\.pf$/i)),
  "usb-history": async () =>
    mergeOutcomes([
      await regDeleteKey("HKLM\\SYSTEM\\CurrentControlSet\\Enum\\USBSTOR"),
      await regDeleteKey("HKLM\\SOFTWARE\\Microsoft\\Windows Portable Devices\\Devices"),
    ]),
};

function wipeBrowserProfile(dir: string): WipeOutcome {
  if (!fs.existsSync(dir)) return { ok: true, removed: 0, bytes: 0 };
  return mergeOutcomes(
    ["History", "Cookies", "Web Data", "Cache", "Code Cache", "GPUCache", "Network\\Cookies"].map(
      (f) => wipeFile(path.join(dir, f)),
    ),
  );
}

function wipeFirefoxProfiles(base: string): WipeOutcome {
  if (!fs.existsSync(base)) return { ok: true, removed: 0, bytes: 0 };
  let out: WipeOutcome = { ok: true, removed: 0, bytes: 0 };
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    out = mergeOutcomes([
      out,
      ...["places.sqlite", "cookies.sqlite", "formhistory.sqlite", "webappsstore.sqlite"].map((f) =>
        wipeFile(path.join(dir, f)),
      ),
      wipeDirContents(path.join(dir, "cache2")),
    ]);
  }
  return out;
}

// ────────────────────────────────── Linux ──────────────────────────────────

const HOME = os.homedir();

const LINUX_EXEC: Record<string, () => Promise<WipeOutcome>> = {
  "shell-history": () =>
    Promise.resolve(
      mergeOutcomes(
        [".bash_history", ".zsh_history", ".histfile", ".python_history", ".node_repl_history"].map(
          (f) => wipeFile(path.join(HOME, f)),
        ),
      ),
    ),
  "recently-used": () =>
    Promise.resolve(
      mergeOutcomes([
        wipeFile(path.join(HOME, ".local", "share", "recently-used.xbel")),
        wipeDirContents(path.join(HOME, ".local", "share", "RecentDocuments")),
      ]),
    ),
  "thumbnail-cache": () =>
    Promise.resolve(wipeDirContents(path.join(HOME, ".cache", "thumbnails"))),
  // Файлы чужих пользователей/root удалить не получится (EPERM) — removePath
  // в таком случае просто не засчитывает запись, без исключения.
  "temp-files": () => Promise.resolve(wipeDirContents("/tmp")),
  trash: () =>
    Promise.resolve(
      mergeOutcomes([
        wipeDirContents(path.join(HOME, ".local", "share", "Trash", "files")),
        wipeDirContents(path.join(HOME, ".local", "share", "Trash", "info")),
      ]),
    ),
  clipboard: async () => {
    for (const [cmd, args] of [
      ["wl-copy", ["--clear"]],
      ["xclip", ["-selection", "clipboard", "-i", "/dev/null"]],
      ["xsel", ["--clipboard", "--clear"]],
    ] as const) {
      const r = await execFileAsync(cmd, [...args]);
      if (r.ok) return { ok: true, removed: 1, bytes: 0 };
    }
    return { ok: true, removed: 0, bytes: 0 };
  },
  "dns-cache": async () => {
    const r = await execFileAsync("resolvectl", ["flush-caches"]);
    return { ok: true, removed: r.ok ? 1 : 0, bytes: 0 };
  },
  "browser-chrome": () =>
    Promise.resolve(wipeBrowserProfile(path.join(HOME, ".config", "google-chrome", "Default"))),
  "browser-firefox": () =>
    Promise.resolve(wipeFirefoxProfiles(path.join(HOME, ".mozilla", "firefox"))),
  "journal-logs": async () => {
    const r = await runPrivilegedLinux("journalctl", ["--vacuum-time=1s"]);
    return { ok: r.ok, removed: r.ok ? 1 : 0, bytes: 0, error: r.error };
  },
};

// ───────────────────────────────── состояние ─────────────────────────────────

interface State {
  history: PanicLogEntry[];
}

const PRIVACY_DIR = path.join(config.DIRS.storage, "privacy");
const STATE_FILE = path.join(PRIVACY_DIR, "state.json");

function readState(): State {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    return { history: j.history || [] };
  } catch {
    return { history: [] };
  }
}

function writeState(s: State): void {
  fs.mkdirSync(PRIVACY_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

export function historyList(): PanicLogEntry[] {
  return readState().history;
}

function execFor(id: string): (() => Promise<WipeOutcome>) | undefined {
  return process.platform === "win32" ? WIN_EXEC[id] : LINUX_EXEC[id];
}

export function availableItems(): { id: string; category: string; risk: number; admin: boolean }[] {
  const platform = process.platform === "win32" ? "win32" : "linux";
  return itemsFor(platform)
    .filter((i) => !!execFor(i.id))
    .map((i) => ({ id: i.id, category: i.category, risk: i.risk, admin: !!i.admin }));
}

export async function wipeItems(ids: string[]): Promise<{
  results: Record<string, WipeOutcome>;
  removed: number;
  bytes: number;
  failed: string[];
}> {
  const platform = process.platform === "win32" ? "win32" : "linux";
  const valid = [...new Set(ids)].filter(
    (id) => WIPE_BY_ID.get(id)?.platforms.includes(platform) && execFor(id),
  );
  const results: Record<string, WipeOutcome> = {};
  let removed = 0;
  let bytes = 0;
  const failed: string[] = [];
  const admin = platform === "win32" ? await isAdmin() : false;
  for (const id of valid) {
    const item = WIPE_BY_ID.get(id)!;
    if (item.admin && platform === "win32" && !admin) {
      results[id] = { ok: false, removed: 0, bytes: 0, error: "admin_required" };
      failed.push(id);
      continue;
    }
    try {
      const r = await execFor(id)!();
      results[id] = r;
      removed += r.removed;
      bytes += r.bytes;
      if (!r.ok) failed.push(id);
    } catch (e) {
      results[id] = { ok: false, removed: 0, bytes: 0, error: (e as Error).message };
      failed.push(id);
    }
  }
  const st = readState();
  st.history.unshift({ at: Date.now(), ids: valid, removed, bytes, failed });
  st.history.length = Math.min(st.history.length, 50);
  writeState(st);
  logger.log(failed.length ? "warn" : "action", "privacy.wipe", {
    ids: valid,
    removed,
    bytes,
    failed,
  });
  return { results, removed, bytes, failed };
}

/** Зачистить вообще всё, что доступно на этой платформе (панический режим). */
export async function panicWipe(): Promise<ReturnType<typeof wipeItems>> {
  return wipeItems(availableItems().map((i) => i.id));
}

export const ALL_ITEM_IDS = WIPE_ITEMS.map((i) => i.id);
