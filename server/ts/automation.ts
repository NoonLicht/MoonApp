/**
 * Автоматизация: быстрый лаунчер (карточки программ/скриптов с аргументами)
 * + обёртка над Планировщиком заданий Windows (schtasks.exe) для запуска
 * этих же карточек по расписанию.
 *
 * Все задания создаются внутри собственной папки планировщика "\MoonApp\",
 * чтобы не трогать и даже не видеть чужие системные задания — список читает
 * и показывает ТОЛЬКО задания из этой папки.
 *
 * child_process вызывается через execFile/spawn с массивом аргументов (не
 * через exec со строкой) — Windows не подставляет здесь shell, поэтому
 * инъекция через имя/аргументы программы невозможна тем же способом, что и
 * в остальных local-exec утилитах проекта (netTools.ts, games.ts).
 */
import { execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";

const { FILES } = config;
const TASK_FOLDER = "\\MoonApp\\";

export interface LauncherEntry {
  id: string;
  name: string;
  exePath: string;
  args: string;
  createdAt: number;
}

function readLaunchers(): LauncherEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.automationLaunchers, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeLaunchers(items: LauncherEntry[]): void {
  fs.writeFileSync(FILES.automationLaunchers, JSON.stringify(items, null, 2), "utf8");
}

export function listLaunchers(): LauncherEntry[] {
  return readLaunchers().sort((a, b) => a.name.localeCompare(b.name));
}

export function createLauncher(input: { name: string; exePath: string; args?: string }): LauncherEntry {
  const entry: LauncherEntry = {
    id: crypto.randomUUID(),
    name: String(input.name || "").trim() || path.basename(input.exePath),
    exePath: String(input.exePath || ""),
    args: String(input.args || ""),
    createdAt: Date.now(),
  };
  const all = readLaunchers();
  all.push(entry);
  writeLaunchers(all);
  logger.info("automation.createLauncher", { id: entry.id, name: entry.name });
  return entry;
}

export function removeLauncher(id: string): boolean {
  const all = readLaunchers();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeLaunchers(next);
  return true;
}

function splitArgs(args: string): string[] {
  // Простой разбор аргументов командной строки с поддержкой "..." — этого
  // достаточно для локальных лаунчеров (не парсер произвольного shell).
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

export function launch(id: string): { ok: boolean; error?: string } {
  const entry = readLaunchers().find((x) => x.id === id);
  if (!entry) return { ok: false, error: "not_found" };
  if (!fs.existsSync(entry.exePath)) return { ok: false, error: "exe_not_found" };
  try {
    const child = spawn(entry.exePath, splitArgs(entry.args), {
      cwd: path.dirname(entry.exePath),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    logger.info("automation.launch", { id, exePath: entry.exePath });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* --- Планировщик заданий Windows (schtasks.exe), только папка \MoonApp\ --- */

export interface ScheduledTask {
  name: string;
  status: string;
  nextRun: string;
  schedule: string;
}

function execFileAsync(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Список заданий планировщика, только из папки \MoonApp\. */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const { ok, stdout } = await execFileAsync("schtasks", ["/query", "/fo", "CSV", "/nh"]);
  if (!ok) return [];
  const out: ScheduledTask[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const [name, nextRun, status] = cols;
    if (!name || !name.startsWith(TASK_FOLDER)) continue;
    out.push({ name: name.slice(TASK_FOLDER.length), nextRun: nextRun || "", status: status || "", schedule: "" });
  }
  return out;
}

export type ScheduleKind = "DAILY" | "HOURLY" | "ONLOGON" | "ONSTART";

/** Создаёт задание планировщика, запускающее указанный лаунчер по расписанию. */
export async function createScheduledTask(input: {
  name: string;
  launcherId: string;
  schedule: ScheduleKind;
  time?: string; // HH:MM, для DAILY
}): Promise<{ ok: boolean; error?: string }> {
  const launcher = readLaunchers().find((x) => x.id === input.launcherId);
  if (!launcher) return { ok: false, error: "launcher_not_found" };
  const safeName = String(input.name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (!safeName) return { ok: false, error: "missing_name" };

  const tr = launcher.args ? `"${launcher.exePath}" ${launcher.args}` : `"${launcher.exePath}"`;
  const tn = TASK_FOLDER + safeName;
  const args = ["/create", "/tn", tn, "/tr", tr, "/sc", input.schedule, "/f"];
  if (input.schedule === "DAILY") {
    const time = /^\d{2}:\d{2}$/.test(input.time || "") ? input.time! : "09:00";
    args.push("/st", time);
  }
  const { ok, stderr } = await execFileAsync("schtasks", args);
  if (!ok) return { ok: false, error: stderr || "schtasks_failed" };
  logger.info("automation.createScheduledTask", { name: safeName, schedule: input.schedule });
  return { ok: true };
}

export async function deleteScheduledTask(name: string): Promise<{ ok: boolean; error?: string }> {
  const tn = TASK_FOLDER + name;
  const { ok, stderr } = await execFileAsync("schtasks", ["/delete", "/tn", tn, "/f"]);
  if (!ok) return { ok: false, error: stderr || "schtasks_failed" };
  logger.info("automation.deleteScheduledTask", { name });
  return { ok: true };
}

export async function runScheduledTaskNow(name: string): Promise<{ ok: boolean; error?: string }> {
  const tn = TASK_FOLDER + name;
  const { ok, stderr } = await execFileAsync("schtasks", ["/run", "/tn", tn]);
  if (!ok) return { ok: false, error: stderr || "schtasks_failed" };
  return { ok: true };
}
