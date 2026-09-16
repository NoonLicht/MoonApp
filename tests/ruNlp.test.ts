import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/ruNlp, переведённого на TS (server/ts/ruNlp.ts →
 * server/ruNlp.js).
 *
 * Модуль готовит русский текст к озвучке TTS, и цена ошибки здесь слышна:
 * «все» вместо «всё», «тысячаный год» вместо «две тысячи тринадцатый». Тесты
 * фиксируют как рабочие правила (род числительных, проценты, дроби, римские
 * числа, омографы), так и известные ограничения разбора, чтобы они не
 * «потерялись» при следующих правках.
 */
const req = createRequire(import.meta.url);

let nlp: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-runlp-"));
  nlp = req("../server/ruNlp");
});

describe("server/ruNlp — форма модуля и ёфикация", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(nlp.default).toBeUndefined();
    for (const fn of [
      "yoficate",
      "numberToRussian",
      "expandNumbers",
      "markStress",
      "protectAbbrev",
      "unprotectAbbrev",
      "chunkText",
      "normalize",
    ]) {
      expect(typeof nlp[fn], fn).toBe("function");
    }
  });

  it("ёфикация идёт по словарю; регистр — только первая буква заглавной", () => {
    expect(nlp.yoficate("Все еще пришел")).toBe("Всё ещё пришёл");
    // ВЕРХНИЙ РЕГИСТР не сохраняется: словарь отдаёт слово целиком, код делает
    // заглавной только первую букву — так было и в .js-версии.
    expect(nlp.yoficate("ЧЕРНЫЙ кот")).toBe("Чёрный кот");
  });

  it("слова вне словаря и случаи «легко/темнота» не трогаются", () => {
    expect(nlp.yoficate("кот и пёс")).toBe("кот и пёс");
    expect(nlp.yoficate("легко")).toBe("легко");
    expect(nlp.yoficate("темнота")).toBe("темнота");
    expect(nlp.yoficate(null)).toBe("");
  });
});

describe("server/ruNlp — числа прописью", () => {
  it("единицы, десятки и сотни", () => {
    expect(nlp.numberToRussian("0")).toBe("ноль");
    expect(nlp.numberToRussian("21")).toBe("двадцать один");
    expect(nlp.numberToRussian("105")).toBe("сто пять");
    expect(nlp.numberToRussian("не число")).toBe("не число");
  });

  it("тысячи — женский род (одна/две), дальше мужской", () => {
    expect(nlp.numberToRussian("1000")).toBe("одна тысяча");
    expect(nlp.numberToRussian("2000")).toBe("две тысячи");
    expect(nlp.numberToRussian("5000")).toBe("пять тысяч");
    expect(nlp.numberToRussian("2000000")).toBe("два миллиона");
  });

  it("ordinal переводит последнее слово в порядковое", () => {
    expect(nlp.numberToRussian("1", true)).toBe("первый");
    expect(nlp.numberToRussian("3", true)).toBe("третий");
    expect(nlp.numberToRussian("100", true)).toBe("сотый");
  });

  it("известное ограничение: для чисел без формы в ordMap получается «…ный»", () => {
    // «2013 г.» разворачивается как «две тысячи тринадцатьный год» — формы для
    // 13 в ordMap нет. Поведение зафиксировано, правка — отдельная задача.
    expect(nlp.numberToRussian("2013", true)).toBe("две тысячи тринадцатьный");
  });

  it("pluralForm даёт 1/2-4/5+ с учётом исключений 11-14", () => {
    expect(nlp.pluralForm(1, "час", "часа", "часов")).toBe("час");
    expect(nlp.pluralForm(3, "час", "часа", "часов")).toBe("часа");
    expect(nlp.pluralForm(5, "час", "часа", "часов")).toBe("часов");
    expect(nlp.pluralForm(11, "час", "часа", "часов")).toBe("часов");
    expect(nlp.pluralForm(22, "час", "часа", "часов")).toBe("часа");
  });
});

