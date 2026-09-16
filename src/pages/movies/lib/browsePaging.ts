import type { MediaSummary } from "@/api/types";

/**
 * Мелочи подкачки длинных списков TMDB (см. MediaBrowse).
 *
 * TMDB отдаёт по 20 тайтлов на страницу, поэтому «весь список» собирается из
 * нескольких ответов: страницы склеиваются, а счётчик показывает прогресс.
 */

/** Стабильный ключ тайтла: один и тот же фильм может лежать в двух категориях. */
export const mediaKey = (it: Pick<MediaSummary, "kind" | "id">) => `${it.kind}-${it.id}`;

/**
 * Дописать страницу к уже загруженным тайтлам.
 *
 * В соседних страницах TMDB встречаются повторы (пересечения лент/тренды), а
 * пересборки списка при ошибке могут вернуть уже показанное — поэтому дубли
 * отбрасываем по ключу, сохраняя исходный порядок.
 */
export function mergePage(current: MediaSummary[], incoming: MediaSummary[]): MediaSummary[] {
  const seen = new Set(current.map(mediaKey));
  const out = current.slice();
  for (const it of incoming) {
    const key = mediaKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Есть ли ещё страницы: пока не дошли до последней. */
export function hasNextPage(page: number, totalPages: number): boolean {
  return page < Math.max(1, totalPages);
}

/** Номер следующей страницы; при исчерпании списка возвращает текущую. */
export function nextPage(page: number, totalPages: number): number {
  return hasNextPage(page, totalPages) ? page + 1 : page;
}

/**
 * Потолок автоподгрузки: после него страницы грузит только кнопка.
 *
 * Страховка от «бесконечной» догрузки на большом экране (сетка остаётся
 * пересечённой с областью видимости) и от сотен карточек в DOM.
 */
export const AUTO_LOAD_LIMIT = 300;

/** Нужно ли догружать страницу автоматически: есть что грузить и не превышен потолок. */
export function canAutoLoad(shown: number, page: number, totalPages: number): boolean {
  return shown < AUTO_LOAD_LIMIT && hasNextPage(page, totalPages);
}

/** «10 000» вместо «10000» в счётчиках больших подборок. */
export function formatCount(n: number, locale?: string): string {
  const num = Number.isFinite(n) ? n : 0;
  try {
    return num.toLocaleString(locale || undefined);
  } catch {
    return String(num);
  }
}
