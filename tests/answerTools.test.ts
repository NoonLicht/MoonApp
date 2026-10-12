import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Проверка ответов ИИ по заметкам и автосохранение (server/ts/answerTools.ts). */
const req = createRequire(import.meta.url);
let at: any;
beforeAll(() => {
  at = req("../server/answerTools");
});

describe("splitClaims", () => {
  it("режет на предложения, пропускает короткие, код и дубли", () => {
    const answer = [
      "# Итоги",
      "Земля вращается вокруг Солнца за 365 дней. Да.",
      "- Луна — спутник Земли и влияет на приливы.",
      "```python",
      "print('это код и его не проверяем вообще никак')",
      "```",
      "Земля вращается вокруг Солнца за 365 дней.",
    ].join("\n");
    expect(at.splitClaims(answer).map((c: any) => c.text)).toEqual([
      "Земля вращается вокруг Солнца за 365 дней.",
      "Луна — спутник Земли и влияет на приливы.",
    ]);
  });

  it("ограничивает число утверждений", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Это предложение номер ${i} из очень длинного ответа.`).join(" ");
    expect(at.splitClaims(many)).toHaveLength(12);
  });
});

describe("supportLevel", () => {
  it("классифицирует по оценке поиска", () => {
    expect(at.supportLevel(0.9)).toBe("supported");
    expect(at.supportLevel(0.7)).toBe("related");
    expect(at.supportLevel(0.5)).toBe("none");
    expect(at.supportLevel(null)).toBe("none");
  });
});

describe("valueScore и noteFromAnswer", () => {
  const rich = "## План\n" + "- шаг один\n- шаг два\n\n```ts\nconst a = 1;\n```\n" + "текст ".repeat(100);

  it("структурный ответ с кодом проходит порог, короткая реплика — нет", () => {
    expect(at.valueScore(rich)).toBeGreaterThanOrEqual(at.VALUE_THRESHOLD);
    expect(at.valueScore("Да, конечно, это так.")).toBeLessThan(at.VALUE_THRESHOLD);
    expect(at.valueScore("```x```\n- а\n# б")).toBeLessThan(at.VALUE_THRESHOLD); // короткое не набирает баллы
  });

  it("заметка: заголовок из ответа, стабильный путь, цитата вопроса", () => {
    const a = at.noteFromAnswer("Как сделать X?\nПодробнее", rich, { model: "m1", date: "2026-10-11" });
    expect(a.title).toBe("План");
    expect(a.path).toMatch(/^ИИ-ответы\/2026-10-11\/План [0-9a-f]{6}\.md$/);
    expect(a.content.startsWith("> **Вопрос:** Как сделать X?\n> Подробнее")).toBe(true);
    expect(a.frontmatter).toEqual({ source: "ai-chat", date: "2026-10-11", model: "m1" });
    const again = at.noteFromAnswer("другой вопрос", rich, { date: "2026-10-11" });
    expect(again.path).toBe(a.path);
  });

  it("недопустимые символы убираются из названия", () => {
    const n = at.noteFromAnswer('Что значит "a/b: c?"', "ответ", { date: "2026-01-01" });
    expect(n.title).toBe("Что значит a b c");
  });
});
