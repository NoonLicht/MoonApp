import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import en from "@/i18n/en.json";

/**
 * Локализация построена на отдельных JSON-файлах в папке src/i18n/<код>.json
 * (два языка: en и ru).
 *
 * В стартовый бандл входит только en (он же фолбэк для недостающих ключей).
 * Остальные словари — отдельные чанки и грузятся при выборе языка: раньше все
 * словари статически импортировались и парсились при каждом старте.
 *
 * Чтобы добавить новый язык:
 *   1) скопируйте src/i18n/en.json как src/i18n/xx.json и переведите значения;
 *      в конце файла оставьте/поправьте поле "_meta": { "code": "xx", "native": "Родное название" }.
 *   2) добавьте { code: "xx", native: "..." } в LANGS ниже (загрузчик найдёт файл сам).
 *   3) `npm run check:i18n` проверит, что переведены все ключи.
 */

type Dict = Record<string, unknown>;

// Список языков + их «родное» название (дублирует _meta.native каждого JSON —
// чтобы селект языка не тянул все словари; сверяется тестом i18nComplete).
export const LANGS: readonly { code: string; native: string }[] = [
  { code: "en", native: "English" },
  { code: "ru", native: "Русский" },
];

const LOADERS = import.meta.glob<Dict>(["@/i18n/*.json", "!@/i18n/en.json"], {
  import: "default",
});

const DICT: Record<string, Dict> = { en: en as Dict };

/** Язык, который сейчас показывает I18nProvider (для кода вне React-дерева). */
let currentLang = "en";

/** Загрузить словарь языка (повторно не грузит). Неизвестный язык → en. */
export function loadLang(lang: string): Promise<void> {
  if (DICT[lang]) return Promise.resolve();
  const loader = LOADERS[`/src/i18n/${lang}.json`];
  if (!loader) return Promise.resolve();
  return loader().then((d) => {
    DICT[lang] = d;
  });
}

function resolve(obj: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, k) => {
    if (acc != null && typeof acc === "object") return (acc as Dict)[k];
    return null;
  }, obj);
}

function format(str: string, params?: Record<string, unknown>): string {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] != null ? String(params[k]) : m));
}

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function translate(lang: string, key: string, params?: Record<string, unknown>): string {
  let val = resolve(DICT[lang] || DICT.en, key);
  if (val == null) val = resolve(DICT.en, key);
  if (val == null || typeof val !== "string") return key;
  return format(val, params);
}

interface I18nValue {
  lang: string;
  t: TranslateFn;
}

const LANG_KEY = "moonapp.lang";

/** Язык прошлого запуска (localStorage) — чтобы грузить его словарь до первого кадра. */
export function storedLang(): string {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (l && LANGS.some((x) => x.code === l)) return l;
  } catch {
    /* localStorage недоступен */
  }
  return "en";
}

/** Запомнить выбранный язык для следующего запуска. */
export function rememberLang(lang: string): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* не критично */
  }
}

/** Загрузить все словари разом (для тестов, где интерфейс рендерится синхронно). */
export function preloadLangs(): Promise<void> {
  return Promise.all(LANGS.map((l) => loadLang(l.code))).then(() => undefined);
}

/**
 * Перевод вне компонентов (форматтеры, подписи в константах): берёт язык,
 * выставленный провайдером. Внутри компонентов используйте useI18n().t —
 * он ещё и перерисует компонент при смене языка.
 */
export function tNow(key: string, params?: Record<string, unknown>): string {
  return translate(currentLang, key, params);
}

const I18nContext = createContext<I18nValue>({ lang: "en", t: (key) => key });

export function I18nProvider({ lang, children }: { lang: string; children: ReactNode }) {
  // Пока словарь нового языка грузится, показываем прежний язык, а не ключи
  // и не мигание через en: переключение происходит одним кадром.
  const [shown, setShown] = useState(() => (DICT[lang] ? lang : "en"));
  useEffect(() => {
    rememberLang(lang);
    let alive = true;
    loadLang(lang)
      .then(() => alive && setShown(DICT[lang] ? lang : "en"))
      .catch(() => alive && setShown("en"));
    return () => {
      alive = false;
    };
  }, [lang]);
  currentLang = shown;
  const value = useMemo<I18nValue>(
    () => ({ lang: shown, t: (key, params) => translate(shown, key, params) }),
    [shown],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
