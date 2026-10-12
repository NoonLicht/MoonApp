import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Тексты песен LRC (server/ts/lyrics.ts). */
const req = createRequire(import.meta.url);
let ly: any;
beforeAll(() => {
  ly = req("../server/lyrics");
});

describe("parseLrc", () => {
  it("разбирает метки, несколько меток в строке и сортирует", () => {
    const lines = ly.parseLrc("[ti:x]\n[00:12.50] Второй\n[00:01.00][00:30.25] Повтор\n\n[01:05] Конец");
    expect(lines).toEqual([
      { t: 1, text: "Повтор" },
      { t: 12.5, text: "Второй" },
      { t: 30.25, text: "Повтор" },
      { t: 65, text: "Конец" },
    ]);
  });

  it("учитывает offset", () => {
    expect(ly.parseLrc("[offset:+500]\n[00:10.00] a")).toEqual([{ t: 10.5, text: "a" }]);
    expect(ly.parseLrc("[offset:-2000]\n[00:01.00] a")).toEqual([{ t: 0, text: "a" }]);
  });

  it("мусор не ломает разбор", () => {
    expect(ly.parseLrc("")).toEqual([]);
    expect(ly.parseLrc("просто текст")).toEqual([]);
  });
});

describe("currentLine", () => {
  const lines = [
    { t: 5, text: "a" },
    { t: 10, text: "b" },
    { t: 20, text: "c" },
  ];
  it("находит звучащую строку", () => {
    expect(ly.currentLine(lines, 0)).toBe(-1);
    expect(ly.currentLine(lines, 5)).toBe(0);
    expect(ly.currentLine(lines, 19.9)).toBe(1);
    expect(ly.currentLine(lines, 999)).toBe(2);
    expect(ly.currentLine([], 5)).toBe(-1);
  });
});

describe("lrclib", () => {
  it("адрес запроса кодирует параметры и округляет длительность", () => {
    const u = ly.lrclibUrl(" Земфира ", "Искала", 245.6);
    expect(u).toContain("https://lrclib.net/api/get?");
    expect(u).toContain("artist_name=%D0%97%D0%B5%D0%BC%D1%84%D0%B8%D1%80%D0%B0");
    expect(u).toContain("duration=246");
  });

  it("pickLyrics: синхронный, обычный, инструментал", () => {
    expect(ly.pickLyrics({ syncedLyrics: "[00:01.00] hi", plainLyrics: "hi" })).toEqual({
      synced: [{ t: 1, text: "hi" }],
      plain: "",
    });
    expect(ly.pickLyrics({ plainLyrics: " строка " })).toEqual({ synced: [], plain: "строка" });
    expect(ly.pickLyrics({ instrumental: true, plainLyrics: "x" })).toEqual({ synced: [], plain: "" });
    expect(ly.pickLyrics(null)).toEqual({ synced: [], plain: "" });
  });
});
