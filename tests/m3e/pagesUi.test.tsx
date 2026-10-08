// @vitest-environment happy-dom
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/app/i18n";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Память вместо сервера ──
interface Meta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  screens: number;
  parts: number;
  pinned?: boolean;
  color?: string;
}
const store = vi.hoisted(() => ({
  pages: [] as {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    screens: number;
    parts: number;
    pinned?: boolean;
    color?: string;
  }[],
  trash: [] as {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    screens: number;
    parts: number;
    deletedAt: number;
  }[],
  docs: {} as Record<string, string>,
  activeId: null as string | null,
  n: 0,
  writes: [] as string[],
}));

const view = () => ({
  activeId: store.activeId,
  pages: store.pages.map((p) => ({ ...p })),
  trash: store.trash.map((p) => ({ ...p })),
});
const describeDoc = (text: string) => {
  try {
    const d = JSON.parse(text);
    return {
      title: d.title ?? "",
      screens: d.frames?.length ?? 0,
      parts: (d.groups ?? []).reduce((n: number, g: { items: unknown[] }) => n + g.items.length, 0),
    };
  } catch {
    return { title: "", screens: 0, parts: 0 };
  }
};

vi.mock("@/api/client", () => ({
  api: {
    m3eList: async () => view(),
    m3ePatch: async (p: {
      activeId?: string;
      order?: string[];
      pages?: Record<string, { pinned?: boolean; color?: string | null }>;
    }) => {
      if (p.activeId) store.activeId = p.activeId;
      if (p.order) store.pages.sort((a, b) => p.order!.indexOf(a.id) - p.order!.indexOf(b.id));
      for (const [id, v] of Object.entries(p.pages ?? {})) {
        const m = store.pages.find((x) => x.id === id);
        if (!m) continue;
        if (typeof v.pinned === "boolean") m.pinned = v.pinned || undefined;
        if (v.color !== undefined) m.color = v.color || undefined;
      }
      return view();
    },
    m3eRead: async (id: string) => store.docs[id] ?? "",
    m3eWrite: async (id: string, text: string) => {
      store.docs[id] = text;
      store.writes.push(id);
      const m = store.pages.find((x) => x.id === id)!;
      Object.assign(m, describeDoc(text), { updatedAt: Date.now() });
      return { ...m };
    },
    m3eCreate: async (text = "", after?: string) => {
      const id = `p${++store.n}000000`;
      const info = text ? describeDoc(text) : { title: "", screens: 0, parts: 0 };
      const meta: Meta = { id, createdAt: Date.now(), updatedAt: Date.now(), ...info };
      const at = after ? store.pages.findIndex((x) => x.id === after) + 1 : store.pages.length;
      store.pages.splice(at, 0, meta);
      store.docs[id] = text;
      store.activeId = id;
      return { ...meta };
    },
    m3eDuplicate: async (id: string, title: string) => {
      const d = JSON.parse(store.docs[id] || "{}");
      return (await (
        await import("@/api/client")
      ).api.m3eCreate(JSON.stringify({ ...d, title }), id)) as Meta;
    },
    m3eDelete: async (id: string) => {
      const i = store.pages.findIndex((x) => x.id === id);
      const [m] = store.pages.splice(i, 1);
      store.trash.push({ ...m, deletedAt: Date.now() });
      if (store.activeId === id)
        store.activeId = store.pages[Math.min(i, store.pages.length - 1)]?.id ?? null;
      return view();
    },
    m3eRestore: async (id: string) => {
      const i = store.trash.findIndex((x) => x.id === id);
      const [m] = store.trash.splice(i, 1);
      const { deletedAt: _d, ...rest } = m;
      void _d;
      store.pages.push(rest);
      store.activeId = id;
      return view();
    },
    m3ePurge: async (id: string) => {
      store.trash = store.trash.filter((x) => x.id !== id);
      return view();
    },
  },
}));

import M3ePage from "@/pages/myspace/m3e/M3ePage";

const doc = (title: string, names: string[]) =>
  JSON.stringify({
    groups: [],
    frames: names.map((n, i) => ({ id: `${title}-${i}`, name: n, x: i * 500, y: 0 })),
    paletteKey: "purple",
    frame: "phone",
    title,
    brief: "",
  });

let current: ReturnType<typeof createRoot> | null = null;

async function mount() {
  document.body.innerHTML = '<div id="overlay-root"></div><div id="host"></div>';
  const host = document.getElementById("host")!;
  await act(async () => {
    current = createRoot(host);
    current.render(
      <I18nProvider lang="ru">
        <M3ePage />
      </I18nProvider>,
    );
  });
  await settle();
  return host;
}
const settle = async (ms = 40) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};
const tabs = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'));
const names = (host: HTMLElement) =>
  tabs(host).map((t) => t.querySelector(".m3p-name")?.textContent);
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

afterEach(async () => {
  // старые экземпляры слушают window: размонтируем, чтобы горячие клавиши не срабатывали дважды
  await act(async () => current?.unmount());
  current = null;
});

beforeEach(() => {
  Object.assign(store, { pages: [], trash: [], docs: {}, activeId: null, n: 0, writes: [] });
  localStorage.clear();
  store.pages.push(
    { id: "aaaaaaaa", title: "Лента", createdAt: 1, updatedAt: 1, screens: 2, parts: 0 },
    { id: "bbbbbbbb", title: "", createdAt: 2, updatedAt: 2, screens: 1, parts: 0 },
  );
  store.docs.aaaaaaaa = doc("Лента", ["Вход", "Главная"]);
  store.docs.bbbbbbbb = doc("", ["Один"]);
  store.activeId = "aaaaaaaa";
});

