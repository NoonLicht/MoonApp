/**
 * Общее хранилище фоновых заданий: ограничение размера Map + очередь «одно
 * активное задание за раз».
 *
 * Зачем модуль: compressor.js, tts.js и sitebak.js держали ТРИ копии одного и
 * того же кода (trimJobs + enqueue/pump). Копии разошлись константами
 * (JOB_LIMIT 30/30/20) и строкой топика лога, хотя поведение обязано быть
 * одинаковым: не дать Map расти бесконечно и не запускать тяжёлые движки
 * (ffmpeg-энкодеры, TTS на GPU, краулер) конкурентно.
 *
 * TS-исходник, как server/ts/monitor.ts: компилируется в server/jobStore.js
 * командой `npm run compile:server`, поэтому require("./jobStore") из обычных
 * .js-модулей работает без изменений.
 */
import logger from "./logger";

/** Минимум, который нужен заданию, чтобы его можно было вытеснить из Map. */
export interface TrimmableJob {
  id: string;
  done?: boolean;
  stage?: string;
  createdAt: number;
}

/**
 * Сколько незавершённое задание может висеть в Map, прежде чем считается
 * "зависшим" и подлежит вытеснению наравне с упавшими/готовыми. Раньше
 * незавершённые не вытеснялись НИКОГДА — правильно для нормального прогресса
 * (нельзя потерять готовый файл на середине скачивания), но если дочерний
 * процесс (ffmpeg/TTS-движок/краулер) завис и никогда не пришлёт close/error,
 * запись жила вечно и Map росла без ограничения при долгой работе приложения.
 * 24 часа — заведомо больше любой реальной задачи (самая долгая — конвертация
 * больших видео/TTS на слабом железе), но достаточно, чтобы не смешивать
 * "завис" с "просто долго считает".
 */
const STALE_JOB_MS = 24 * 60 * 60 * 1000;

/**
 * Ограничивает размер Map заданий: первыми уходят самые старые завершённые и
 * упавшие. Незавершённые не вытесняются никогда, ЗА ИСКЛЮЧЕНИЕМ зависших
 * дольше STALE_JOB_MS — такие принудительно помечаются ошибкой перед
 * вытеснением, иначе Map росла бы бесконечно при зависшем дочернем процессе.
 */
export function trimJobs<T extends TrimmableJob>(jobs: Map<string, T>, limit: number): void {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (!j.done && j.stage !== "error" && now - j.createdAt > STALE_JOB_MS) {
      j.done = true;
      j.stage = "error";
      logger.warn("jobStore.stale_job_evicted", { id: j.id, ageMs: now - j.createdAt });
    }
  }
  if (jobs.size <= limit) return;
  const removable = [...jobs.values()]
    .filter((j) => j.done || j.stage === "error")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const j of removable) {
    if (jobs.size <= limit) break;
    jobs.delete(j.id);
  }
}

export interface Queue {
  /** Ставит задачу в очередь; слот запустится сам, когда освободится. */
  enqueue(task: () => unknown): void;
  /** Сколько задач ждёт (не считая активной). */
  waiting(): number;
  /** Занят ли слот прямо сейчас. */
  isBusy(): boolean;
}

/**
 * Очередь с одним рабочим слотом. Упавшая задача очередь не останавливает:
 * ошибка уходит в лог (событие `<topic>.queue`, как раньше), слот освобождается.
 */
export function createQueue(topic: string): Queue {
  let active = false;
  const pending: Array<() => unknown> = [];

  function pump(): void {
    if (active || !pending.length) return;
    active = true;
    const task = pending.shift() as () => unknown;
    Promise.resolve()
      .then(task)
      .catch((e) => logger.error(`${topic}.queue`, { error: String(e) }))
      .finally(() => {
        active = false;
        pump();
      });
  }

  return {
    enqueue(task: () => unknown): void {
      pending.push(task);
      pump();
    },
    waiting: () => pending.length,
    isBusy: () => active,
  };
}
