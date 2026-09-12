import { useEffect, useState } from "react";

/**
 * Хук-обёртка над window.matchMedia.
 *
 * Зачем: адаптив приложения держится на единой шкале брейкпоинтов
 * (см. `src/App.tsx` → BREAKPOINTS и CSS-медиазапросы с теми же числами).
 * CSS-медиазапросов хватает для вёрстки, но некоторым местам нужно знать
 * ширину и в JS — например, чтобы задать стартовое состояние панели чата
 * или переключить нижний док в вертикальный режим.
 *
 * SSR-safe: при недоступном matchMedia (или отсутствии window) возвращает false.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Синхронизируемся на случай, если запрос изменился между рендерами.
    setMatches(mql.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange); // старый Safari/Electron
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}

/** Единая шкала брейкпоинтов приложения (те же числа — в CSS-медиазапросах). */
export const BREAKPOINTS = {
  /** Минимальный режим: одна колонка, ужатые отступы. */
  xs: 640,
  /** Узкий режим: одна колонка, боковая панель чата — drawer. */
  sm: 900,
  /** Промежуточный режим. */
  md: 1200,
  /** Ограничитель ширины контента на ultrawide-мониторах. */
  contentMax: 1680,
} as const;
