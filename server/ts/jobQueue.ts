/**
 * Единый планировщик фоновых задач с ресурсными слотами.
 *
 * Что было: taskRegistry только ПОКАЗЫВАЕТ задачи, а запускают их движки сами,
 * каждый со своей очередью «одна за раз» (jobStore.createQueue). Из-за этого
 * апскейл, Whisper и TTS могли одновременно занять одну видеокарту, а у
 * пользователя не было ни приоритетов, ни паузы очереди, ни автоповтора.
 *
 * Что здесь:
 *   - ресурсы (`gpu`, `cpu`, `net`) с лимитом параллельных задач на каждый;
 *   - приоритет (больше — раньше), внутри приоритета — по времени постановки;
 *   - пауза/возобновление ожидающих задач, отмена (у запущенных — через
 *     AbortSignal), повтор упавших вручную и автоматический (с задержкой);
 *   - withSlot(): «одолжить слот» для кода, который сам управляет работой
 *     (движки подключаются без перестройки — оборачивают тяжёлый участок);
 *   - провайдер для Диспетчера задач (engine "queue"): задачи видны в общем списке.
 *
 * Модуль ничего не знает о движках (иначе цикл зависимостей) — как taskRegistry.
 */
import { EventEmitter } from "events";
import logger from "./logger";
import { registerProvider, type TmTask } from "./taskRegistry";

export type Resource = "gpu" | "cpu" | "net";
export type JobState = "queued" | "paused" | "running" | "done" | "failed" | "canceled";

export interface JobContext {
  signal: AbortSignal;
  /** 0..100 */
  progress(value: number): void;
}

export interface EnqueueOptions {
  engine: string;
  label: string;
  resource: Resource;
  priority?: number;
  /** Всего попыток (по умолчанию 1 — без автоповтора). */
  maxAttempts?: number;
  /** Пауза перед повтором, мс (растёт линейно с номером попытки). */
  backoffMs?: number;
  run(ctx: JobContext): Promise<void>;
}

export interface JobInfo {
  id: string;
  engine: string;
  label: string;
  resource: Resource;
  priority: number;
  state: JobState;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Job extends JobInfo {
  /** Порядковый номер постановки — устойчивый порядок при равных приоритете и времени. */
  seq: number;
  hidden: boolean;
  opts: EnqueueOptions;
  abort: AbortController | null;
  retryTimer: NodeJS.Timeout | null;
}

const DEFAULT_LIMITS: Record<Resource, number> = { gpu: 1, cpu: 2, net: 4 };
const KEEP_FINISHED = 60;

export function createScheduler(initial: Partial<Record<Resource, number>> = {}) {
  const limits: Record<Resource, number> = { ...DEFAULT_LIMITS, ...initial };
  const running: Record<Resource, number> = { gpu: 0, cpu: 0, net: 0 };
  const jobs = new Map<string, Job>();
  const events = new EventEmitter();
  let seq = 0;
  let paused = false;

  const emit = (): void => {
    events.emit("change");
  };

  function trim(): void {
    const finished = [...jobs.values()]
      .filter((j) => ["done", "failed", "canceled"].includes(j.state))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (finished.length > KEEP_FINISHED) jobs.delete((finished.shift() as Job).id);
  }

  function pump(): void {
    if (paused) return;
    for (const res of Object.keys(limits) as Resource[]) {
      while (running[res] < limits[res]) {
        const next = [...jobs.values()]
          .filter((j) => j.state === "queued" && j.resource === res)
          .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.seq - b.seq)[0];
        if (!next) break;
        start(next);
      }
    }
  }

  function start(job: Job): void {
    job.state = "running";
    job.attempts += 1;
    job.startedAt = Date.now();
    job.abort = new AbortController();
    running[job.resource] += 1;
    emit();
    const ctx: JobContext = {
      signal: job.abort.signal,
      progress: (v) => {
        job.progress = Math.max(0, Math.min(100, Math.round(v)));
      },
    };
    Promise.resolve()
      .then(() => job.opts.run(ctx))
      .then(
        () => finish(job, job.abort?.signal.aborted ? "canceled" : "done", null),
        (e: unknown) => {
          const msg = String((e as Error)?.message ?? e).slice(0, 300);
          if (job.abort?.signal.aborted) return finish(job, "canceled", null);
          if (job.attempts < job.maxAttempts) return scheduleRetry(job, msg);
          finish(job, "failed", msg);
        },
      );
  }

  function release(job: Job): void {
    running[job.resource] = Math.max(0, running[job.resource] - 1);
  }

  function finish(job: Job, state: JobState, error: string | null): void {
    release(job);
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    if (state === "done") job.progress = 100;
    job.abort = null;
    if (state === "failed" && !job.hidden) {
      logger.warn("jobQueue.failed", { engine: job.engine, label: job.label, error });
    }
    trim();
    emit();
    pump();
  }

