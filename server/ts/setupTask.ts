/**
 * Общее состояние фоновой задачи установки: «одна задача за раз» + прогресс,
 * который опрашивает UI (стандартный способ: «одно задание за раз» — см.
 * server/ts/jobStore.ts для очереди самих тяжёлых работ).
 *
 * Зачем модуль: whisperEngine.js (модель/сборка Whisper) и diarize.js (пакеты
 * sherpa-onnx) держали ДВЕ копии одной машины состояния — тот же литерал task,
 * тот же resetTask/failTask/doneTask/cancelTask и одинаковую формулу процента
 * скачивания. Копии расходились только топиком лога и текстом ошибки «busy».
 * При установке диаризации и распознавания одновременно два скачивания писали
 * бы прогресс в одно место и «дёргали» одну полоску — поэтому флаг отмены и
 * состояние обязаны быть общими по форме и одинаковыми по поведению.
 *
 * TS-исходник, как server/ts/monitor.ts: компилируется в server/setupTask.js
 * командой `npm run compile:server`.
 */
import logger from "./logger";

/** Что именно ставится (модель, сборка, пакет) и в каком оно состоянии. */
export interface SetupTaskState {
  kind: string | null;
  state: "idle" | "working" | "done" | "error";
  id: string | null;
  progress: number;
  phase: string;
  error: string;
  received: number;
  total: number;
  at: number;
}

function idleState(): SetupTaskState {
  return {
    kind: null,
    state: "idle",
    id: null,
    progress: 0,
    phase: "",
    error: "",
    received: 0,
    total: 0,
    at: 0,
  };
}

export interface SetupTask {
  /**
   * Прямая ссылка на состояние: сюда пишут прогресс, фазу и объём скачивания
   * (task.phase = "extract", task.total = n). Для UI есть snapshot().
   */
  state: SetupTaskState;
  snapshot(): SetupTaskState;
  /** Начать новую задачу: state = working, phase = download. */
  reset(kind: string, id: string | null): void;
  /** Завершить задачу успешно. */
  done(): void;
  /** Завершить задачу ошибкой (топик лога — `<topic>.task.error`). */
  fail(e: unknown): void;
  /** Попросить отмену (флаг читает поток скачивания). */
  cancel(): SetupTaskState;
  /** Идёт ли задача сейчас. */
  isWorking(): boolean;
  /** Нужно ли прервать скачивание. */
  shouldCancel(): boolean;
  /** Единая формула прогресса из объёма: received/total -> progress 0..100. */
  setDownloadProgress(received: number, total: number): void;
}

export function createSetupTask(topic: string): SetupTask {
  // Один объект на весь срок жизни: потребители держат на него прямую ссылку
  // (`const task = setup.state`) и пишут прогресс/фазу на месте.
  const state = idleState();
  let cancelFlag = false;

  const snapshot = (): SetupTaskState => ({ ...state });

  return {
    state,
    snapshot,
    reset(kind: string, id: string | null): void {
      // Новая задача — новая отмена: иначе флаг, поднятый прошлой отменой,
      // оборвал бы только что начатое скачивание (эти сбросы были разбросаны
      // по installPackage/downloadModel/installBuild).
      cancelFlag = false;
      state.kind = kind;
      state.state = "working";
      state.id = id;
      state.progress = 0;
      state.phase = "download";
      state.error = "";
      state.received = 0;
      state.total = 0;
      state.at = Date.now();
    },
    done(): void {
      state.state = "done";
      state.phase = "";
      state.progress = 100;
    },
    fail(e: unknown): void {
      // `||`, а не `??`: пустое message раньше тоже откатывалось к String(e),
      // а сохранение прежнего текста ошибки важно — UI показывает его как есть.
      const err = e as { message?: unknown } | null | undefined;
      const message = String(err?.message || e);
      state.state = "error";
      state.phase = "";
      state.error = message;
      logger.error(`${topic}.task.error`, { kind: state.kind, id: state.id, error: message });
    },
    cancel(): SetupTaskState {
      if (state.state === "working") cancelFlag = true;
      return snapshot();
    },
    isWorking: () => state.state === "working",
    shouldCancel: () => cancelFlag,
    setDownloadProgress(received: number, total: number): void {
      state.total = total;
      state.received = received;
      state.progress = total ? Math.min(100, Math.round((100 * received) / total)) : 0;
    },
  };
}