describe("server/ruNlp — разворот чисел в тексте", () => {
  it("время, проценты и дроби", () => {
    expect(nlp.expandNumbers("в 14:30")).toBe("в четырнадцать часов тридцать минут");
    expect(nlp.expandNumbers("50%")).toBe("пятьдесят процентов");
    expect(nlp.expandNumbers("3,14")).toBe("три запятая один четыре");
  });

  it("римские числа (2+ букв) переводятся в ЦИФРЫ, а не в слова", () => {
    // Порядок замен: сначала арабские числа → слова, потом римские → цифры.
    // Поэтому «VII» превращается в «7», а не в «семь» — поведение .js-версии.
    expect(nlp.expandNumbers("глава VII")).toBe("глава 7");
  });

  it("однозначные римские буквы не считаются числом (иначе съело бы текст)", () => {
    expect(nlp.expandNumbers("X")).toBe("X");
    expect(nlp.expandNumbers("V")).toBe("V");
  });
});

describe("server/ruNlp — ударения в омографах (известное ограничение)", () => {
  it("markStress не меняет кириллицу: \\b в JS работает только с ASCII", () => {
    // Регэксп омографов использует \b вокруг русского слова, а \b — ASCII-шный:
    // границы слова в «замок»/«мука» он не видит. Словарь ударений остаётся, но
    // фактически не срабатывает — так было и в .js-версии, правка отдельной
    // задачей (нужны Unicode-aware границы вместо \b).
    expect(nlp.markStress("висячий замок")).toBe("висячий замок");
    expect(nlp.markStress("пшеничная мука")).toBe("пшеничная мука");
    expect(nlp.markStress("замок")).toBe("замок");
  });
});

describe("server/ruNlp — защита сокращений и чанкинг", () => {
  it("protect/unprotect — обратимая пара", () => {
    const raw = "3.14 и т.д. по списку ул. Ленина";
    expect(nlp.unprotectAbbrev(nlp.protectAbbrev(raw))).toBe(raw);
  });

  it("чанки режутся по границам предложений и собираются до лимита", () => {
    expect(nlp.chunkText("Привет. Как дела? Хорошо!", 350)).toEqual([
      { text: "Привет. Как дела? Хорошо!", pauseMs: null },
    ]);
    expect(nlp.chunkText("Первое предложение. Второе предложение.", 20)).toEqual([
      { text: "Первое предложение.", pauseMs: null },
      { text: "Второе предложение.", pauseMs: null },
    ]);
  });

  it("сокращение «т.д.» не считается концом предложения", () => {
    expect(nlp.chunkText("Это т.д. и ещё. Конец.", 15)).toEqual([
      { text: "Это т.д. и ещё.", pauseMs: null },
      { text: "Конец.", pauseMs: null },
    ]);
  });

  it("маркер [PAUSE=500ms] отдаёт паузу вместе со своим предложением", () => {
    expect(nlp.chunkText("Текст. [PAUSE=500ms] Конец.", 15)).toEqual([
      { text: "Текст.", pauseMs: null },
      { text: "Конец.", pauseMs: 500 },
    ]);
  });

  it("гигантское предложение без точек режется по запятым", () => {
    const long = "а".repeat(40) + ", " + "б".repeat(40) + ", " + "в".repeat(40);
    const chunks = nlp.chunkText(long, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c: any) => (c.text || "").length <= 80)).toBe(true);
  });
});

describe("server/ruNlp — нормализация", () => {
  it("по умолчанию разворачивает числа и ёфицирует", () => {
    expect(nlp.normalize("Еще 5 яблок")).toBe("Ещё пять яблок");
  });

  it("опции отключают шаги по отдельности", () => {
    expect(nlp.normalize("Еще 5 яблок", { expandNumbers: false })).toBe("Ещё 5 яблок");
    expect(nlp.normalize("Еще 5 яблок", { yoficate: false })).toBe("Еще пять яблок");
  });

  it("ударения включаются явно (и остаются no-op для кириллицы)", () => {
    expect(nlp.normalize("замок")).toBe("замок");
    expect(nlp.normalize("замок", { markStress: true })).toBe("замок");
  });
});
