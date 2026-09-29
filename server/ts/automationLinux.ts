/**
 * Linux-эквивалент планировщика заданий автоматизации (см. automation.ts,
 * где на Windows это обёртка над schtasks.exe и папкой "\MoonApp\").
 *
 * Основной путь — systemd --user timers (современный стандарт на
 * большинстве дистрибутивов с systemd): для каждой задачи генерируется пара
 * юнитов moonapp-<id>.service/.timer в ~/.config/systemd/user/.
 *
 * Фолбэк — обычный crontab пользователя с уникальным маркером-комментарием
 * `# moonapp:<id>` в конце строки, если systemd --user недоступен (нет
 * systemctl в PATH, либо не поднята пользовательская session bus — бывает в
 * минимальных/безголовых окружениях).
 *
 * Контракт вызова (типы, имена функций) идентичен automation.ts — на них
 * ветвится вызывающий код без изменений в маршрутах/фронтенде.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { LauncherEntry, ScheduledTask, ScheduleKind } from "./automation";
import logger from "./logger";

const UNIT_PREFIX = "moonapp-";
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const CRON_MARKER = (id: string): string => `# moonapp:${id}`;

function execFileAsync(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

let systemdAvailable: boolean | null = null;

/** systemctl в PATH И пользовательская шина запущена (иначе команды зависают/падают). */
async function systemdUserAvailable(): Promise<boolean> {
  if (systemdAvailable !== null) return systemdAvailable;
  const { ok } = await execFileAsync("systemctl", ["--user", "show-environment"]);
  systemdAvailable = ok;
  return ok;
}

