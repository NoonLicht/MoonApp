import { describe, it, expect } from "vitest";
import { speakableText, speechMinutes } from "../src/lib/speakable";

/** Подготовка заметки к озвучке (src/lib/speakable.ts). */
describe("speakableText", () => {
  it("убирает разметку, ссылки, теги и код, но сохраняет абзацы", () => {
    const md = [
      "---",
      "tags: a",
      "---",
      "# Заголовок",
      "",
      "Первый **абзац** со [ссылкой](http://x.y) и [[Заметка|вики]] #тег.",
      "Вторая строка того же абзаца https://example.com/long",
      "",
      "- [ ] Купить хлеб",
      "- [x] Позвонить",
      "",
      "```js",
      "const a = 1;",
      "```",
      "| a | b |",
      "|---|---|",
      "",
      "Последний абзац.",
    ].join("\n");
    expect(speakableText(md)).toBe(
      "Заголовок\n\nПервый абзац со ссылкой и вики . Вторая строка того же абзаца\n\nКупить хлеб Позвонить\n\nПоследний абзац.",
    );
  });

  it("обрезает по границе абзаца, если она не слишком близко к началу", () => {
    const first = "слово ".repeat(14).trim();
    const md = `${first}\n\n` + "другое ".repeat(100) + "\n\nхвост";
    expect(speakableText(md, { maxChars: 150 })).toBe(first);
  });

  it("иначе режет по границе слова", () => {
    const md = "ab\n\n" + "слово ".repeat(100);
    const out = speakableText(md, { maxChars: 40 });
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("слово")).toBe(true);
  });

  it("оценка времени растёт с длиной", () => {
    expect(speechMinutes("а".repeat(1800))).toBe(2);
    expect(speechMinutes("")).toBe(0.1);
  });
});
