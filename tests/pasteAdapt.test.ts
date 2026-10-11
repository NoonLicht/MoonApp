// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { adaptPlainText, fitToContext, htmlToMarkdown, looksRich } from "@/pages/myspace/parts/pasteAdapt";

const ctx = { indent: "", emptyItem: false, headingLevel: 0, atLineStart: true };

describe("умная вставка: HTML → Markdown", () => {
  it("выкидывает стили и шрифты, оставляет структуру", () => {
    const html = `<div style="font-family:Arial;font-size:24px;color:red"><h2 class="x">Заголовок</h2>
      <p style="font-size:30px">Обычный <b>жирный</b> и <i>курсив</i>, <a href="https://a.example/x">ссылка</a>.</p>
      <ul><li>Один</li><li>Два<ol><li>Вложенный</li><li>Ещё</li></ol></li></ul></div>`;
    expect(looksRich(html)).toBe(true);
    expect(htmlToMarkdown(html)).toBe(
      "## Заголовок\n\nОбычный **жирный** и *курсив*, [ссылка](https://a.example/x).\n\n- Один\n- Два\n   1. Вложенный\n   2. Ещё",
    );
  });

  it("таблица, код и цитата", () => {
    const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table><pre>let a = 1;</pre><blockquote><p>цитата</p></blockquote>`;
    expect(htmlToMarkdown(html)).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2\\|3 |\n\n```\nlet a = 1;\n```\n\n> цитата",
    );
  });

  it("жирный/курсив из стилей span (Word, Google Docs)", () => {
    const md = htmlToMarkdown(`<p><span style="font-weight:700">важно</span> и <span style="font-style:italic">тонко</span></p>`);
    expect(md).toBe("**важно** и *тонко*");
  });
});

describe("умная вставка: обычный текст и контекст", () => {
  it("маркеры, табы, «1)» и лишние пустые строки приводятся к Markdown", () => {
    const t = "• первый\n•\tвторой\n\t• вложенный\n1) один\n2) два\n\n\n\nконец  ";
    expect(adaptPlainText(t)).toBe("- первый\n- второй\n   - вложенный\n1. один\n2. два\n\nконец");
  });

  it("заголовки подстраиваются под ближайший заголовок выше", () => {
    expect(fitToContext("# Тема\n\n## Часть", { ...ctx, headingLevel: 2 })).toBe("### Тема\n\n#### Часть");
    expect(fitToContext("## Тема", { ...ctx, headingLevel: 0 })).toBe("## Тема");
    expect(fitToContext("#### Глубоко", { ...ctx, headingLevel: 1 })).toBe("## Глубоко");
  });

  it("в пункте списка строки продолжения получают отступ, пустой маркер не дублируется", () => {
    expect(fitToContext("- a\n- b", { ...ctx, indent: "   ", emptyItem: true, atLineStart: false })).toBe("a\n   - b");
    expect(fitToContext("строка 1\nстрока 2", { ...ctx, indent: "   ", atLineStart: false })).toBe("строка 1\n   строка 2");
  });
});
