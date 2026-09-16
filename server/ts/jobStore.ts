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
 * Ограничивает размер Map заданий: первыми уходят самые старые завершённые и
 * упавшие. Незавершённые не вытесняются никогда — иначе пользователь потерял бы
 * прогресс и возможность скачать готовый файл.
 */
export function trimJobs<T extends TrimmableJob>(jobs: Map<string, T>, limit: number): void {
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
