import { BREAKPOINTS } from "../utils/useMediaQuery";

/**
 * Чистая логика сворачивания поиска в верхней панели.
 *
 * Вынесена из компонента (как browsePaging у browse-вида медиа), чтобы
 * поведение можно было проверить тестом: в тестах нет ни DOM, ни matchMedia.
 *
 * Имя файла намеренно не совпадает с ToolbarSearch.tsx даже в регистре: на
 * Windows файловая система не различает регистр, и импорт "./toolbarSearch"
 * разрешался в сам компонент (циклический импорт → пустой default export).
 */

/** Медиазапрос «панель узкая»: поле поиска прячется под кнопку-триггер. */
export const NARROW_TOOLBAR_QUERY = `(max-width: ${BREAKPOINTS.md - 1}px)`;

/**
 * true — ширины окна не хватает на поле в панели: показываем иконку-кнопку, а
 * поле переносим в поповер под панелью (порог — BREAKPOINTS.md = 1200px).
 */
export function collapseToolbarSearch(width: number): boolean {
  return width < BREAKPOINTS.md;
}