  function scheduleRetry(job: Job, error: string): void {
    release(job);
    job.error = error;
    job.abort = null;
    // Пока ждём повтор, слот не держим; задача «спит» в состоянии paused.
    const wait = (job.opts.backoffMs ?? 2000) * job.attempts;
    job.state = "paused";
    job.retryTimer = setTimeout(() => {
      job.retryTimer = null;
      if (job.state === "paused") job.state = "queued";
      emit();
      pump();
    }, wait);
    job.retryTimer.unref?.();
    emit();
    pump();
  }

  function make(opts: EnqueueOptions, hidden: boolean): Job {
    const id = `q${Date.now().toString(36)}${seq.toString(36)}`;
    const job: Job = {
      id,
      seq: seq++,
      engine: opts.engine,
      label: opts.label,
      resource: opts.resource,
      priority: opts.priority ?? 0,
      state: "queued",
      progress: 0,
      attempts: 0,
      maxAttempts: Math.max(1, opts.maxAttempts ?? 1),
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      hidden,
      opts,
      abort: null,
      retryTimer: null,
    };
    jobs.set(id, job);
    return job;
  }

  const api = {
    enqueue(opts: EnqueueOptions): string {
      const job = make(opts, false);
      emit();
      pump();
      return job.id;
    },

    /** Занять слот ресурса на время fn (FIFO вместе с обычными задачами). */
    withSlot<T>(resource: Resource, fn: () => Promise<T>, priority = 0): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        make(
          {
            engine: "slot",
            label: "slot",
            resource,
            priority,
            run: async () => {
              try {
                resolve(await fn());
              } catch (e) {
                reject(e);
              }
            },
          },
          true,
        );
        pump();
      });
    },

    cancel(id: string): boolean {
      const j = jobs.get(id);
      if (!j || ["done", "failed", "canceled"].includes(j.state)) return false;
      if (j.retryTimer) clearTimeout(j.retryTimer);
      j.retryTimer = null;
      if (j.state === "running") {
        j.abort?.abort(); // завершится через finish() после возврата run
      } else {
        j.state = "canceled";
        j.finishedAt = Date.now();
        emit();
      }
      return true;
    },

    /** Поставить ожидающую задачу на паузу (запущенные не прерываются). */
    pause(id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.state !== "queued") return false;
      j.state = "paused";
      emit();
      return true;
    },

    resume(id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.state !== "paused") return false;
      if (j.retryTimer) {
        clearTimeout(j.retryTimer);
        j.retryTimer = null;
      }
      j.state = "queued";
      emit();
      pump();
      return true;
    },

    /** Повторить упавшую или отменённую задачу вручную. */
    retry(id: string): boolean {
      const j = jobs.get(id);
      if (!j || (j.state !== "failed" && j.state !== "canceled")) return false;
      j.state = "queued";
      j.error = null;
      j.attempts = 0;
      j.progress = 0;
      j.finishedAt = null;
      emit();
      pump();
      return true;
    },

    /** Остановить/возобновить запуск новых задач целиком (запущенные доработают). */
    setPaused(value: boolean): void {
      paused = value;
      emit();
      if (!value) pump();
    },
    isPaused: (): boolean => paused,

    setLimit(resource: Resource, n: number): void {
      limits[resource] = Math.max(1, Math.floor(n));
      pump();
    },

    list(): JobInfo[] {
      return [...jobs.values()]
        .filter((j) => !j.hidden)
        .map(({ seq: _s, hidden: _h, opts: _o, abort: _a, retryTimer: _r, ...info }) => info)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    stats(): Record<Resource, { running: number; limit: number; waiting: number }> {
      const out = {} as Record<Resource, { running: number; limit: number; waiting: number }>;
      for (const r of Object.keys(limits) as Resource[]) {
        out[r] = {
          running: running[r],
          limit: limits[r],
          waiting: [...jobs.values()].filter((j) => j.resource === r && j.state === "queued")
            .length,
        };
      }
      return out;
    },

    on(event: "change", cb: () => void): () => void {
      events.on(event, cb);
      return () => events.off(event, cb);
    },
  };
  return api;
}

export type Scheduler = ReturnType<typeof createScheduler>;

/** Общий планировщик приложения. */
export const scheduler: Scheduler = createScheduler();

const STAGE_RU: Record<JobState, string> = {
  queued: "queued",
  paused: "paused",
  running: "running",
  done: "done",
  failed: "error",
  canceled: "canceled",
};

registerProvider({
  engine: "queue",
  list(): TmTask[] {
    return scheduler.list().map((j) => ({
      id: j.id,
      engine: "queue",
      label: j.label,
      stage: `${j.engine}:${STAGE_RU[j.state]}`,
      progress: j.state === "running" ? j.progress : j.state === "done" ? 100 : -1,
      createdAt: j.createdAt,
      done: j.state === "done" || j.state === "failed" || j.state === "canceled",
      error: j.error,
      canCancel: j.state === "queued" || j.state === "paused" || j.state === "running",
      canPause: j.state === "queued",
      paused: j.state === "paused",
    }));
  },
  cancel: (id) => scheduler.cancel(id),
  pause: (id) => scheduler.pause(id),
  resume: (id) => scheduler.resume(id),
});
