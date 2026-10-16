/**
 * Задания страницы «Фото и видео», которые считает внешний Python-инструмент (InvSR, Deep-Live-Cam).
 * За раз идёт одно задание: оба инструмента занимают видеокарту целиком.
 */
import fs from "fs";
import path from "path";
import type { ChildProcess } from "child_process";
import logger from "../logger";
import { PHOTO_DIR } from "./modelStore";
import * as py from "./pyTool";
import type { ToolId } from "./pyTool";

export type JobState = "running" | "done" | "error" | "cancelled";

export interface PhotoJob {
  id: string;
  tool: ToolId;
  state: JobState;
  progress: number;
  stage: string;
  log: string[];
  /** Имя результата в storage/photo/out (доступно по /api/photo/file/<name>). */
  out: string;
  error: string;
  startedAt: number;
  finishedAt: number;
  proc?: ChildProcess;
}

export type PhotoJobView = Omit<PhotoJob, "proc">;

export const OUT_DIR = path.join(PHOTO_DIR, "out");
const jobs = new Map<string, PhotoJob>();
const MAX_KEEP = 20;

export const view = (j: PhotoJob | undefined): PhotoJobView | null => {
  if (!j) return null;
  const { proc: _proc, ...rest } = j;
  void _proc;
  return rest;
};

export const get = (id: string): PhotoJob | undefined => jobs.get(id);
export const list = (): PhotoJobView[] =>
  [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((j) => view(j) as PhotoJobView);

export function busy(): PhotoJob | undefined {
  return [...jobs.values()].find((j) => j.state === "running");
}

/** Процент из строки tqdm/логов: «  45%|███ …». */
export function parsePercent(line: string): number | null {
  const m = /(\d{1,3})%\|/.exec(line) || /\b(\d{1,3})\s?%/.exec(line);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

export interface StartOpts {
  tool: ToolId;
  args: string[];
  /** Путь к готовому результату после успешного завершения процесса. */
  result: () => string | null;
  /** Имя копии результата в OUT_DIR. */
  outName: string;
  env?: Record<string, string>;
  /** Подписи этапов по строкам вывода. */
  stages?: [RegExp, string][];
  cleanup?: () => void;
}

export function start(o: StartOpts): PhotoJob {
  if (busy()) throw new Error("busy");
  const job: PhotoJob = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    tool: o.tool,
    state: "running",
    progress: 0,
    stage: "start",
    log: [],
    out: "",
    error: "",
    startedAt: Date.now(),
    finishedAt: 0,
  };
  jobs.set(job.id, job);
  while (jobs.size > MAX_KEEP) {
    const old = [...jobs.values()].find((j) => j.state !== "running");
    if (!old) break;
    jobs.delete(old.id);
  }
  const onLine = (line: string): void => {
    const s = line.trim();
    if (!s) return;
    job.log.push(s.length > 300 ? `${s.slice(0, 300)}…` : s);
    if (job.log.length > 120) job.log.splice(0, job.log.length - 120);
    for (const [re, stage] of o.stages || []) if (re.test(s)) job.stage = stage;
    // Проценты скачивания моделей и загрузки весов — не прогресс обработки: считаем только этап «infer».
    const p = parsePercent(s);
    if (p != null && (!o.stages?.length || job.stage === "infer"))
      job.progress = Math.max(job.progress, Math.min(99, p));
  };
  try {
    const h = py.run(o.tool, o.args, onLine, o.env);
    job.proc = h.proc;
    void h.done
      .then((code) => {
        if (job.state === "cancelled") return;
        const found = code === 0 ? o.result() : null;
        if (found && fs.existsSync(found)) {
          fs.mkdirSync(OUT_DIR, { recursive: true });
          fs.copyFileSync(found, path.join(OUT_DIR, o.outName));
          job.out = o.outName;
          job.state = "done";
          job.progress = 100;
          job.stage = "done";
        } else {
          job.state = "error";
          job.error = code === 0 ? "no_output" : `exit_${code}`;
          job.stage = "error";
        }
      })
      .catch((e) => {
        job.state = "error";
        job.error = String((e as Error).message || e);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        job.proc = undefined;
        try {
          o.cleanup?.();
        } catch {
          /* временные файлы не критичны */
        }
        logger.action("photo.job.finished", {
          tool: o.tool,
          state: job.state,
          error: job.error || null,
        });
      });
  } catch (e) {
    job.state = "error";
    job.error = String((e as Error).message || e);
    job.finishedAt = Date.now();
  }
  return job;
}

export function cancel(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.state !== "running") return false;
  j.state = "cancelled";
  j.stage = "stopped";
  j.finishedAt = Date.now();
  if (j.proc) py.killTree(j.proc);
  return true;
}
