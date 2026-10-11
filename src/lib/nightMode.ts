/**
 * Ночной режим мышления: глубокой ночью приложение не запрещает работать, а
 * мягко предлагает отложить решения, о которых легко пожалеть (бюджет,
 * отправка сообщений). Чистые функции + хранение «не напоминать» в localStorage.
 */

export const NIGHT_FROM = 2;
export const NIGHT_TO = 5;

/** Глубокая ночь: с 02:00 до 05:00 по местному времени. */
export function isDeepNight(d: Date = new Date(), from = NIGHT_FROM, to = NIGHT_TO): boolean {
  const h = d.getHours();
  return h >= from && h < to;
}

/** Страницы, где решения лучше отложить. */
export const NIGHT_PAGES = ["budget", "aichat", "automation", "tuning", "myspace"] as const;

export function appliesTo(page: string): boolean {
  return (NIGHT_PAGES as readonly string[]).includes(page);
}

const KEY = "moonapp.night";

/** Ключ дня «ночи»: до 05:00 это ещё предыдущая календарная дата — один отказ на ночь. */
export function nightKey(d: Date = new Date()): string {
  const x = new Date(d.getTime() - NIGHT_TO * 3_600_000);
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
}

export function isDismissed(d: Date = new Date()): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}") as { off?: boolean; until?: string };
    return v.off === true || v.until === nightKey(d);
  } catch {
    return false;
  }
}

export function dismiss(forever: boolean, d: Date = new Date()): void {
  try {
    const cur = JSON.parse(localStorage.getItem(KEY) || "{}") as { off?: boolean; until?: string };
    localStorage.setItem(KEY, JSON.stringify(forever ? { ...cur, off: true } : { ...cur, until: nightKey(d) }));
  } catch {
    /* хранилище недоступно — баннер просто появится снова */
  }
}
