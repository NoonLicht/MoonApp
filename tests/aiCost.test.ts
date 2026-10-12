import { describe, it, expect } from "vitest";
import { estimateTokens, estimateCost, priceFor, formatUsd } from "../src/pages/ai-chat/lib/cost";

/** Оценка токенов и стоимости запроса (src/pages/ai-chat/lib/cost.ts). */
describe("estimateTokens", () => {
  it("кириллица тяжелее латиницы, пустая строка — 0", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
    expect(estimateTokens("абвг".repeat(10))).toBeGreaterThan(estimateTokens("abcd".repeat(10)));
  });
});

describe("priceFor / estimateCost", () => {
  it("узнаёт семейства моделей, локальные бесплатны, неизвестные — null", () => {
    expect(priceFor("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
    expect(priceFor("deepseek-chat")?.input).toBe(0.27);
    expect(priceFor("llama3.1:8b")).toEqual({ input: 0, output: 0 });
    expect(priceFor("какая-то-модель")).toBeNull();
  });

  it("считает вход с историей и ожидаемый выход", () => {
    const e = estimateCost({
      model: "gpt-4o",
      history: ["a".repeat(4000)],
      prompt: "b".repeat(400),
      expectedOutput: 1000,
    });
    expect(e.inputTokens).toBe(1100);
    expect(e.usd).toBeCloseTo((1100 * 2.5 + 1000 * 10) / 1e6, 8);
    expect(estimateCost({ model: "x", history: [], prompt: "hi" }).usd).toBeNull();
  });

  it("форматирует мелкие суммы", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.5)).toBe("$0.500");
  });
});
