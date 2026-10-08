// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/app/i18n";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mem = vi.hoisted(() => ({
  files: {} as Record<string, unknown>,
  writes: [] as { name: string; data: any }[],
}));

vi.mock("@/api/client", () => ({
  api: {
    myspaceListHolsts: async () =>
      Object.entries(mem.files).map(([name, d]) => ({
        name,
        title: (d as { name?: string }).name ?? null,
      })),
    myspaceReadHolst: async (name: string) => ({ name, data: mem.files[name] }),
    myspaceWriteHolst: async (name: string, data: unknown) => {
      mem.files[name] = data;
      mem.writes.push({ name, data });
      return { ok: true, name };
    },
    myspaceDeleteHolst: async (name: string) => {
      delete mem.files[name];
      return { ok: true };
    },
    myspaceRead: async () => ({ content: "# Заметка\nТекст" }),
  },
}));

import CanvasPage from "@/pages/myspace/canvas/CanvasPage";

if (!("ResizeObserver" in globalThis)) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

let root: Root;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};
const stage = () => host.querySelector(".hc-stage") as HTMLElement;
const key = (k: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
  });
const mouse = (type: string, x: number, y: number, el: Element = stage()) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  });
const objects = () => host.querySelectorAll(".hc-world [data-oid]");

beforeEach(async () => {
  mem.files = {};
  mem.writes = [];
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider lang="ru">
        <CanvasPage />
      </I18nProvider>,
    );
  });
  await flush();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Canvas: новая доска", () => {
  it("создаёт доску, показывает подсказку и панели", () => {
    expect(Object.keys(mem.files)).toHaveLength(1);
    expect(host.querySelector(".hc-empty")?.textContent).toContain("Двойной клик");
    expect(host.querySelector(".hc-dock")).not.toBeNull();
    expect(host.querySelector(".hc-top")).not.toBeNull();
    expect(host.querySelectorAll(".hc-tool").length).toBeGreaterThanOrEqual(10);
  });

  it("стикер создаётся инструментом S, сразу открывается правка, отмена убирает его", async () => {
    await key("s");
    await mouse("pointerdown", 300, 200);
    await mouse("pointerup", 300, 200);
    await flush();
    expect(objects().length).toBeGreaterThan(0);
    expect(host.querySelector('[contenteditable="true"]')).not.toBeNull();
    // после создания инструмент вернулся к выбору
    expect(host.querySelector(".hc-tool.on")?.getAttribute("aria-label")).toBe("Выбор");
    (document.activeElement as HTMLElement | null)?.blur?.();
    await flush();
    await key("z", { ctrlKey: true });
    await flush();
    expect(objects().length).toBe(0);
  });

  it("двойной клик по пустому месту создаёт текст, фигура создаётся перетаскиванием", async () => {
    await act(async () => {
      stage().dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 150 }),
      );
    });
    await flush();
    expect(host.querySelector('[contenteditable="true"]')).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await flush();

    await key("r");
    await mouse("pointerdown", 100, 100);
    await mouse("pointermove", 260, 200);
    await mouse("pointerup", 260, 200);
    await flush();
    const svgPaths = host.querySelectorAll(".hc-world svg path[data-oid]");
    expect(svgPaths.length).toBeGreaterThan(0);
  });

  it("панель свойств появляется при выборе, а Delete удаляет выбранное", async () => {
    await key("s");
    await mouse("pointerdown", 300, 200);
    await mouse("pointerup", 300, 200);
    await flush();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await flush();
    expect(host.querySelector(".hc-insp")).not.toBeNull();
    await key("Delete");
    await flush();
    expect(objects().length).toBe(0);
    expect(host.querySelector(".hc-insp")).toBeNull();
  });

  it("при закрытии доска сохраняется в формате v3", async () => {
    await key("s");
    await mouse("pointerdown", 300, 200);
    await mouse("pointerup", 300, 200);
    await flush();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await flush();
    await act(async () => root.unmount());
    root = createRoot(host);
    const last = mem.writes[mem.writes.length - 1];
    expect(last.data.version).toBe(3);
    expect(last.data.objs.length).toBe(1);
    expect(last.data.objs[0].type).toBe("sticky");
  });

  it("старая доска версии 2 открывается и переносится", async () => {
    await act(async () => root.unmount());
    mem.files = {
      Untitled_Holst_01: {
        version: 2,
        name: "Старая",
        nodes: [
          {
            id: "n1",
            type: "sticky",
            position: { x: 10, y: 10 },
            data: { text: "привет", color: "#fef08a" },
            style: { width: 170, height: 150 },
          },
          {
            id: "n2",
            type: "shape",
            position: { x: 300, y: 10 },
            data: { shape: "circle", label: "круг", fill: "#bfdbfe", stroke: "#000" },
            style: { width: 120, height: 120 },
          },
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2", data: { style: "bezier", arrowEnd: true } },
        ],
      },
    };
    host.innerHTML = "";
    root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider lang="ru">
          <CanvasPage />
        </I18nProvider>,
      );
    });
    await flush();
    expect(host.textContent).toContain("привет");
    expect(host.textContent).toContain("круг");
    expect((host.querySelector(".hc-name") as HTMLInputElement).value).toBe("Старая");
  });

  it("объект двигается перетаскиванием, а отмена возвращает его на место", async () => {
    await key("s");
    await mouse("pointerdown", 300, 200);
    await mouse("pointerup", 300, 200);
    await flush();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await flush();
    const el = () => host.querySelector(".hc-world > [data-oid]") as HTMLElement;
    const left0 = parseFloat(el().style.left);
    await mouse("pointerdown", 310, 210, el());
    await mouse("pointermove", 360, 240, el());
    await mouse("pointerup", 360, 240, el());
    await flush();
    expect(parseFloat(el().style.left)).toBeCloseTo(left0 + 50, 0);
    await key("z", { ctrlKey: true });
    await flush();
    expect(parseFloat(el().style.left)).toBeCloseTo(left0, 0);
  });

  it("два объекта группируются Ctrl+G и разгруппировываются", async () => {
    for (const x of [200, 500]) {
      await key("s");
      await mouse("pointerdown", x, 200);
      await mouse("pointerup", x, 200);
      await flush();
      (document.activeElement as HTMLElement | null)?.blur?.();
      await flush();
    }
    await key("a", { ctrlKey: true });
    await key("g", { ctrlKey: true });
    await flush();
    expect(host.querySelector('[title^="Разгруппировать"]')).not.toBeNull();
    // слои: переключаемся на вкладку и видим группу с вложенностью
    const tabs = host.querySelectorAll(".hc-tabs button");
    await act(async () => (tabs[1] as HTMLElement).click());
    expect(host.querySelectorAll(".hc-layer").length).toBe(3);
    await key("g", { ctrlKey: true, shiftKey: true });
    await flush();
    expect(host.querySelectorAll(".hc-layer").length).toBe(2);
  });
});
