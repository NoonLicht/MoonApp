/** Контракты API дневника (server/ts/diary.ts, routes/diary.ts). Только типы. */

export interface DiaryListItem {
  date: string;
  words: number;
  /** Первая непустая строка без разметки — подпись дня в списке. */
  preview: string;
}

export interface DiaryEntry {
  date: string;
  content: string;
  exists: boolean;
}

export interface DigestLabels {
  title: string;
  entries: string;
  tasksDone: string;
  tasksCreated: string;
  notes: string;
  lectures: string;
  nothing: string;
}

export interface WeekSummaryResult {
  start: string;
  end: string;
  /** Итог от ИИ или (если ИИ недоступен) цифровая сводка. */
  markdown: string;
  /** true — текст написала модель; false — запасная сводка без ИИ. */
  ai: boolean;
  /** Почему ИИ не использован (код ошибки провайдера), если ai=false. */
  aiError?: string;
  provider?: string;
  model?: string;
}

/** Сохранённый итог недели (storage/diary/_week_<понедельник>.json). */
export interface SavedWeekSummary {
  exists: boolean;
  start: string;
  end: string;
  markdown: string;
  /** true — текст написала модель (возможно, потом отредактирован вручную). */
  ai: boolean;
  provider?: string;
  model?: string;
  /** Пользователь правил текст после генерации. */
  edited?: boolean;
  updatedAt?: string;
}
