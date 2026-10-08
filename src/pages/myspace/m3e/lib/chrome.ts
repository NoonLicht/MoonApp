import { useEffect, useState } from "react";
import type { Palette } from "@/pages/myspace/m3e/lib/tokens";

/**
 * Палитра «оболочки» редактора (панели, кнопки, тулбар) из темы самого приложения.
 * Сам холст и экраны рисуются палитрой документа, а интерфейс вокруг них — цветами приложения,
 * чтобы вкладка не выбивалась из остального интерфейса и менялась вместе с темой и акцентом.
 */

type Rgb = [number, number, number];

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function parse(c: string, fallback: Rgb): Rgb {
  const s = c.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return fallback;
}

const toHex = ([r, g, b]: Rgb) =>
  "#" +
  [r, g, b]
    .map((v) => clamp(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const luma = ([r, g, b]: Rgb) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/** Палитра по значениям переменных приложения (fallback — тёмная тема по умолчанию). */
export function chromeFrom(read: (name: string) => string): Palette {
  const v = (n: string, d: Rgb) => parse(read(n), d);
  const bg = v("--bg-base", [12, 14, 22]);
  const surface = v("--surface-solid", [22, 25, 39]);
  const text = v("--text-primary", [241, 240, 246]);
  const text2 = v("--text-secondary", [169, 168, 187]);
  const text3 = v("--text-tertiary", [113, 112, 138]);
  const accent = v("--amber", [240, 166, 61]);
  const violet = v("--violet", [139, 123, 240]);
  const coral = v("--coral", [234, 107, 107]);
  const dark = luma(surface) < 0.5;
  const ink: Rgb = dark ? [20, 14, 4] : [255, 255, 255];
  // на светлой теме акцент для текста затемняем, чтобы читался на светлом фоне
  const accentText = dark ? mix(accent, text, 0.12) : mix(accent, [0, 0, 0], 0.4);
  const accentLow = mix(surface, accent, dark ? 0.2 : 0.16);

  return {
    key: "app",
    label: "App",
    primary: toHex(accent),
    onPrimary: toHex(ink),
    primaryContainer: toHex(accentLow),
    onPrimaryContainer: toHex(accentText),
    inversePrimary: toHex(accent),
    secondary: toHex(text2),
    secondaryContainer: toHex(accentLow),
    onSecondaryContainer: toHex(accentText),
    tertiaryContainer: toHex(mix(surface, violet, 0.22)),
    onTertiaryContainer: toHex(dark ? mix(violet, text, 0.35) : mix(violet, [0, 0, 0], 0.4)),
    surface: toHex(surface),
    surfaceContainerLow: toHex(mix(bg, surface, 0.35)),
    surfaceContainer: toHex(bg),
    surfaceContainerHigh: toHex(mix(surface, text, 0.06)),
    surfaceContainerHighest: toHex(mix(surface, text, 0.11)),
    onSurface: toHex(text),
    onSurfaceVariant: toHex(text2),
    outline: toHex(text3),
    outlineVariant: toHex(mix(surface, text, dark ? 0.14 : 0.16)),
    inverseSurface: toHex(text),
    inverseOnSurface: toHex(bg),
    error: toHex(coral),
    onError: toHex(ink),
    errorContainer: toHex(mix(surface, coral, 0.2)),
    onErrorContainer: toHex(dark ? mix(coral, text, 0.3) : mix(coral, [0, 0, 0], 0.4)),
  };
}

export type ChromeMode = "dark" | "light";

const DARK_VARS: Record<string, string> = {
  "--bg-base": "#0c0e16",
  "--surface-solid": "#161927",
  "--text-primary": "#f1f0f6",
  "--text-secondary": "#a9a8bb",
  "--text-tertiary": "#71708a",
};
const LIGHT_VARS: Record<string, string> = {
  "--bg-base": "#eef0f6",
  "--surface-solid": "#ffffff",
  "--text-primary": "#1c1d2b",
  "--text-secondary": "#5b5b70",
  "--text-tertiary": "#8b8ba0",
};

const STORE_KEY = "m3e.chrome";

const shell = (): HTMLElement | null => document.querySelector<HTMLElement>(".app-shell");

/** Акцент приложения (он не зависит от светлой/тёмной темы). */
const appAccent = (): string => {
  const el = shell();
  return el ? getComputedStyle(el).getPropertyValue("--amber") : "";
};

export function chromeFor(mode: ChromeMode, accent = ""): Palette {
  const base = mode === "light" ? LIGHT_VARS : DARK_VARS;
  return chromeFrom((n) => (n === "--amber" ? accent : (base[n] ?? "")));
}

function loadMode(): ChromeMode {
  try {
    return localStorage.getItem(STORE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Оформление интерфейса редактора. Оно своё и не следует за темой приложения: переключатель
 * в рейле, выбор запоминается. Экраны на холсте всегда рисуются палитрой документа.
 */
export function useChrome(): { palette: Palette; mode: ChromeMode; toggle: () => void } {
  const [mode, setMode] = useState<ChromeMode>(loadMode);
  const [accent, setAccent] = useState(appAccent);
  useEffect(() => {
    const el = shell();
    if (!el || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setAccent(appAccent()));
    mo.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    return () => mo.disconnect();
  }, []);
  const toggle = () =>
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORE_KEY, next);
      } catch {
        /* без запоминания */
      }
      return next;
    });
  return { palette: chromeFor(mode, accent), mode, toggle };
}

/** Область, в которой живёт редактор: холст не всегда занимает всё окно. */
export function viewportBox(): { left: number; top: number; width: number; height: number } {
  const el = document.querySelector<HTMLElement>(".m3p-stage");
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}
