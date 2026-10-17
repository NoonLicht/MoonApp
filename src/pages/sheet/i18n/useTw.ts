import { useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";

/**
 * Подписи интерфейса «Таблиц» (лента, меню, диалоги): английский текст — ключ перевода.
 * Источники по возрастанию приоритета: каталог WordCraft (общие подписи Bold, Font, Copy…),
 * каталог GridCraft (cat/<язык>.json, генерирует scripts/ts/genSheetCatalog.mts) и наши
 * добавки (extra/<язык>.json). Нет перевода — остаётся английский.
 */
type Cat = Record<string, string>;

const SHEET = import.meta.glob<Cat>("./cat/*.json", { import: "default" });
const SHEET_EXTRA = import.meta.glob<Cat>("./extra/*.json", { import: "default" });
const WORD = import.meta.glob<Cat>("../../word/i18n/cat/*.json", { import: "default" });
const WORD_EXTRA = import.meta.glob<Cat>("../../word/i18n/extra/*.json", { import: "default" });
const CATS: Record<string, Cat> = {};
const PENDING: Record<string, Promise<void>> = {};

function load(lang: string): Promise<void> {
  if (CATS[lang]) return Promise.resolve();
  const get = (m: Record<string, () => Promise<Cat>>, k: string): Promise<Cat> =>
    m[k] ? m[k]() : Promise.resolve({});
  PENDING[lang] ??= Promise.all([
    get(WORD, `../../word/i18n/cat/${lang}.json`),
    get(WORD_EXTRA, `../../word/i18n/extra/${lang}.json`),
    get(SHEET, `./cat/${lang}.json`),
    get(SHEET_EXTRA, `./extra/${lang}.json`),
  ]).then(([w, we, s, se]) => {
    CATS[lang] = { ...w, ...we, ...s, ...se };
  });
  return PENDING[lang];
}

export type Tw = (en: string, vars?: Record<string, string | number>) => string;

/** Перевод по каталогу языка (синхронно, для кода вне React: пока каталог не загружен — английский). */
export function twFor(lang: string, en: string, vars?: Record<string, string | number>): string {
  const cat = CATS[lang];
  if (import.meta.env.DEV && cat && !(en in cat) && /[a-z]/.test(en)) {
    // Для проверки перевода в разработке: window.__shMissing — подписи без перевода в текущем языке.
    const w = window as unknown as { __shMissing?: Set<string> };
    (w.__shMissing ??= new Set()).add(en);
  }
  let s = cat?.[en] ?? en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}

/** Функция перевода подписей «Таблиц» для текущего языка приложения. */
export function useTw(): Tw {
  const { lang } = useI18n();
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    void load(lang).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [lang]);
  return (en, vars) => twFor(lang, en, vars);
}
