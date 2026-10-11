/**
 * Контракты API «Бюджета» (подписки, прогноз, импорт). ЕДИНЫЙ источник типов:
 * сервер (server/ts/budgetRecurring.ts, routes/budget.ts) и интерфейс
 * (src/api, импорт через алиас `@contracts/budget`) используют эти объявления,
 * поэтому форма ответа не может разойтись между сторонами.
 *
 * Файлы в contracts/ — только типы: без импортов из node и без кода.
 */

export type TxType = "income" | "expense";

export type RecurringInterval = "week" | "month" | "year";

/** Регулярный платёж / подписка. */
export interface Recurring {
  id: string;
  name: string;
  amount: number;
  currency: string;
  category: string;
  type: TxType;
  interval: RecurringInterval;
  /** Дата первого списания YYYY-MM-DD; от неё считаются все следующие. */
  startDate: string;
  /** Последняя дата (включительно); пусто — бессрочно. */
  endDate?: string;
  /** За сколько дней предупреждать о списании. */
  remindDays: number;
  active: boolean;
  /** Последняя дата, за которую списание уже проведено в операции. */
  lastPaid?: string;
}

export interface RecurringInput {
  name: string;
  amount: number | string;
  currency?: string;
  category?: string;
  type?: TxType;
  interval?: RecurringInterval;
  startDate?: string;
  endDate?: string;
  remindDays?: number | string;
}

export interface Upcoming {
  recurring: Recurring;
  /** Дата ближайшего непроведённого списания. */
  due: string;
  /** Дней до списания (отрицательное — просрочено). */
  inDays: number;
  /** Нужно ли показывать напоминание (попали в окно remindDays). */
  remind: boolean;
}

export interface Forecast {
  month: string;
  /** Потрачено в месяце на сегодня (только операции в валюте прогноза). */
  spentSoFar: number;
  /** Регулярные платежи, которые ещё предстоят до конца месяца. */
  recurringAhead: number;
  /** Средний «обычный» расход в день (без регулярных) за прошедшую часть месяца. */
  dailyVariable: number;
  /** Ожидаемый расход за весь месяц. */
  projectedTotal: number;
  /** Операции и платежи в другой валюте не учтены — столько штук пропущено. */
  skipped: number;
  currency: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  /** Операции, которые уже есть в базе (тот же FITID или та же дата+сумма+описание). */
  duplicates?: number;
}
