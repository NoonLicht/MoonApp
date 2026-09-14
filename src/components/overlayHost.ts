/**
 * Узел для модалок-порталов (см. App.tsx → <div id="overlay-root" />).
 *
 * `.content-area` объявлена как `position:relative; z-index:1` и потому создаёт
 * stacking context: модалка внутри страницы не может перекрыть `.top-toolbar`
 * (у него z-index:40), из-за чего верх карточки уезжал под верхнюю панель
 * приложения. Узел #overlay-root лежит рядом с `.content-area` внутри
 * `.app-shell` — там z-index снова работает, а переменные темы наследуются.
 */
export const OVERLAY_ROOT_ID = "overlay-root";

/** DOM-узел для портала оверлеев (null — если разметка ещё не смонтирована). */
export function getOverlayRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(OVERLAY_ROOT_ID);
}