// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PRESETS, sanitizeNode, sanitizeSpec } from "@/pages/myspace/m3e/lib/custom";
import { CustomBody } from "@/pages/myspace/m3e/components/CustomNode";
import { makeCustomItem } from "@/pages/myspace/m3e/lib/library";
import { paletteOf, sizeOf, DEFAULT_THEME } from "@/pages/myspace/m3e/lib/tokens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("составные элементы", () => {
  it("все готовые элементы проходят проверку и рисуются", () => {
    const p = paletteOf("purple", null, DEFAULT_THEME);
    for (const x of PRESETS) {
      const node = sanitizeNode(x.node);
      expect(node, x.key).not.toBeNull();
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => root.render(<CustomBody node={x.node} p={p} />));
      expect(host.textContent?.length ?? 0, x.key).toBeGreaterThan(0);
      act(() => root.unmount());
      host.remove();
    }
  });

  it("ответ модели приводится к безопасному виду", () => {
    const spec = sanitizeSpec({
      name: "  Карточка  ",
      w: 9999,
      h: -5,
      node: {
        t: "box",
        pad: 9999,
        fill: "javascript:alert(1)",
        c: [
          { t: "text", s: "Привет", role: "evil", color: "#ff0000" },
          { t: "icon", n: "bad name!" },
          { t: "script", s: "x" },
          { t: "button", s: "OK", v: "filled" },
        ],
      },
    });
    expect(spec).not.toBeNull();
    expect(spec!.w).toBe(412);
    expect(spec!.h).toBe(24);
    const root = spec!.node as { fill?: string; pad?: number; c: { t: string; color?: string }[] };
    expect(root.fill).toBeUndefined();
    expect(root.pad).toBe(64);
    expect(root.c.map((c) => c.t)).toEqual(["text", "button"]);
    expect(root.c[0].color).toBeUndefined();
  });

  it("глубина и число узлов ограничены", () => {
    let deep: unknown = { t: "text", s: "x" };
    for (let i = 0; i < 20; i++) deep = { t: "box", c: [deep] };
    const out = JSON.stringify(sanitizeNode(deep));
    expect((out.match(/"t":"box"/g) ?? []).length).toBeLessThanOrEqual(7);
    expect(sanitizeNode("строка")).toBeNull();
  });

  it("элемент холста берёт размер из описания", () => {
    const spec = sanitizeSpec({ name: "A", w: 300, h: 140, node: PRESETS[0].node })!;
    const item = makeCustomItem(spec);
    expect(item.kind).toBe("custom");
    expect(sizeOf(item, {})).toEqual({ w: 300, h: 140 });
  });
});