function unitName(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${UNIT_PREFIX}${safe}`;
}

/** Конвертация ScheduleKind (тот же словарь, что и в UI для Windows) в OnCalendar=/секцию [Install]. */
function scheduleToTimerSection(schedule: ScheduleKind, time?: string): string {
  switch (schedule) {
    case "DAILY": {
      const t = /^\d{2}:\d{2}$/.test(time || "") ? time! : "09:00";
      return `OnCalendar=*-*-* ${t}:00\nPersistent=true`;
    }
    case "HOURLY":
      return "OnCalendar=*-*-* *:00:00\nPersistent=true";
    case "ONSTART":
      return "OnBootSec=30s";
    case "ONLOGON":
      // Юнит уже находится в user-scope systemd, который сам стартует при входе
      // пользователя — WantedBy=default.target в [Install] достаточно.
      return "OnActiveSec=1s";
    default:
      return "OnCalendar=*-*-* 09:00:00\nPersistent=true";
  }
}

function writeUnitFiles(id: string, name: string, launcher: LauncherEntry, schedule: ScheduleKind, time?: string): void {
  fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  const unit = unitName(id);
  const execLine = launcher.args ? `${launcher.exePath} ${launcher.args}` : launcher.exePath;
  const serviceContent = [
    "[Unit]",
    `Description=MoonApp automation: ${name}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${execLine}`,
    `WorkingDirectory=${path.dirname(launcher.exePath)}`,
    "",
  ].join("\n");
  const timerContent = [
    "[Unit]",
    `Description=MoonApp automation timer: ${name}`,
    "",
    "[Timer]",
    scheduleToTimerSection(schedule, time),
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(SYSTEMD_USER_DIR, `${unit}.service`), serviceContent, "utf8");
  fs.writeFileSync(path.join(SYSTEMD_USER_DIR, `${unit}.timer`), timerContent, "utf8");
}

function removeUnitFiles(id: string): void {
  const unit = unitName(id);
  for (const ext of [".service", ".timer"]) {
    try {
      fs.rmSync(path.join(SYSTEMD_USER_DIR, `${unit}${ext}`), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------- systemd --user путь ---------------------------- */

async function createViaSystemd(
  id: string,
  name: string,
  launcher: LauncherEntry,
  schedule: ScheduleKind,
  time?: string,
): Promise<{ ok: boolean; error?: string }> {
  writeUnitFiles(id, name, launcher, schedule, time);
  const unit = unitName(id);
  const reload = await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  if (!reload.ok) return { ok: false, error: reload.stderr || "systemd_daemon_reload_failed" };
  const enable = await execFileAsync("systemctl", ["--user", "enable", "--now", `${unit}.timer`]);
  if (!enable.ok) return { ok: false, error: enable.stderr || "systemd_enable_failed" };
  return { ok: true };
}

async function deleteViaSystemd(id: string): Promise<{ ok: boolean; error?: string }> {
  const unit = unitName(id);
  await execFileAsync("systemctl", ["--user", "disable", "--now", `${unit}.timer`]);
  removeUnitFiles(id);
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  return { ok: true };
}

async function listViaSystemd(): Promise<ScheduledTask[]> {
  const { ok, stdout } = await execFileAsync("systemctl", [
    "--user",
    "list-timers",
    "--all",
    "--no-legend",
    "--no-pager",
  ]);
  if (!ok) return [];
  const out: ScheduledTask[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(`${UNIT_PREFIX}`)) continue;
    const m = line.match(new RegExp(`${UNIT_PREFIX}([a-zA-Z0-9_-]+)\\.timer`));
    if (!m) continue;
    // list-timers формат: NEXT LEFT LAST PASSED UNIT ACTIVATES — берём NEXT как приблизительное next-run.
    const nextRun = line.trim().split(/\s{2,}/)[0] || "";
    out.push({ name: m[1], nextRun, status: "scheduled", schedule: "" });
  }
  return out;
}

async function runNowViaSystemd(id: string): Promise<{ ok: boolean; error?: string }> {
  const unit = unitName(id);
  const { ok, stderr } = await execFileAsync("systemctl", ["--user", "start", `${unit}.service`]);
  if (!ok) return { ok: false, error: stderr || "systemd_start_failed" };
  return { ok: true };
}

/* -------------------------------- crontab-фолбэк ------------------------------ */

async function readCrontab(): Promise<string[]> {
  const { stdout } = await execFileAsync("crontab", ["-l"]);
  return stdout.split("\n");
}

async function writeCrontab(lines: string[]): Promise<{ ok: boolean; error?: string }> {
  const tmp = path.join(os.tmpdir(), `moonapp-cron-${Date.now()}.txt`);
  fs.writeFileSync(tmp, lines.filter((l) => l.trim().length > 0).join("\n") + "\n", "utf8");
  const { ok, stderr } = await execFileAsync("crontab", [tmp]);
  fs.rmSync(tmp, { force: true });
  return ok ? { ok: true } : { ok: false, error: stderr || "crontab_write_failed" };
}

function scheduleToCronExpr(schedule: ScheduleKind, time?: string): string | null {
  switch (schedule) {
    case "DAILY": {
      const t = /^\d{2}:\d{2}$/.test(time || "") ? time! : "09:00";
      const [hh, mm] = t.split(":");
      return `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`;
    }
    case "HOURLY":
      return "0 * * * *";
    case "ONSTART":
      return "@reboot";
    case "ONLOGON":
      // cron не различает "вход пользователя" — ближайший эквивалент: тоже @reboot,
      // задокументировано как приближение (реальный аналог требует systemd).
      return "@reboot";
    default:
      return null;
  }
}

async function createViaCron(
  id: string,
  launcher: LauncherEntry,
  schedule: ScheduleKind,
  time?: string,
): Promise<{ ok: boolean; error?: string }> {
  const expr = scheduleToCronExpr(schedule, time);
  if (!expr) return { ok: false, error: "unsupported_schedule_for_cron" };
  const execLine = launcher.args ? `${launcher.exePath} ${launcher.args}` : launcher.exePath;
  const lines = await readCrontab();
  const filtered = lines.filter((l) => !l.includes(CRON_MARKER(id)));
  filtered.push(`${expr} ${execLine} ${CRON_MARKER(id)}`);
  return writeCrontab(filtered);
}

async function deleteViaCron(id: string): Promise<{ ok: boolean; error?: string }> {
  const lines = await readCrontab();
  const filtered = lines.filter((l) => !l.includes(CRON_MARKER(id)));
  return writeCrontab(filtered);
}

/* --------------------------------- Публичный API ------------------------------- */

export async function createScheduledTaskLinux(
  id: string,
  name: string,
  launcher: LauncherEntry,
  schedule: ScheduleKind,
  time?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (await systemdUserAvailable()) {
    const res = await createViaSystemd(id, name, launcher, schedule, time);
    if (res.ok) logger.info("automationLinux.createScheduledTask", { via: "systemd", id, name });
    return res;
  }
  const res = await createViaCron(id, launcher, schedule, time);
  if (res.ok) logger.info("automationLinux.createScheduledTask", { via: "cron", id, name });
  return res;
}

export async function deleteScheduledTaskLinux(id: string): Promise<{ ok: boolean; error?: string }> {
  if (await systemdUserAvailable()) return deleteViaSystemd(id);
  return deleteViaCron(id);
}

export async function listScheduledTasksLinux(): Promise<ScheduledTask[]> {
  if (await systemdUserAvailable()) return listViaSystemd();
  // cron не даёт человекочитаемого "следующего запуска" без стороннего парсера
  // расписания — показываем сам факт наличия задачи по маркеру.
  const lines = await readCrontab();
  return lines
    .filter((l) => l.includes("# moonapp:"))
    .map((l) => {
      const m = l.match(/# moonapp:([a-zA-Z0-9_-]+)/);
      return { name: m ? m[1] : "?", nextRun: "", status: "scheduled (cron)", schedule: "" };
    });
}

export async function runScheduledTaskNowLinux(id: string): Promise<{ ok: boolean; error?: string }> {
  if (await systemdUserAvailable()) return runNowViaSystemd(id);
  return { ok: false, error: "cron_manual_run_unsupported: запустите лаунчер напрямую из карточки" };
}
