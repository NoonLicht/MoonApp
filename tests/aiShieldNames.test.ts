import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Щит для ИИ: имена людей (server/ts/aiShield.ts). */
const req = createRequire(import.meta.url);
let sh: any;
beforeAll(() => {
  sh = req("../server/aiShield");
});

describe("имена по шаблонам", () => {
  it("прячет фамилию с инициалами, инициалы с фамилией и имя с отчеством", () => {
    const r = sh.shieldText(
      "Договор подписал Сидоров А. Б., копию получил А.С. Пушкин, звонил Иван Сергеевич, отчёт у Мариной Петровны.",
    );
    expect(r.text).not.toMatch(/Сидоров|Пушкин|Сергеевич/);
    expect(r.found.name).toBe(4);
  });

  it("косвенные падежи отчества тоже распознаются", () => {
    const r = sh.shieldText("Встреча с Иваном Петровичем в пятницу, письмо Анне Ивановне.");
    expect(r.found.name).toBe(2);
    expect(r.text).toContain("[ИМЯ_1]");
  });

  it("обычные слова с заглавной буквы не трогаются", () => {
    const src = "Москва — столица. Сегодня Понедельник, а Новый год скоро.";
    expect(sh.shieldText(src).text).toBe(src);
  });

  it("переключатель names:false отключает шаблоны", () => {
    const src = "Подписал Сидоров А. Б.";
    expect(sh.shieldText(src, { names: false }).text).toBe(src);
  });

  it("имя восстанавливается в ответе", () => {
    const src = "Передай Сидорову А. Б. привет, Сидоров А. Б. поймёт.";
    const r = sh.shieldText("Подписал Сидоров А. Б. договор.");
    expect(sh.restoreText(`Хорошо, ${r.text.match(/\[ИМЯ_\d+\]/)[0]} уведомлён.`, r.map)).toBe(
      "Хорошо, Сидоров А. Б. уведомлён.",
    );
    expect(src).toBeTruthy();
  });
});

describe("имена от локальной модели", () => {
  it("заменяются везде, независимо от регистра, целыми словами", () => {
    const r = sh.shieldText("мария кузнецова написала. Мария Кузнецова не против. Мариям не нужно.", {
      extraNames: ["Мария Кузнецова", "Мария"],
    });
    expect(r.text).toBe("[ИМЯ_1] написала. [ИМЯ_1] не против. Мариям не нужно.");
  });

  it("разбирает список из JSON и из строк, отбрасывая мусор", () => {
    expect(sh.parseNameList('Вот: ["Пётр Первый", "дом", "a@b.ru", "Анна"]')).toEqual(["Пётр Первый", "Анна"]);
    expect(sh.parseNameList("- Иван Грозный\n- Мария\n12345")).toEqual(["Иван Грозный", "Мария"]);
    expect(sh.parseNameList("[]")).toEqual([]);
  });
});
