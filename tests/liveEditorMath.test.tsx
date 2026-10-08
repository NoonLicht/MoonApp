// @vitest-environment happy-dom
import React from "react";
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import CodeMirrorLiveEditor from "../src/pages/myspace/parts/CodeMirrorLiveEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(content: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(
      React.createElement(CodeMirrorLiveEditor, { content, onChange: () => undefined }),
    );
  });
  return host;
}

describe("живой редактор: формулы", () => {
  it("формулы в строке и блоком рисуются KaTeX, курсорная строка остаётся исходником", async () => {
    // курсор в позиции 0 — на первой строке, она остаётся сырым текстом
    const host = await mount(
      "# Заголовок\n\nЗакон $F = m a$ и $x_1$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nКонец\n",
    );
    const html = host.innerHTML;
    expect(host.querySelectorAll(".cm-live-math").length).toBe(2);
    expect(host.querySelectorAll(".cm-live-math-block").length).toBe(1);
    expect(html).toContain("katex");
    expect(host.textContent).not.toContain("\\int");
  });

  it("цена в долларах не становится формулой", async () => {
    const host = await mount("a\n\nцена $5 и $10\n");
    expect(host.querySelectorAll(".cm-live-math").length).toBe(0);
  });
});
