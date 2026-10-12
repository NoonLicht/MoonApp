import { useEffect } from "react";
import { api } from "@/api/client";

/**
 * Доступность: высокий контраст и заметное кольцо фокуса. Настройки
 * (appearance.highContrast, appearance.focusRing) превращаются в классы на
 * <html>; сами правила — в styles/theme.css. Компонент ничего не рисует.
 */
const FLAGS: Record<string, string> = {
  "appearance.highContrast": "a11y-contrast",
  "appearance.focusRing": "a11y-focus",
};

export default function A11yFlags() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (path: string, on: boolean) => root.classList.toggle(FLAGS[path], on);
    api
      .getSettings()
      .then((s) => {
        const ap = (s as { appearance?: Record<string, unknown> })?.appearance ?? {};
        apply("appearance.highContrast", !!ap.highContrast);
        apply("appearance.focusRing", !!ap.focusRing);
      })
      .catch(() => undefined);
    const onSetting = (e: Event) => {
      const { path, value } = (e as CustomEvent<{ path: string; value: unknown }>).detail || {};
      if (path in FLAGS) apply(path, !!value);
    };
    window.addEventListener("app:setting", onSetting);
    return () => window.removeEventListener("app:setting", onSetting);
  }, []);
  return null;
}
