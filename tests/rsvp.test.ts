import { describe, it, expect } from "vitest";
import { plainText, orpIndex, rsvpWords } from "../src/lib/rsvp";

/** RSVP-чтение (src/lib/rsvp.ts). */
describe("rsvp", () => {
  it("plainText убирает разметку, код и ссылки", () => {
    const md = "---\ntitle: x\n---\n# Заголовок\n**Жирный** текст и [[Заметка|ссылка]] и [сайт](http://a.b)\n```\nкод\n```";
    expect(plainText(md)).toBe("Заголовок Жирный текст и ссылка и сайт");
  });

  it("orpIndex растёт с длиной слова", () => {
    expect(orpIndex("я")).toBe(0);
    expect(orpIndex("мир")).toBe(1);
    expect(orpIndex("привет!")).toBe(2);
    expect(orpIndex("информация")).toBe(3);
    expect(orpIndex("сверхъестественное")).toBe(4);
  });

  it("задержки: длинные слова и знаки препинания замедляют показ", () => {
    const w = rsvpWords("Да, это очень длинное слово. Конец", 300); // база 200 мс
    expect(w.map((x) => x.text)).toEqual(["Да,", "это", "очень", "длинное", "слово.", "Конец"]);
    expect(w[0].ms).toBe(300); // запятая +0.5
    expect(w[1].ms).toBe(200);
    expect(w[4].ms).toBe(400); // точка +1
    expect(rsvpWords("", 300)).toEqual([]);
  });

  it("скорость ограничена разумными пределами", () => {
    expect(rsvpWords("слово", 5)[0].ms).toBe(1000); // не медленнее 60 wpm
    expect(rsvpWords("слово", 100000)[0].ms).toBe(40); // не быстрее 1500 wpm
  });
});
