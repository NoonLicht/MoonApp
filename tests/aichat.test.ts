import { describe, it, expect } from "vitest";
import hljs from "highlight.js";
import { parseSegments, highlightCode } from "@/pages/ai-chat/lib/chatUtils";

/**
 * Аудит B16: во время стриминга история перепарсивалась на каждый токен.
 * Здесь закреплено поведение кэшей и обрезка highlightAuto — чтобы
 * оптимизацию нельзя было случайно откатить.
 */
describe("parseSegments (разбор сообщения)", () => {
  it("разделяет markdown и код-блоки", () => {
    const segs = parseSegments("до\n```ts\nconst a = 1;\n```\nпосле");
    expect(segs.map((s) => s.type)).toEqual(["md", "code", "md"]);
    expect(segs[1].lang).toBe("ts");
    expect(segs[1].text).toBe("const a = 1;");
  });

  it("обычный текст даёт один md-сегмент", () => {
    const segs = parseSegments("просто текст");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ type: "md", text: "просто текст" });
  });

  it("кэширует результат: одинаковый вход → та же ссылка (мемоизация)", () => {
    const a = parseSegments("кэш-проверка ```js\n1\n```");
    const b = parseSegments("кэш-проверка ```js\n1\n```");
    expect(b).toBe(a); // стабильная ссылка не ломает useMemo у потребителей
  });
});

describe("highlightCode (подсветка кода)", () => {
  it("известный язык подсвечивается", () => {
    const out = highlightCode("const a = 1;", "javascript");
    expect(out).toContain("hljs-");
  });

  it("короткий код без языка НЕ прогоняется через highlightAuto", () => {
    const out = highlightCode("x = 1", "text");
    expect(out).not.toContain("hljs-");
    expect(out).toBe("x = 1");
  });

  it("неизвестный язык короткого сниппета → как есть, без авто-подсветки", () => {
    const out = highlightCode("какой-то текст", "unknownlang42");
    expect(out).not.toContain("hljs-");
    expect(out).toBe("какой-то текст");
  });

  it("длинный код без языка по-прежнему авто-подсвечивается", () => {
    const long = Array.from(
      { length: 14 },
      (_, i) => `  const value${i} = compute(${i}) * ${i + 1};`,
    ).join("\n");
    expect(long.length).toBeGreaterThanOrEqual(240);
    const out = highlightCode(long, "");
    expect(out).toContain("hljs-"); // авто-подсветка включилась
    expect(out).toBe(hljs.highlightAuto(long).value); // и именно через highlightAuto
  });

  it("экранирует HTML и кэширует результат", () => {
    const out = highlightCode("<b>&amp;</b>", "text");
    expect(out).toBe("&lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(highlightCode("<b>&amp;</b>", "text")).toBe(out);
  });
});
