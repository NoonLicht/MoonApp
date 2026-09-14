import { useEffect, useRef } from "react";

/**
 * Горизонтальная прокрутка карусели колесом мыши.
 *
 * В приложении скроллбары скрыты глобально (см. theme.css), поэтому у ряда
 * постеров нет визуальной подсказки, а обычное колесо скроллит страницу.
 * Здесь колесо прокручивает ряд по горизонтали; на краю ряда событие не
 * гасится, чтобы страница продолжила скроллиться как обычно.
 *
 * Слушатель навешивается нативно с `passive: false`: React-обработчик onWheel
 * регистрируется как пассивный, и preventDefault в нём не сработал бы.
 */
export function useRailWheel<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return; // shift+колесо — нативная горизонтальная прокрутка
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // трекпад: уже горизонталь
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return; // прокручивать нечего
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return; // край — отдаём событие странице
      e.preventDefault();
      el.scrollLeft = next;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return ref;
}