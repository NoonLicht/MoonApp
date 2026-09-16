import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import en from "@/i18n/en.json";
import ru from "@/i18n/ru.json";
import es from "@/i18n/es.json";
import fr from "@/i18n/fr.json";
import zh from "@/i18n/zh.json";
import ar from "@/i18n/ar.json";

/**
 * Локализация построена на отдельных JSON-файлах в папке src/i18n/<код>.json
 * (6 официальных языков ООН: en, ru, es, fr, zh, ar).
 *
 * Чтобы добавить новый язык:
 *   1) скопируйте src/i18n/en.json как src/i18n/xx.json и переведите значения;
 *      в конце файла оставьте/поправьте поле "_meta": { "code": "xx", "native": "Родное название" }.
 *   2) добавьте import xx from "./i18n/xx.json";
 *   3) добавьте xx в объект __FILES ниже.
 */

type Dict = Record<string, unknown>;

const __FILES: Record<string, Dict> = {
  en: en as Dict,
  ru: ru as Dict,
  es: es as Dict,
  fr: fr as Dict,
  zh: zh as Dict,
  ar: ar as Dict,
};

// Список языков + их «родное» название (из _meta каждого JSON).
export const LANGS = Object.keys(__FILES).map((code) => ({
  code,
  native: (__FILES[code]?._meta as { native?: string } | undefined)?.native || code,
}));

const DICT = __FILES;

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

const I18nContext = createContext<I18nValue>({ lang: "en", t: (key) => key });

export function I18nProvider({ lang, children }: { lang: string; children: ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({ lang, t: (key, params) => translate(lang, key, params) }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
