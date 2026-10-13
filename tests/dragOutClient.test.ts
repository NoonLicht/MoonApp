// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bindImageDragOut, dragOutProps } from "@/lib/dragOut";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("перетаскивание картинок наружу", () => {
  const startDrag = vi.fn();
  beforeEach(() => {
    startDrag.mockClear();
    (window as unknown as { appBridge: unknown }).appBridge = { startDrag };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === "POST")
          return new Response(JSON.stringify({ path: "C:\\tmp\\moonapp-dragout\\a\\image.png" }), {
            status: 200,
          });
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), {
          status: 200,
        });
      }),
    );
  });

  it("картинка на странице: наведение готовит файл, dragstart отдаёт его системе", async () => {
    bindImageDragOut(document);
    const img = document.createElement("img");
    img.src = PNG;
    Object.defineProperty(img, "naturalWidth", { value: 300 });
    document.body.appendChild(img);
    img.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await tick();
    const ev = new Event("dragstart", { bubbles: true, cancelable: true });
    img.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(startDrag).toHaveBeenCalledWith("C:\\tmp\\moonapp-dragout\\a\\image.png");
  });

  it("внутренний перенос (draggable=true) и неготовый файл не перехватываются", async () => {
    const own = document.createElement("img");
    own.src = PNG;
    own.setAttribute("draggable", "true");
    document.body.appendChild(own);
    own.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await tick();
    const ev = new Event("dragstart", { bubbles: true, cancelable: true });
    own.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);

    const cold = document.createElement("img");
    cold.src = PNG + "#cold";
    document.body.appendChild(cold);
    const ev2 = new Event("dragstart", { bubbles: true, cancelable: true });
    cold.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it("вложение письма: пропсы готовят файл и запускают системный перенос", async () => {
    const props = dragOutProps({
      kind: "url",
      url: "/api/mail/attachment/m1/0",
      name: "отчёт.pdf",
    });
    props.onPointerEnter();
    await tick();
    const prevent = vi.fn();
    props.onDragStart({ preventDefault: prevent } as unknown as React.DragEvent);
    expect(prevent).toHaveBeenCalled();
    expect(startDrag).toHaveBeenCalled();
  });
});
