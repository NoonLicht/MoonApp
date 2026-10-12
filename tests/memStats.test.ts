import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/** Анализ замеров памяти (scripts/ts/memStats.ts -> scripts/memStats.js). */
const req = createRequire(import.meta.url);
const m = (): any => req("../scripts/memStats");

const line = (n: number, k: number, base = 100) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 5, rssMb: base + k * i * 5 }));

describe("memStats", () => {
  it("slope считает наклон в МБ/сек", () => {
    expect(m().slope(line(20, 0.5))).toBeCloseTo(0.5, 6);
  });

  it("ровная память — не утечка", () => {
    expect(m().analyze(line(60, 0)).leaking).toBe(false);
  });

  it("устойчивый рост выше порога — утечка", () => {
    // 0.05 МБ/сек = 180 МБ/час
    const v = m().analyze(line(60, 0.05));
    expect(v.leaking).toBe(true);
    expect(v.slopeMbPerHour).toBeGreaterThan(100);
  });

  it("рост при прогреве не считается утечкой", () => {
    const warm = Array.from({ length: 10 }, (_, i) => ({ t: i * 5, rssMb: 50 + i * 10 }));
    const steady = Array.from({ length: 40 }, (_, i) => ({ t: (10 + i) * 5, rssMb: 140 }));
    expect(m().analyze([...warm, ...steady]).leaking).toBe(false);
  });

  it("мало точек — не делает выводов", () => {
    expect(m().analyze(line(3, 1)).leaking).toBe(false);
    expect(m().analyze([]).peakMb).toBe(0);
  });
});
