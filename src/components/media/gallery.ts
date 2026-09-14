/**
 * Логика ленты галереи карточки тайтла.
 *
 * Галерея — это один плоский список (кадры + постеры), а лайтбокс хранит лишь
 * индекс в нём (см. MediaDetailModal). Вынесено отдельно от компонента, чтобы
 * листание можно было покрыть простыми юнит-тестами без DOM.
 */

/** Шаг по ленте: листается по кругу — с последнего кадра на первый и наоборот. */
export function stepIndex(current: number | null, dir: number, total: number): number | null {
  if (current == null || total <= 0) return current;
  return (current + dir + total) % total;
}
