import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import logger from "../logger";
import type { TrackedProc } from "./types";

export function trackJobProc(jobId: string, kind: string, proc: ChildProcess | null): void {
  trackProc(jobId, kind, proc);
}

/**
 * Погасить процесс — по возможности вместе с потомками.
 *
 * `child.kill()` на Windows снимает только сам ffmpeg: если тот поднял дочерний
 * процесс (или запущен через shim-обёртку), потомок остаётся жить, и «Стоп»
 * выглядит сломанным. Поэтому сначала `taskkill /PID <pid> /T /F` (дерево
 * процессов), а обычный `kill()` — как страховка, если taskkill недоступен.
 */
function terminateProc(entry: TrackedProc): boolean {
  if (!entry.pid) return false;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          entry.proc.kill();
        } catch {
          /* процесс уже мёртв */
        }
      });
    } catch {
      /* taskkill не найден — ниже обычный kill */
    }
  }
  try {
    if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
    return true;
  } catch {
    return false;
  }
}

const jobProcs = new Map<string, Map<number, TrackedProc>>();

/** Сторож остановки: через сколько миллисекунд проверяем, что процессы умерли. */
const STOP_SWEEP_MS = 1500;

/**
 * Задание, которое считается прямо сейчас.
 *
 * Очередь (`createQueue`) запускает по одному заданию, поэтому текущий id можно
 * держать в модуле: так его видят вспомогательные ffmpeg-процессы (фото-путь,
 * пробы), куда объект задания не передать.
 */
let currentJobId = "";

/** Текущий id задания (для ffmpeg-хелперов, которым объект задания не передать). */
export function getCurrentJobId(): string {
  return currentJobId;
}

/** Установить/сбросить текущий id задания. */
export function setCurrentJobId(id: string): void {
  currentJobId = id;
}

export function trackProc(jobId: string, kind: string, proc: ChildProcess | null): void {
  // null приходит из пайплайна после закрытия: запись и так уйдёт по `close`.
  if (!proc || !jobId) return;
  let set = jobProcs.get(jobId);
  if (!set) {
    set = new Map();
    jobProcs.set(jobId, set);
  }
  const pid = proc.pid || 0;
  set.set(pid, { proc, kind, pid, killed: false });
  proc.once("close", () => {
    const cur = jobProcs.get(jobId);
    cur?.delete(pid);
    if (cur && cur.size === 0) jobProcs.delete(jobId);
  });
}

/** Погасить все ffmpeg-процессы задания. Возвращает, сколько процессов убито. */
export function killJobProcs(id: string): number {
  const set = jobProcs.get(id);
  if (!set) return 0;
  let killed = 0;
  for (const entry of [...set.values()]) {
    if (entry.proc.exitCode !== null) {
      set.delete(entry.pid);
      continue;
    }
    if (terminateProc(entry)) {
      entry.killed = true;
      killed++;
    }
  }
  if (killed) logger.action("upscale.procs_killed", { id, killed });
  if (set.size === 0) jobProcs.delete(id);
  return killed;
}

/** Сколько процессов задания ещё живо (для диагностики и сторожевого таймера). */
export function aliveJobProcs(id: string): number {
  const set = jobProcs.get(id);
  if (!set) return 0;
  let alive = 0;
  for (const entry of [...set.values()]) {
    if (entry.proc.exitCode === null) alive++;
    else set.delete(entry.pid);
  }
  if (set.size === 0) jobProcs.delete(id);
  return alive;
}

/**
 * Сторож остановки: если после «Стопа» процессы ещё живы, предупреждаем и
 * добиваем повторно.
 *
 * Без него «Стоп» иногда выглядел как «не всегда закрывает процессы»: сигнал
 * уходил, но процесс мог его пережить — или не получить вовсе (гонка с ленивым
 * стартом энкодера, shim вместо ffmpeg.exe, слишком поздняя проверка флага).
 */
export function sweepJobProcs(id: string, delayMs = STOP_SWEEP_MS): number {
  const left = aliveJobProcs(id);
  if (!left) return 0;
  if (delayMs <= 0) return killJobProcs(id);
  const timer = setTimeout(() => {
    const again = aliveJobProcs(id);
    if (!again) return;
    logger.warn("upscale.procs_alive", { id, alive: again, after: delayMs });
    killJobProcs(id);
  }, delayMs);
  timer.unref?.();
  return left;
}

/** Останавливает обработку всех незавершённых заданий (текущее — на месте). */
