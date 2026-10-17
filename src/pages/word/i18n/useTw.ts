import { useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";

/**
 * Подписи интерфейса Word (лента, меню, диалоги) берутся из каталогов WordCraft
 * (cat/<язык>.json: «English» → перевод, генерируются scripts/genWordCatalog.mjs).
 * Английский текст — ключ: нет перевода (или язык без каталога) — остаётся английский.
 * Каталоги грузятся отдельными чанками только под выбранный язык.
 */
type Cat = Record<string, string>;

const LOADERS = import.meta.glob<Cat>("./cat/*.json", { import: "default" });
/** Строки, которых нет в каталогах WordCraft (наши собственные подписи интерфейса). */
const EXTRA = import.meta.glob<Cat>("./extra/*.json", { import: "default" });
const CATS: Record<string, Cat> = {};
const PENDING: Record<string, Promise<void>> = {};

function load(lang: string): Promise<void> {
  if (CATS[lang]) return Promise.resolve();
  const loader = LOADERS[`./cat/${lang}.json`];
  if (!loader) return Promise.resolve();
  const extra = EXTRA[`./extra/${lang}.json`];
  PENDING[lang] ??= Promise.all([loader(), extra ? extra() : Promise.resolve({} as Cat)]).then(
    ([c, e]) => {
      CATS[lang] = { ...c, ...e };
    },
  );
  return PENDING[lang];
}

export type Tw = (en: string, vars?: Record<string, string | number>) => string;

/** Перевод по каталогу языка (синхронно, для кода вне React: пока каталог не загружен — английский). */
export function twFor(lang: string, en: string, vars?: Record<string, string | number>): string {
  const cat = CATS[lang];
  if (import.meta.env.DEV && cat && !(en in cat) && /[a-z]/.test(en)) {
    // Для проверки перевода в разработке: window.__wdMissing — подписи без перевода в текущем языке.
    const w = window as unknown as { __wdMissing?: Set<string> };
    (w.__wdMissing ??= new Set()).add(en);
  }
  let s = cat?.[en] ?? en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}

/** Функция перевода подписей Word для текущего языка приложения (перерисовывается после загрузки каталога). */
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
