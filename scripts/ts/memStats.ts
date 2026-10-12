/** Обработка замеров памяти для scripts/ts/memProfile.ts (чистые функции — под тесты). */

export interface MemSample {
  /** Секунды от начала замера. */
  t: number;
  /** Resident set size, МБ. */
  rssMb: number;
}

export interface MemVerdict {
  startMb: number;
  endMb: number;
  peakMb: number;
  /** Наклон линейной регрессии, МБ в час. */
  slopeMbPerHour: number;
  /** Рост считается утечкой, если он устойчивый и выше порога. */
  leaking: boolean;
}

/** МНК: наклон прямой rss(t), МБ/сек. Меньше двух точек — 0. */
export function slope(samples: MemSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  const mt = samples.reduce((a, s) => a + s.t, 0) / n;
  const mm = samples.reduce((a, s) => a + s.rssMb, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.t - mt) * (s.rssMb - mm);
    den += (s.t - mt) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Вердикт по замерам. Первые `warmupShare` точек отбрасываются: при старте память
 * растёт естественно (загрузка модулей, кэши), это не утечка.
 */
export function analyze(
  samples: MemSample[],
  opts: { thresholdMbPerHour?: number; warmupShare?: number } = {},
): MemVerdict {
  const threshold = opts.thresholdMbPerHour ?? 30;
  const warm = opts.warmupShare ?? 0.2;
  if (!samples.length) {
    return { startMb: 0, endMb: 0, peakMb: 0, slopeMbPerHour: 0, leaking: false };
  }
  const steady = samples.slice(Math.floor(samples.length * warm));
  const perHour = slope(steady) * 3600;
  return {
    startMb: samples[0].rssMb,
    endMb: samples[samples.length - 1].rssMb,
    peakMb: Math.max(...samples.map((s) => s.rssMb)),
    slopeMbPerHour: Math.round(perHour * 10) / 10,
    leaking: steady.length >= 5 && perHour > threshold,
  };
}
