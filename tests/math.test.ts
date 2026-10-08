// @vitest-environment happy-dom
import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { findInlineMath, findMathBlock, renderMath } from "../src/lib/math";
import MarkdownRenderer from "../src/pages/myspace/parts/MarkdownRenderer";

describe("формулы как в Obsidian", () => {
  it("inline: пробелы у границ и цифра после закрывающего $ — не формула", () => {
    expect(findInlineMath("цена $5 и $10").map((r) => r.tex)).toEqual([]);
    expect(findInlineMath("a $ x $ b")).toEqual([]);
    expect(findInlineMath("где $m$ — масса, $F=ma$.").map((r) => r.tex)).toEqual(["m", "F=ma"]);
    expect(findInlineMath("\\$не формула\\$ и $x_1$").map((r) => r.tex)).toEqual(["x_1"]);
  });

  it("блок: одна строка, несколько строк, лишний текст рядом — не блок", () => {
    expect(findMathBlock(["$$x^2$$"], 0)).toEqual({ start: 0, end: 0, tex: "x^2" });
    const b = findMathBlock(["до", "$$", "\\int_0^1 x\\,dx", "= \\frac12", "$$", "после"], 1);
    expect(b).toMatchObject({ start: 1, end: 4 });
    expect(b?.tex).toContain("\\frac12");
    expect(findMathBlock(["$$x$$ текст"], 0)).toBeNull();
    expect(findMathBlock(["$$", "без конца"], 0)).toBeNull();
  });

  it("KaTeX рисует формулу, а ошибка не роняет рендер", () => {
    expect(renderMath("\\frac{a}{b}", false)).toContain("katex");
    expect(renderMath("\\frac{a}{b}", true)).toContain("katex-display");
    expect(() => renderMath("\\badcommand{", false)).not.toThrow();
  });

  it("превью: формулы в тексте и блоком рисуются, подчёркивания внутри не становятся курсивом", () => {
    const md = "Закон: $F = m a$ и $x_1 + y_1$.\n\n$$\n\\int_0^1 x_1\\,dx\n$$\n\nКонец";
    const html = renderToString(React.createElement(MarkdownRenderer, { content: md }));
    expect(html).toContain("katex");
    expect(html).toContain("md-math-display");
    expect(html).not.toContain("MOONMATH");
    expect(html).not.toContain("<em>");
    expect(html).toContain("Конец");
  });
});
