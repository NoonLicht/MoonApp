import { useEffect, useState } from "react";

/** Тёмная ли тема приложения (класс `theme-light` на оболочке `.app-shell` у светлых тем). */
export function useShellDark(): boolean {
  const read = () => !document.querySelector(".app-shell")?.classList.contains("theme-light");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const el = document.querySelector(".app-shell");
    if (!el) return;
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}
