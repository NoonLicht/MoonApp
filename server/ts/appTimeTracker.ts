/**
 * Трекер времени за приложениями: опрашивает активное (переднего плана) окно
 * Windows раз в 5 секунд через один долгоживущий PowerShell-процесс (Win32
 * GetForegroundWindow/GetWindowThreadProcessId), а не через отдельный spawn
 * на каждый замер — это ощутимо дешевле (PowerShell стартует ~200-300мс).
 * Копится в storage/app-time-tracker.json по дням.
 */
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import readline from "readline";
import config from "./config";
import logger from "./logger";
import path from "path";
import { startLinux, stopLinux, statusLinux } from "./appTimeTrackerLinux";

const { FILES } = config;
const IS_WINDOWS = process.platform === "win32";

const SAMPLE_SECONDS = 5;

const PS_SCRIPT = `
Add-Type -Name Win -Namespace Native -MemberDefinition '
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'
while ($true) {
  $h = [Native.Win]::GetForegroundWindow()
  $procId = 0
  [Native.Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    Write-Output $p.ProcessName
  } catch {
    Write-Output ""
  }
  Start-Sleep -Seconds ${SAMPLE_SECONDS}
}
`;

type DayStats = Record<string, number>; // appName -> seconds
type AllStats = Record<string, DayStats>; // "YYYY-MM-DD" -> DayStats

function readAll(): AllStats {
  try {
    return JSON.parse(fs.readFileSync(FILES.appTimeTracker, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data: AllStats): void {
  fs.writeFileSync(FILES.appTimeTracker, JSON.stringify(data, null, 2), "utf8");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// Игнорируем сам трекер/оболочку/системные "приложения" без экрана.
const IGNORE = new Set(["", "explorer", "SearchHost", "ShellExperienceHost", "TextInputHost"]);

// --- Почасовая разбивка для «Карты внимания»: дата (локальная) → час → процесс → секунды.
// Накапливается в памяти и сбрасывается на диск раз в минуту, чтобы не переписывать файл каждые 5 секунд.
type HourStats = Record<string, Record<string, Record<string, number>>>;
const HOURS_KEEP_DAYS = 60;
const hoursFile = (): string => path.join(config.DIRS.storage, "app-time-hours.json");
let hours: HourStats | null = null;
let hoursDirty = 0;

function loadHours(): HourStats {
  if (hours) return hours;
  try {
    hours = JSON.parse(fs.readFileSync(hoursFile(), "utf8")) as HourStats;
  } catch {
    hours = {};
  }
  return hours;
}

export function flushHours(): void {
  if (!hours || !hoursDirty) return;
  const keys = Object.keys(hours).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - HOURS_KEEP_DAYS))) delete hours[k];
  try {
    fs.writeFileSync(hoursFile(), JSON.stringify(hours), "utf8");
    hoursDirty = 0;
  } catch (e) {
    logger.warn("appTimeTracker.hours_write_failed", { error: (e as Error).message });
  }
}

function recordHour(appName: string, at = new Date()): void {
  const h = loadHours();
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const bucket = ((h[day] ??= {})[String(at.getHours())] ??= {});
  bucket[appName] = (bucket[appName] || 0) + SAMPLE_SECONDS;
  // сброс примерно раз в минуту (12 замеров по 5 секунд)
  if (++hoursDirty >= 12) flushHours();
}

/** Почасовая статистика за последние `days` дней (локальные даты). */
export function hourStats(days = 7): HourStats {
  const h = loadHours();
  const keys = Object.keys(h).sort().slice(-Math.max(1, days));
  const out: HourStats = {};
  for (const k of keys) out[k] = h[k];
  return out;
}

let child: ChildProcessWithoutNullStreams | null = null;
let tracking = false;

function recordSample(appName: string): void {
  const name = appName.trim();
  if (IGNORE.has(name)) return;
  recordHour(name);
  const all = readAll();
  const day = todayKey();
  if (!all[day]) all[day] = {};
  all[day][name] = (all[day][name] || 0) + SAMPLE_SECONDS;
  writeAll(all);
}

export function start(): { ok: boolean; error?: string } {
  if (tracking) return { ok: true };
  if (!IS_WINDOWS) return startLinux();
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], {
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  tracking = true;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => recordSample(line));
  child.on("close", () => {
    tracking = false;
    child = null;
  });
  child.on("error", (e) => {
    logger.error("appTimeTracker.process_error", { error: e.message });
    tracking = false;
    child = null;
  });
  logger.info("appTimeTracker.start");
  return { ok: true };
}

export function stop(): { ok: boolean } {
  if (!IS_WINDOWS) return stopLinux();
  if (child) {
    child.kill();
    child = null;
  }
  tracking = false;
  flushHours();
  logger.info("appTimeTracker.stop");
  return { ok: true };
}

export function status(): { tracking: boolean; error?: string } {
  if (!IS_WINDOWS) return statusLinux();
  return { tracking };
}

export function todayStats(): { date: string; apps: { name: string; seconds: number }[] } {
  const all = readAll();
  const day = todayKey();
  const dayStats = all[day] || {};
  const apps = Object.entries(dayStats)
    .map(([name, seconds]) => ({ name, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
  return { date: day, apps };
}

/** Суммарное время по процессам за последние `days` дней (всё хранимое, если days не задан). */
export function totalsByApp(days?: number): Record<string, number> {
  const all = readAll();
  let dates = Object.keys(all).sort();
  if (days) dates = dates.slice(-Math.max(1, days));
  const out: Record<string, number> = {};
  for (const d of dates) for (const [name, sec] of Object.entries(all[d])) out[name] = (out[name] || 0) + sec;
  return out;
}

export function history(days: number): { date: string; totalSeconds: number }[] {
  const all = readAll();
  const dates = Object.keys(all)
    .sort()
    .slice(-Math.max(1, Math.min(90, days)));
  return dates.map((date) => ({
    date,
    totalSeconds: Object.values(all[date]).reduce((s, v) => s + v, 0),
  }));
}

// Не оставляем висящий PowerShell, если процесс сервера завершается штатно.
process.on("exit", () => {
  if (child) child.kill();
});
