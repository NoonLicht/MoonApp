/**
 * Кэш «живых» страниц (keep-alive).
 *
 * Зачем: при переключении вкладок страницы не размонтируются, поэтому прогресс
 * задач, введённый текст и позиция скролла сохраняются. Чтобы это не съедало
 * память, список живых страниц ограничен:
 *   1) LRU по количеству (`limit`);
 *   2) по времени простоя (`idleMs`);
 *   3) активная страница и страницы с незавершённой задачей не выгружаются.
 */

/** Варианты лимита для страницы настроек. */
export const KEEP_ALIVE_LIMITS = [3, 6, 9, 12] as const;
export const KEEP_ALIVE_DEFAULT_LIMIT = 6;
export const KEEP_ALIVE_DEFAULT_IDLE_MIN = 5;

/** Поставить страницу в начало списка (самая свежая — индекс 0). */
export function touchPage<T extends string>(alive: readonly T[], id: T): T[] {
  return [id, ...alive.filter((x) => x !== id)];
}

export interface EvictInput<T extends string> {
  /** Текущий список живых страниц: [0] — самая свежая. */
  alive: readonly T[];
  /** Видимая сейчас страница — не выгружается никогда. */
  active: T;
  /** Страницы с незавершённой задачей — не выгружаются. */
  busy: readonly string[];
  /** Когда страницу последний раз показывали (ms). */
  lastUsed: Record<string, number>;
  /** Максимум живых страниц (>= 1). */
  limit: number;
  /** Простой в ms, после которого страницу выгружаем; 0 — не выгружать по времени. */
  idleMs: number;
  /** Текущее время (ms). Параметр нужен для тестируемости. */
  now: number;
}

/**
 * Вернуть новый список живых страниц после уборки. Порядок сохраняется,
 * удаляются самые старые (хвост списка).
 */
export function evictPages<T extends string>(input: EvictInput<T>): T[] {
  const busy = new Set<string>(input.busy);
  const pinned = (id: T) => id === input.active || busy.has(id);
  const limit = Math.max(1, Math.floor(input.limit) || KEEP_ALIVE_DEFAULT_LIMIT);

  let out = input.alive.slice();

  // 1) Простой: выкидываем всё, что не показывали дольше idleMs.
  if (input.idleMs > 0) {
    out = out.filter(
      (id) => pinned(id) || input.now - (input.lastUsed[id] ?? input.now) < input.idleMs,
    );
  }

  // 2) Лимит: убираем самые старые с хвоста, пока не уложимся (пиннутые не трогаем).
  for (let i = out.length - 1; i >= 0 && out.length > limit; i--) {
    if (pinned(out[i])) continue;
    out.splice(i, 1);
  }

  return out;
}

/** Сравнить списки по значению — чтобы не дёргать setState зря. */
export function samePages<T extends string>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
