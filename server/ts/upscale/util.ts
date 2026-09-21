
export function clip(v: unknown, n: number): string {
  return typeof v === "string" ? v.slice(0, n) : "";
}
/** Число в диапазоне или значение по умолчанию. */
export function num(v: unknown, min: number, max: number, def: number): number {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
}
/** Число в диапазоне или undefined (необязательные поля). */
export function numOpt(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined;
}

export function clamp(n: number, a: number, b: number): number {
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : a;
}

/**
 * Флаг из multipart-поля: UI присылает «1»/«true»/true, а `undefined` значит
 * «пользователь ничего не выбирал» — тогда берём значение по умолчанию.
 */
export function toBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

/**
 * Что реально умеет текущая сборка ffmpeg: методы аппаратного декодирования и
 * выбранные кодировщики по кодекам. Нужно панели настроек, чтобы показать
 * «NVENC»/«SVT-AV1» вместо обещания ускорения, которого нет.
 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Округлить размер вверх до кратного `a` (требование графа: CUGAN ждёт чётные). */
export function alignUp(v: number, a: number): number {
  const step = Math.max(1, Math.round(a) || 1);
  return step <= 1 ? v : Math.ceil(v / step) * step;
}

/** Выравнивание входа модели из каталога (`align`): 1 — требование не задано. */
