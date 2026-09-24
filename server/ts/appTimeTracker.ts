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

const { FILES } = config;

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

let child: ChildProcessWithoutNullStreams | null = null;
let tracking = false;

function recordSample(appName: string): void {
  const name = appName.trim();
  if (IGNORE.has(name)) return;
  const all = readAll();
  const day = todayKey();
  if (!all[day]) all[day] = {};
  all[day][name] = (all[day][name] || 0) + SAMPLE_SECONDS;
  writeAll(all);
}

export function start(): { ok: boolean; error?: string } {
  if (tracking) return { ok: true };
  if (process.platform !== "win32") return { ok: false, error: "windows_only" };
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
  if (child) {
    child.kill();
    child = null;
  }
  tracking = false;
  logger.info("appTimeTracker.stop");
  return { ok: true };
}

export function status(): { tracking: boolean } {
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

export function history(days: number): { date: string; totalSeconds: number }[] {
  const all = readAll();
  const dates = Object.keys(all).sort().slice(-Math.max(1, Math.min(90, days)));
  return dates.map((date) => ({
    date,
    totalSeconds: Object.values(all[date]).reduce((s, v) => s + v, 0),
  }));
}

// Не оставляем висящий PowerShell, если процесс сервера завершается штатно.
process.on("exit", () => {
  if (child) child.kill();
});
