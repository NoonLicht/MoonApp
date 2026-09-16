/**
 * Elevated Privilege Execution Manager (UAC Guard).
 *
 * winws.exe и управление службой zapret (драйвер WinDivert) требуют прав
 * администратора. Запускаем через powershell Start-Process -Verb RunAs —
 * это НЕ блокирует renderer: UAC-диалог показывается поверх, а вызывающий
 * код (Express-роут) живёт в Node-процессе и просто ждёт Promise.
 *
 * TS-исходник, как server/ts/setupTask.ts: компилируется в server/elevate.js
 * командой `npm run compile:server`, поэтому `require("./elevate")` из
 * обычных .js-модулей продолжает работать без изменений.
 */
import { spawn } from "child_process";

/** Экранирование аргумента для -ArgumentList PowerShell (одинарные кавычки). */
export function psQuote(s: unknown): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Опции запуска с элевацией. */
export interface ElevateOptions {
  /** Ждать завершения процесса (по умолчанию true) и вернуть его ExitCode. */
  wait?: boolean;
  workingDir?: string;
  /** Жёсткий таймаут: по его истечении процесс убивается. */
  timeoutMs?: number;
  /** Мягкий таймаут: вернуть `pending` и не держать вызывающий код. */
  softTimeoutMs?: number;
}

/** Результат запуска: код выхода либо pid фонового процесса, либо текст ошибки. */
export interface ElevateResult {
  ok: boolean;
  exitCode: number | null;
  pid: number | null;
  error: string | null;
  /** Мягкий таймаут истёк, процесс продолжает жить (UAC ждёт пользователя). */
  pending?: boolean;
}

/**
 * Запустить команду с элевацией (UAC).
 *
 * @param exe  путь к exe/bat
 * @param args аргументы
 * @param opts { wait, workingDir, timeoutMs, softTimeoutMs }
 */
export function runElevated(
  exe: string,
  args: string[] = [],
  opts: ElevateOptions = {},
): Promise<ElevateResult> {
  const wait = opts.wait !== false;
  const timeoutMs = opts.timeoutMs || 120000;
  // -ArgumentList с пустым массивом PowerShell отвергает — передаём только при наличии args.
  const argList = args.length ? ` -ArgumentList @(${args.map(psQuote).join(", ")})` : "";
  // -PassThru → объект процесса; -Wait → ждём завершения и берём ExitCode.
  const ps = wait
    ? `$p = Start-Process -FilePath '${String(exe).replace(/'/g, "''")}'${argList} -Verb RunAs -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode`
    : `$p = Start-Process -FilePath '${String(exe).replace(/'/g, "''")}'${argList} -Verb RunAs -PassThru -WindowStyle Hidden; Write-Output $p.Id`;
  // WorkingDirectory задаётся cwd самого powershell (см. spawn ниже).
  return new Promise((resolve) => {
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      cwd: opts.workingDir || undefined,
    });
    let stdout = "",
      stderr = "";
    let settled = false;
    // Мягкий таймаут: UAC-диалог может ждать ответа пользователя, но вызывающий
    // код не должен висеть — возвращаем pending и продолжаем работу.
    const softMs = Number(opts.softTimeoutMs) || 0;
    const softTimer = softMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: true, pending: true, exitCode: null, pid: null, error: null });
          }
        }, softMs)
      : null;
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (softTimer) clearTimeout(softTimer);
      resolve({ ok: false, exitCode: null, pid: null, error: e.message });
    });
    proc.on("close", (code) => {
      if (softTimer) clearTimeout(softTimer);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 1223 / 1226 — пользователь отменил UAC.
      if (code === 1223 || code === 1226)
        return resolve({ ok: false, exitCode: code, pid: null, error: "uac_cancelled" });
      if (wait)
        return resolve({
          ok: code === 0,
          exitCode: code,
          pid: null,
          error: code === 0 ? null : stderr.trim().slice(-300) || `exit_${code}`,
        });
      const pid = parseInt(stdout.trim(), 10);
      resolve({
        ok: Number.isFinite(pid),
        exitCode: code,
        pid: Number.isFinite(pid) ? pid : null,
        error: Number.isFinite(pid) ? null : stdout.trim() || stderr.trim().slice(-300),
      });
    });
  });
}
