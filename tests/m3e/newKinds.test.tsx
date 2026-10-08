// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import M3eEditor from "@/pages/myspace/m3e/M3eEditor";
import { Lang, setGlobalLang } from "@/pages/myspace/m3e/lib/i18n";
import { isProject } from "@/pages/myspace/m3e/lib/project";
import { buildPrompt } from "@/pages/myspace/m3e/lib/prompt";
import {
  DEFAULT_THEME,
  KIND_ORDER,
  KIND_SPEC,
  type Doc,
  type Group,
  type Item,
  makeItem,
  sizeOf,
  uid,
} from "@/pages/myspace/m3e/lib/tokens";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEW = ["banner", "avatar", "segmentedButton", "tooltip", "menu", "rating"] as const;
const LANGS: Lang[] = ["ja", "en", "zh", "ko"];

afterEach(() => setGlobalLang("en"));

function docWith(items: Item[]): Doc {
  const groups: Group[] = items.map((it, i) => ({
    id: uid(),
    x: 40,
    y: 60 + i * 120,
    axis: "y",
    items: [it],
  }));
  return {
    groups,
    frames: [{ id: "f1", name: "Home", x: 0, y: 0 }],
    paletteKey: "purple",
    frame: "phone",
    title: "",
    brief: "",
    theme: DEFAULT_THEME,
  };
}

describe("новые элементы холста", () => {
  it("лежат в палитре и описаны в спецификации", () => {
    for (const k of NEW) {
      expect(KIND_ORDER).toContain(k);
      expect(KIND_SPEC[k].label).toBeTruthy();
    }
  });

  it("makeItem даёт рабочие значения по умолчанию на всех языках", () => {
    for (const lang of LANGS) {
      setGlobalLang(lang);
      expect(makeItem("segmentedButton").tabs).toHaveLength(3);
      expect(makeItem("menu").tabs).toHaveLength(4);
      expect(makeItem("rating")).toMatchObject({ count: 5, selected: 4 });
      expect(makeItem("tooltip").label.length).toBeGreaterThan(0);
      expect(makeItem("avatar").variant).toBe("tonal");
    }
  });

  it("размеры считаются от содержимого", () => {
    expect(sizeOf(makeItem("banner"), {}).h).toBe(56);
    expect(sizeOf({ ...makeItem("avatar"), size: 56 }, {})).toEqual({ w: 56, h: 56 });
    const menu = makeItem("menu");
    expect(sizeOf(menu, {}).h).toBe(16 + menu.tabs!.length * 48);
    const plain = makeItem("tooltip");
    const rich = { ...plain, supporting: "Длинное пояснение ".repeat(8) };
    expect(sizeOf(rich, {}).h).toBeGreaterThan(sizeOf(plain, {}).h);
    expect(sizeOf({ ...makeItem("rating"), size: 20, count: 5 }, {})).toEqual({
      w: 5 * 20 + 4 * 4,
      h: 20,
    });
  });

  it("документ с новыми элементами проходит проверку файла проекта", () => {
    const doc = docWith(NEW.map((k) => makeItem(k)));
    expect(isProject(JSON.parse(JSON.stringify(doc)))).toBe(true);
  });

  it("промпт описывает каждый новый элемент на всех языках", () => {
    for (const lang of LANGS) {
      setGlobalLang(lang);
      const items = NEW.map((k) => makeItem(k));
      const doc = docWith(items);
      const text = buildPrompt(doc, {}, undefined, lang);
      for (const it of items) {
        // упоминание названия вида недостаточно: нужно описание, а не запасной «noun»
        const described = text.includes(
          it.kind === "banner"
            ? it.label
            : it.kind === "avatar"
              ? `${it.size}dp`
              : it.kind === "rating"
                ? `${it.selected}`
                : (it.tabs?.[0]?.label ?? it.label),
        );
        expect(described, `${lang}:${it.kind}`).toBe(true);
      }
    }
  });

  it("редактор рисует все новые элементы", async () => {
    setGlobalLang("en");
    const items = NEW.map((k) => makeItem(k));
    items[3] = { ...items[3], supporting: "Saved to your list" };
    const host = document.createElement("div");
    host.style.cssText = "width:1200px;height:900px";
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <M3eEditor
          pageId="k"
          initialLang="en"
          initialDoc={docWith(items)}
          onDocChange={() => undefined}
        />,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Day");
    expect(text).toContain("Week");
    expect(text).toContain("Duplicate");
    expect(text).toContain("Saved to your list");
    expect(text).toContain("AB");
    expect(text).toContain("Your changes were saved");
    for (const it of items)
      expect(host.querySelector(`[data-node="${it.id}"]`), it.kind).not.toBeNull();
  });
});
