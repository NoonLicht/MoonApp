import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Навыки чата и судья ответов (server/ts/aiSkills.ts). */
const req = createRequire(import.meta.url);
let sk: any;
beforeAll(() => {
  sk = req("../server/aiSkills");
});

describe("навыки", () => {
  it("берёт название из frontmatter, иначе из имени файла", () => {
    expect(sk.skillFrom("Навыки/Ревью.md", "Проверяй код", { name: "Строгое ревью", description: "d" })).toEqual({
      path: "Навыки/Ревью.md",
      name: "Строгое ревью",
      description: "d",
      prompt: "Проверяй код",
    });
    expect(sk.skillFrom("Навыки/Ревью.md", "x")?.name).toBe("Ревью");
  });

  it("игнорирует чужие папки, не-md и пустые", () => {
    expect(sk.skillFrom("Другое/a.md", "x")).toBeNull();
    expect(sk.skillFrom("Навыки/a.txt", "x")).toBeNull();
    expect(sk.skillFrom("Навыки/a.md", "   ")).toBeNull();
  });

  it("склеивает несколько навыков блоками", () => {
    const a = sk.skillFrom("Навыки/A.md", "один")!;
    const b = sk.skillFrom("Навыки/B.md", "два")!;
    expect(sk.combineSkills([a, b])).toBe("### A\nодин\n\n### B\nдва");
  });
});

describe("судья", () => {
  it("разбирает JSON в ограждении и ограничивает оценки 1..10", () => {
    const v = sk.parseVerdict(
      'Вот оценка:\n```json\n{"accuracy": 12, "completeness": 7.26, "clarity": 0, "score": 8, "issues": ["а", "", "б"], "summary": " ок "}\n```',
    );
    expect(v).toEqual({
      score: 8,
      accuracy: 10,
      completeness: 7.3,
      clarity: 1,
      issues: ["а", "б"],
      summary: "ок",
    });
  });

  it("без итоговой оценки считает среднее по критериям", () => {
    const v = sk.parseVerdict('{"accuracy":6,"completeness":8,"clarity":7}');
    expect(v.score).toBe(7);
  });

  it("мусор и пустой JSON — null", () => {
    expect(sk.parseVerdict("нет json")).toBeNull();
    expect(sk.parseVerdict("{}")).toBeNull();
    expect(sk.parseVerdict("{сломано}")).toBeNull();
  });

  it("промпт содержит вопрос и ответ", () => {
    const p = sk.judgePrompt("2+2?", "4");
    expect(p).toContain("ВОПРОС:\n2+2?");
    expect(p).toContain("ОТВЕТ:\n4");
  });
});
