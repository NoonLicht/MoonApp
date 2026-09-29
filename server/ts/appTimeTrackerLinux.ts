/**
 * Linux-эквивалент трекера активного окна (см. appTimeTracker.ts, где на
 * Windows это долгоживущий PowerShell-процесс с Win32 GetForegroundWindow).
 *
 * На Linux единого API для сторонних приложений нет — набор способов узнать
 * "какое окно сейчас активно" зависит от сессии/композитора:
 *
 *  - X11-сессия (включая XWayland)            — `xdotool getactivewindow getwindowname`
 *  - Sway / другие wlroots-композиторы          — `swaymsg -t get_tree`, узел с "focused": true
 *  - Hyprland                                   — `hyprctl activewindow -j`
 *  - "чистый" Wayland на GNOME/KDE без           — надёжного способа без установки
 *    отдельного расширения/скрипта нет — трекер честно сообщает о недоступности,
 *    не пытаясь угадывать активное окно другим способом.
 *
 * В отличие от Windows-ветки (один процесс, читающий stdout построчно) здесь
 * используется периодический опрос (setInterval), поскольку ни один из
 * перечисленных инструментов не отдаёт живой поток событий в удобном формате.
 */
import { execFile } from "child_process";
import config from "./config";
import logger from "./logger";

const { FILES } = config;
const SAMPLE_MS = 5000;

type DayStats = Record<string, number>;
type AllStats = Record<string, DayStats>;

function readAll(): AllStats {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    return JSON.parse(fs.readFileSync(FILES.appTimeTracker, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data: AllStats): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  fs.writeFileSync(FILES.appTimeTracker, JSON.stringify(data, null, 2), "utf8");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordSample(appName: string, seconds: number): void {
  const name = appName.trim();
  if (!name) return;
  const all = readAll();
  const day = todayKey();
  if (!all[day]) all[day] = {};
  all[day][name] = (all[day][name] || 0) + seconds;
  writeAll(all);
}

function run(cmd: string, args: string[], timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ""));
    });
  });
}

type SessionKind = "x11" | "sway" | "hyprland" | "unsupported";

function detectSession(): SessionKind {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return "hyprland";
  if (process.env.SWAYSOCK) return "sway";
  const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (sessionType === "x11" || process.env.DISPLAY) return "x11";
  return "unsupported";
}

async function activeWindowViaX11(): Promise<string | null> {
  // xdotool даёт имя приложения (класс окна) напрямую; при его отсутствии
  // используем xprop как менее удобный, но более часто предустановленный фолбэк.
  try {
    const out = await run("xdotool", ["getactivewindow", "getwindowclassname"]);
    const name = out.trim();
    if (name) return name;
  } catch {
    /* xdotool не установлен или не сработал — пробуем xprop */
  }
  try {
    const idOut = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
    const idMatch = idOut.match(/0x[0-9a-fA-F]+/);
    if (!idMatch) return null;
    const classOut = await run("xprop", ["-id", idMatch[0], "WM_CLASS"]);
    const classMatch = classOut.match(/"([^"]+)",\s*"([^"]+)"/);
    return classMatch ? classMatch[2] : null;
  } catch {
    return null;
  }
}

interface SwayNode {
  focused?: boolean;
  name?: string;
  app_id?: string;
  window_properties?: { class?: string };
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

function findFocusedSwayNode(node: SwayNode): SwayNode | null {
  if (node.focused) return node;
  for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
    const found = findFocusedSwayNode(child);
    if (found) return found;
  }
  return null;
}

async function activeWindowViaSway(): Promise<string | null> {
  try {
    const out = await run("swaymsg", ["-t", "get_tree"]);
    const tree = JSON.parse(out) as SwayNode;
    const focused = findFocusedSwayNode(tree);
    return focused?.app_id || focused?.window_properties?.class || focused?.name || null;
  } catch {
    return null;
  }
}

async function activeWindowViaHyprland(): Promise<string | null> {
  try {
    const out = await run("hyprctl", ["activewindow", "-j"]);
    const parsed = JSON.parse(out) as { class?: string; title?: string };
    return parsed.class || parsed.title || null;
  } catch {
    return null;
  }
}

async function readActiveWindow(kind: SessionKind): Promise<string | null> {
  switch (kind) {
    case "x11":
      return activeWindowViaX11();
    case "sway":
      return activeWindowViaSway();
    case "hyprland":
      return activeWindowViaHyprland();
    default:
      return null;
  }
}

let timer: NodeJS.Timeout | null = null;
let tracking = false;
let lastError: string | null = null;

export function startLinux(): { ok: boolean; error?: string } {
  if (tracking) return { ok: true };
  const kind = detectSession();
  if (kind === "unsupported") {
    lastError =
      "wayland_no_active_window_api: на этом окружении (GNOME/KDE Wayland без вспомогательного " +
      "расширения) нет надёжного способа узнать активное окно — трекер недоступен здесь, " +
      "это ограничение самого протокола Wayland, а не приложения";
    return { ok: false, error: lastError };
  }
  tracking = true;
  timer = setInterval(() => {
    void (async () => {
      const name = await readActiveWindow(kind);
      if (name) recordSample(name, SAMPLE_MS / 1000);
    })();
  }, SAMPLE_MS);
  logger.info("appTimeTrackerLinux.start", { sessionKind: kind });
  return { ok: true };
}

export function stopLinux(): { ok: boolean } {
  if (timer) clearInterval(timer);
  timer = null;
  tracking = false;
  logger.info("appTimeTrackerLinux.stop");
  return { ok: true };
}

export function statusLinux(): { tracking: boolean; error?: string } {
  return { tracking, error: tracking ? undefined : lastError || undefined };
}

process.on("exit", () => {
  if (timer) clearInterval(timer);
});
