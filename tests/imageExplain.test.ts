import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Объяснение изображения и формулы с доски (server/ts/imageExplain.ts). */
const req = createRequire(import.meta.url);
let ie: any;
beforeAll(() => {
  ie = req("../server/imageExplain");
});

describe("imageExplain", () => {
  it("cleanOcr убирает пустые строки и лишние пробелы", () => {
    expect(ie.cleanOcr("  a   b \r\n\n\n  c\t d ")).toBe("a b\nc d");
  });

  it("isUsable отсекает пустой и шумовой результат", () => {
    expect(ie.isUsable("")).toBe(false);
    expect(ie.isUsable("-- ! ?")).toBe(false);
    expect(ie.isUsable("E = mc2")).toBe(true);
  });

  it("промпты различаются по режиму и содержат текст", () => {
    expect(ie.userPrompt("explain", "ТЕКСТ", "что это?")).toContain("Вопрос пользователя: что это?");
    expect(ie.userPrompt("explain", "ТЕКСТ")).toContain("Объясни, что здесь показано");
    expect(ie.userPrompt("formulas", "x^2")).toContain("LaTeX");
    expect(ie.userPrompt("formulas", "x^2")).toContain("x^2");
    expect(ie.systemPrompt("formulas")).not.toBe(ie.systemPrompt("explain"));
  });

  it("extractLatex достаёт формулы без повторов", () => {
    const a = "1. $E=mc^2$ — энергия\n2. $$\\int_0^1 x\\,dx$$\n3. снова $E=mc^2$";
    expect(ie.extractLatex(a)).toEqual(["E=mc^2", "\\int_0^1 x\\,dx"]);
    expect(ie.extractLatex("формул нет")).toEqual([]);
  });
});
