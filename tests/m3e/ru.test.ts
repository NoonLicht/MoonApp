import { describe, it, expect } from "vitest";
import { UI } from "@/pages/myspace/m3e/lib/i18n";
import { RU, RU_NOUN, RU_CATEGORY } from "@/pages/myspace/m3e/lib/ru";
import { KIND_ORDER, CATEGORIES } from "@/pages/myspace/m3e/lib/tokens";

describe("русский интерфейс M3E", () => {
  it("переводит только существующие ключи и сохраняет подстановки", () => {
    for (const [k, v] of Object.entries(RU)) {
      expect(Object.keys(UI), k).toContain(k);
      const en = (UI as Record<string, { en: string }>)[k].en;
      const slots = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
      expect(slots(v as string), k).toBe(slots(en));
    }
  });

  it("переведены все ключи интерфейса", () => {
    const missing = Object.keys(UI).filter((k) => !(k in RU));
    expect(missing).toEqual([]);
  });

  it("у каждого вида элемента и каждой категории есть русское название", () => {
    expect(KIND_ORDER.filter((k) => !RU_NOUN[k])).toEqual([]);
    expect(CATEGORIES.filter((c) => !RU_CATEGORY[c.key]).map((c) => c.key)).toEqual([]);
  });
});
