import { describe, it, expect } from "vitest";
import { stepIndex } from "../src/components/media/gallery";

/**
 * Перемотка галереи в лайтбоксе (кнопки «‹ ›» и стрелки клавиатуры):
 * индекс идёт по кругу, поэтому с последнего кадра листается на первый.
 */
describe("stepIndex (перемотка галереи)", () => {
  it("шагает вперёд по ленте", () => {
    expect(stepIndex(0, 1, 5)).toBe(1);
    expect(stepIndex(2, 1, 5)).toBe(3);
  });

  it("с последнего кадра уходит на первый и наоборот (по кругу)", () => {
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(0, -1, 5)).toBe(4);
  });

  it("лента из одного кадра остаётся на нём", () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
  });

  it("закрытый лайтбокс (null) и пустая лента не двигаются", () => {
    expect(stepIndex(null, 1, 5)).toBeNull();
    expect(stepIndex(null, -1, 0)).toBeNull();
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
