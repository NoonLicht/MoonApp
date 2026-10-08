import { describe, expect, it } from "vitest";
import { chunkText } from "../server/ts/semantic";
import { withPrefix } from "../server/ts/llamacpp/embed";

describe("семантический индекс: нарезка и префиксы", () => {
  it("делит длинный текст на куски по абзацам и чистит разметку", () => {
    const p = "Слово ".repeat(150).trim();
    const text = `# Заголовок\n\n${p}\n\n${p}\n\n![img](a.png)\n\n[[Другая заметка]] и [ссылка](http://x.y)`;
    const parts = chunkText(text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const c of parts) expect(c.length).toBeLessThanOrEqual(1400);
    const all = parts.join(" ");
    expect(all).not.toContain("![img]");
    expect(all).not.toContain("[[");
    expect(all).toContain("Другая заметка");
    expect(all).toContain("ссылка");
  });

  it("пустой и слишком короткий текст не даёт кусков; блоки кода отбрасываются", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("a\n\nb")).toEqual([]);
    expect(chunkText("```js\nconst x = 1;\n```\n\nОбычный абзац про дело.")).toEqual([
      "Обычный абзац про дело.",
    ]);
  });

  it("префиксы задач EmbeddingGemma", () => {
    expect(withPrefix("как дела", "query")).toBe("task: search result | query: как дела");
    expect(withPrefix("текст", "doc", "Заметка")).toBe("title: Заметка | text: текст");
    expect(withPrefix("текст", "doc")).toBe("title: none | text: текст");
    expect(withPrefix("a  b\n c", "similar")).toBe("task: sentence similarity | query: a b c");
  });
});
