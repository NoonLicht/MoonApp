import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Детектор противоречий (server/ts/contradictions.ts). */
const req = createRequire(import.meta.url);
let c: any;
beforeAll(() => {
  c = req("../server/contradictions");
});

describe("утверждения", () => {
  it("берёт утвердительные предложения, пропускает вопросы и короткие", () => {
    const text =
      "# Заголовок\nЭто короткая.\nКофе всегда улучшает мою концентрацию на работе.\n" +
      "Как же так получилось у нас сегодня вообще?\nВ марте бюджет составлял 50000 рублей на месяц.\n";
    const claims = c.extractClaims(text);
    expect(claims.map((x: any) => x.text)).toEqual([
      "Кофе всегда улучшает мою концентрацию на работе.",
      "В марте бюджет составлял 50000 рублей на месяц.",
    ]);
  });

  it("код, ссылки и frontmatter не считаются утверждениями", () => {
    const text = "---\ntags: a\n---\n```\nвсегда возвращает значение из функции 42\n```\n[[Ссылка на заметку всегда]]";
    expect(c.extractClaims(text)).toEqual([]);
  });
});

describe("эвристика", () => {
  it("ловит отрицание при общей теме", () => {
    expect(
      c.heuristicConflict(
        "Кофе улучшает концентрацию внимания на работе.",
        "Кофе не улучшает концентрацию внимания на работе.",
      ),
    ).toBe("negation");
  });

  it("ловит разные числа", () => {
    expect(
      c.heuristicConflict(
        "Бюджет проекта составляет 50000 рублей на квартал.",
        "Бюджет проекта составляет 70000 рублей на квартал.",
      ),
    ).toBe("number");
  });

  it("не срабатывает на несвязанные и согласующиеся", () => {
    expect(c.heuristicConflict("Кошки любят молоко.", "Бюджет проекта составляет 70000 рублей.")).toBeNull();
    expect(
      c.heuristicConflict("Бюджет проекта составляет 50000 рублей на квартал.", "Бюджет проекта на квартал — 50000 рублей."),
    ).toBeNull();
  });
});

describe("вердикты модели", () => {
  it("разбирает JSON и отбрасывает некорректные", () => {
    const raw =
      'Вот: [{"n":1,"verdict":"contradiction","why":"разные цифры"},{"n":9,"verdict":"consistent"},' +
      '{"n":2,"verdict":"maybe"},{"n":2,"verdict":"unrelated","why":""}]';
    expect(c.parseVerdicts(raw, 3)).toEqual([
      { n: 1, verdict: "contradiction", why: "разные цифры" },
      { n: 2, verdict: "unrelated", why: "" },
    ]);
    expect(c.parseVerdicts("не json", 3)).toEqual([]);
  });

  it("выдерживает ближайшее к утверждению предложение", () => {
    const note = "Вступление ни о чём. Бюджет проекта составляет 70000 рублей на квартал. Заключение.";
    expect(c.bestPassage(note, "Бюджет проекта составляет 50000 рублей на квартал.")).toBe(
      "Бюджет проекта составляет 70000 рублей на квартал.",
    );
  });
});
