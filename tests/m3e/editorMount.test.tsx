// @vitest-environment happy-dom
import React, { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { createRoot } from "react-dom/client";
import M3eEditor, { type M3eEditorHandle } from "@/pages/myspace/m3e/M3eEditor";
import type { Doc } from "@/pages/myspace/m3e/lib/tokens";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(props: Partial<React.ComponentProps<typeof M3eEditor>> = {}) {
  const host = document.createElement("div");
  host.style.cssText = "width:1200px;height:800px";
  document.body.appendChild(host);
  const changes: Doc[] = [];
  const handleRef = { current: null } as React.MutableRefObject<M3eEditorHandle | null>;
  const onReady = vi.fn();
  await act(async () => {
    createRoot(host).render(
      <M3eEditor
        pageId="p1"
        initialLang="en"
        initialDoc={null}
        onDocChange={(d) => changes.push(d)}
        handleRef={handleRef}
        onReady={onReady}
        {...props}
      />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return { host, changes, handleRef, onReady };
}

describe("редактор M3E в приложении", () => {
  it("открывается с примером, сообщает о готовности и отдаёт документ", async () => {
    const m = await mount();
    expect(m.host.querySelector(".m3e-app-root")).not.toBeNull();
    expect(m.onReady).toHaveBeenCalled();
    expect(m.changes.length).toBeGreaterThan(0);
    const last = m.changes[m.changes.length - 1];
    expect(Array.isArray(last.frames)).toBe(true);
    expect(last.frames.length).toBeGreaterThan(0);
    // не лезет в body приложения
    expect(document.body.style.background).toBe("");
    expect(document.documentElement.getAttribute("lang") ?? "").not.toBe("ja");
  });

  it("русский интерфейс: подписи панелей переведены", async () => {
    const m = await mount({ initialLang: "ru" });
    const text = m.host.textContent ?? "";
    expect(text).toContain("Элементы");
    expect(text).toContain("Спросить ИИ");
    expect(text).toContain("Действия");
  });

  it("сохранённый документ открывается как есть, а handle переименовывает проект", async () => {
    const doc: Partial<Doc> = {
      groups: [],
      frames: [
        { id: "a", name: "Вход", x: 0, y: 0 },
        { id: "b", name: "Лента", x: 600, y: 0 },
      ],
      paletteKey: "purple",
      frame: "phone",
      title: "Мой проект",
      brief: "",
    };
    const m = await mount({ initialDoc: doc });
    expect(m.handleRef.current).not.toBeNull();
    await act(async () => m.handleRef.current!.setTitle("Другое имя"));
    const last = m.changes[m.changes.length - 1];
    expect(last.title).toBe("Другое имя");
    expect(last.frames.map((f) => f.name)).toEqual(["Вход", "Лента"]);
    await act(async () => m.handleRef.current!.focusFrame("b"));
    await act(async () => m.handleRef.current!.focusFrame("нет-такого"));
  });
});
