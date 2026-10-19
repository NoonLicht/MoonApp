import os from "os";

/** Сколько логических потоков у процессора (для подписи «всего потоков»). */
export function cpuThreadCount(): number {
  try {
    return Math.max(1, (os.cpus() || []).length);
  } catch {
    return 1;
  }
}

/**
 * Сколько потоков отдать движку.
 *
 * 0 (значение по умолчанию) — **все** логические потоки процессора: раньше ноль
 * незаметно превращался в 4, и «авто» оказывалось медленнее ручного значения.
 * Положительное число — как задал пользователь.
 */
export function resolveThreads(value: unknown): number {
  const v = Math.round(Number(value) || 0);
  if (v > 0) return Math.min(v, 256);
  return cpuThreadCount();
}
