import { describe, it, expect } from "vitest";
import { appliesTo, isDeepNight, nightKey } from "../src/lib/nightMode";

/** Ночной режим мышления (src/lib/nightMode.ts). */
describe("nightMode", () => {
  const at = (h: number, m = 0, day = 12) => new Date(2026, 9, day, h, m);

  it("глубокая ночь — с 02:00 до 05:00", () => {
    expect(isDeepNight(at(1, 59))).toBe(false);
    expect(isDeepNight(at(2, 0))).toBe(true);
    expect(isDeepNight(at(4, 59))).toBe(true);
    expect(isDeepNight(at(5, 0))).toBe(false);
    expect(isDeepNight(at(14))).toBe(false);
  });

  it("одна «ночь» — один ключ, даже через полночь", () => {
    expect(nightKey(at(23, 30, 11))).toBe(nightKey(at(3, 0, 12)));
    expect(nightKey(at(3, 0, 12))).not.toBe(nightKey(at(3, 0, 13)));
  });

  it("подсказка только на страницах с последствиями", () => {
    expect(appliesTo("budget")).toBe(true);
    expect(appliesTo("aichat")).toBe(true);
    expect(appliesTo("music")).toBe(false);
  });
});
