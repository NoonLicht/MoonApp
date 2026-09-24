/**
 * Диспетчер фоновых задач — единая точка агрегации активных job'ов со всех
 * "тяжёлых" движков приложения (компрессия, апскейл, озвучка, лекции,
 * веб-архиватор), чтобы:
 *  1. UI мог показать ОДИН список "что сейчас выполняется" вместо того, чтобы
 *     пользователь искал прогресс по разным страницам (см. AUDIT_REPORT.md,
 *     раздел 10 — "Единый Диспетчер фоновых задач").
 *  2. При закрытии приложения можно было остановить/прервать всё активное
 *     ОДНИМ вызовом (killAllActive) — раньше дочерние процессы (ffmpeg/TTS/
 *     whisper) при резком выходе могли оставаться висеть в фоне (см. раздел 7
 *     аудита, "нет централизованного завершения процессов при quit").
 *
 * Как это устроено: каждый движок сам регистрирует "провайдера" при загрузке
 * своего модуля (см. низ compressor.ts/tts.ts/sitebak.ts/upscale/jobs.ts) —
 * этот модуль НИЧЕГО не импортирует из движков (иначе получился бы цикл
 * зависимостей compressor -> taskRegistry -> compressor), только держит их
 * список и опрашивает по требованию.
 *
 * TS-исходник, компилируется в server/taskRegistry.js (npm run compile:server).
 */
import logger from "./logger";

/** Одна задача в нормализованном виде — то, что видит Task Manager UI. */
export interface TmTask {
  /** Уникален в рамках движка; итоговый id для фронта — `${engine}:${id}`. */
  id: string;
  engine: string;
  /** Человекочитаемое название (имя файла/тайтл), не техническое. */
  label: string;
  /** Короткая фаза ("encode", "download", "transcribe", …) — движок сам решает текст. */
  stage: string;
  /** 0..100, либо -1, если прогресс неизвестен (напр. подключение к движку). */
  progress: number;
  createdAt: number;
  done: boolean;
  error?: string | null;
  canCancel: boolean;
  canPause: boolean;
  paused: boolean;
}

export interface TaskProvider {
  engine: string;
  list(): TmTask[];
  cancel(id: string): boolean;
  pause?(id: string): boolean;
  resume?(id: string): boolean;
}

const providers = new Map<string, TaskProvider>();

/** Движок вызывает это один раз при загрузке своего модуля. */
export function registerProvider(p: TaskProvider): void {
  providers.set(p.engine, p);
}

/** Все активные (и недавно завершённые — решает сам движок) задачи всех движков. */
export function listAll(): TmTask[] {
  const out: TmTask[] = [];
  for (const p of providers.values()) {
    try {
      out.push(...p.list());
    } catch (e) {
      // Один сломанный провайдер не должен обрушивать весь дэшборд.
      logger.error("taskRegistry.list_failed", { engine: p.engine, error: String(e) });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function withProvider<T>(engine: string, fn: (p: TaskProvider) => T, fallback: T): T {
  const p = providers.get(engine);
  if (!p) return fallback;
  try {
    return fn(p);
  } catch (e) {
    logger.error("taskRegistry.action_failed", { engine, error: String(e) });
    return fallback;
  }
}

export function cancel(engine: string, id: string): boolean {
  return withProvider(engine, (p) => p.cancel(id), false);
}
export function pause(engine: string, id: string): boolean {
  return withProvider(engine, (p) => (p.pause ? p.pause(id) : false), false);
}
export function resume(engine: string, id: string): boolean {
  return withProvider(engine, (p) => (p.resume ? p.resume(id) : false), false);
}

/**
 * Остановить всё активное — вызывается ОДИН раз из electron/main.js перед
 * закрытием приложения (before-quit), синхронно в том же процессе (Express и
 * Electron main — один Node-процесс, см. server/index.js из electron/main.js).
 * Каждый cancel() — это, как правило, taskkill дерева процессов (Windows),
 * поэтому вызов не блокирует надолго, но не ждём завершения: приложение и так
 * закрывается, а зависший процесс лучше убить сразу, чем ждать.
 */
export function killAllActive(): number {
  let n = 0;
  for (const p of providers.values()) {
    let tasks: TmTask[];
    try {
      tasks = p.list();
    } catch {
      continue;
    }
    for (const t of tasks) {
      if (t.done) continue;
      try {
        if (p.cancel(t.id)) n++;
      } catch {
        /* приложение и так закрывается — не дать одному сбою остановить остальные */
      }
    }
  }
  if (n) logger.info("taskRegistry.kill_all_active", { count: n });
  return n;
}