describe("страницы M3E: полоса вкладок", () => {
  it("показывает страницы, безымянным даёт номер, открытая подсвечена", async () => {
    const host = await mount();
    expect(names(host)).toEqual(["Лента", "Страница 2"]);
    expect(tabs(host)[0].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".m3e-app-root")).not.toBeNull();
  });

  it("переключение страницы пересоздаёт редактор и запоминает активную", async () => {
    const host = await mount();
    const before = host.querySelector(".m3e-app-root");
    await click(tabs(host)[1]);
    expect(tabs(host)[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".m3e-app-root")).not.toBe(before);
    expect(store.activeId).toBe("bbbbbbbb");
  });

  it("новая страница добавляется справа от открытой и открывается", async () => {
    const host = await mount();
    const plus = host.querySelector<HTMLElement>('[aria-label="Новая страница"]');
    await click(plus);
    const blank = Array.from(document.querySelectorAll<HTMLElement>(".m3p-menu-item")).find(
      (b) => b.textContent === "Пустая страница",
    );
    await click(blank!);
    expect(store.pages).toHaveLength(3);
    expect(store.pages[1].id).toBe("p1000000");
    expect(names(host)).toEqual(
      ["Лента", "Страница 2", "Страница 3"].map((n, i) => (i === 1 ? "Страница 2" : n)),
    );
    expect(store.activeId).toBe("p1000000");
    expect(JSON.parse(store.docs.p1000000).frames).toHaveLength(1);
  });

  it("удаление убирает вкладку в корзину и даёт «Вернуть»", async () => {
    const host = await mount();
    await click(tabs(host)[1].querySelector(".m3p-x"));
    expect(names(host)).toEqual(["Лента"]);
    expect(store.trash).toHaveLength(1);
    const undo = host.querySelector<HTMLElement>(".m3p-toast button");
    expect(undo?.textContent).toBe("Вернуть");
    await click(undo!);
    expect(names(host)).toContain("Лента");
    expect(store.pages).toHaveLength(2);
    expect(store.trash).toHaveLength(0);
  });

  it("закрепление и цвет приходят из контекстного меню", async () => {
    const host = await mount();
    await act(async () => {
      tabs(host)[1].dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 50,
          clientY: 50,
        }),
      );
    });
    const pin = Array.from(document.querySelectorAll<HTMLElement>(".m3p-menu-item")).find(
      (b) => b.textContent === "Закрепить",
    );
    await click(pin!);
    await settle();
    expect(store.pages.find((p) => p.id === "bbbbbbbb")?.pinned).toBe(true);
    // закреплённая вкладка стоит первой
    expect(tabs(host)[0].className).toContain("pinned");
  });

  it("переименование открытой страницы меняет название проекта и сохраняется", async () => {
    const host = await mount();
    await act(async () => {
      tabs(host)[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(".m3p-rename")!;
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Новая лента");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle(900);
    expect(names(host)[0]).toBe("Новая лента");
    expect(JSON.parse(store.docs.aaaaaaaa).title).toBe("Новая лента");
  });

  it("Alt+→ и Alt+1 переключают страницы", async () => {
    const host = await mount();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
      );
    });
    await settle();
    expect(tabs(host)[1].getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true, bubbles: true }));
    });
    await settle();
    expect(tabs(host)[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("страницы M3E: обзор и быстрый переход", () => {
  it("обзор показывает карточки со счётчиками и ищет по названиям экранов", async () => {
    const host = await mount();
    await click(host.querySelector('[aria-label="Все страницы"]'));
    await settle(80);
    const cards = () => Array.from(document.querySelectorAll(".m3p-card"));
    expect(cards()).toHaveLength(2);
    expect(document.body.textContent).toContain("экранов: 2");
    const input = document.querySelector<HTMLInputElement>(".m3p-ov-search input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "главная");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(cards()).toHaveLength(1);
    const chip = document.querySelector<HTMLElement>(".m3p-chip");
    expect(chip?.textContent).toBe("Главная");
    // переход к экрану другой страницы не падает и закрывает обзор
    await click(chip!);
    expect(document.querySelector(".m3p-card")).toBeNull();
  });

  it("Ctrl+K открывает быстрый переход, Enter открывает найденную страницу", async () => {
    const host = await mount();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    await settle(80);
    const input = document.querySelector<HTMLInputElement>(".m3p-switch-input input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "страница 2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector(".m3p-switch")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(tabs(host)[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".m3p-switch")).toBeNull();
  });

  it("корзина в обзоре возвращает страницу", async () => {
    store.trash.push({
      id: "cccccccc",
      title: "Старая",
      createdAt: 1,
      updatedAt: 1,
      screens: 3,
      parts: 0,
      deletedAt: Date.now(),
    });
    const host = await mount();
    await click(host.querySelector('[aria-label="Все страницы"]'));
    await click(document.querySelector(".m3p-trash-head"));
    expect(document.querySelector(".m3p-trash-list")?.textContent).toContain("Старая");
    const restore = Array.from(
      document.querySelectorAll<HTMLElement>(".m3p-trash-list .m3p-btn"),
    ).find((b) => b.textContent?.includes("Вернуть"));
    await click(restore!);
    expect(store.pages.map((p) => p.id)).toContain("cccccccc");
  });
});
