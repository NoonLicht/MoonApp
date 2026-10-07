import { describe, it, expect } from "vitest";
import ru from "@/i18n/ru.json";
import en from "@/i18n/en.json";

/**
 * Вкладка «Приватность» (стр. «Тюнинг ПК»): целостность каталога целей
 * (server/ts/privacyCatalog.ts) и его согласованность с переводами.
 */
const catalog = require("../server/privacyCatalog") as typeof import("../server/ts/privacyCatalog");
const { WIPE_ITEMS } = catalog;

type Texts = { cat: Record<string, string>; it: Record<string, { t: string; d: string }> };

describe("каталог целей зачистки", () => {
  it("id уникальны, у каждой цели хотя бы одна платформа", () => {
    const ids = WIPE_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of WIPE_ITEMS) expect(i.platforms.length, i.id).toBeGreaterThan(0);
  });

  it("есть цели для Windows и для Linux", () => {
    expect(WIPE_ITEMS.some((i) => i.platforms.includes("win32"))).toBe(true);
    expect(WIPE_ITEMS.some((i) => i.platforms.includes("linux"))).toBe(true);
  });

  it("системные логи и история USB помечены риском 2 и требуют admin", () => {
    for (const id of ["event-logs", "journal-logs", "prefetch", "usb-history"]) {
      const item = WIPE_ITEMS.find((i) => i.id === id);
      expect(item?.risk, id).toBe(2);
      expect(item?.admin, id).toBe(true);
    }
  });
});

describe("переводы вкладки «Приватность»", () => {
  for (const [lang, dict] of Object.entries({ ru, en })) {
    it(`${lang}: у каждой цели есть название, описание и переведена её категория`, () => {
      const pr = (dict as unknown as { privacy: Texts }).privacy;
      const cats = new Set(WIPE_ITEMS.map((i) => i.category));
      for (const c of cats) expect(pr.cat[c], `${lang} cat.${c}`).toBeTruthy();
      for (const i of WIPE_ITEMS) {
        expect(pr.it[i.id]?.t, `${lang} it.${i.id}.t`).toBeTruthy();
        expect(pr.it[i.id]?.d, `${lang} it.${i.id}.d`).toBeTruthy();
      }
    });
  }

  it("в переводах нет целей, которых больше нет в каталоге", () => {
    for (const dict of [ru, en]) {
      const pr = (dict as unknown as { privacy: Texts }).privacy;
      expect(Object.keys(pr.it).sort()).toEqual(WIPE_ITEMS.map((i) => i.id).sort());
    }
  });

  it("на вкладках «Тюнинг ПК» есть ярлык и подсказка для privacy (en/ru)", () => {
    for (const dict of [ru, en]) {
      const tn = (
        dict as unknown as {
          tuning: { tab: Record<string, string>; tabHint: Record<string, string> };
        }
      ).tuning;
      expect(tn.tab.privacy).toBeTruthy();
      expect(tn.tabHint.privacy).toBeTruthy();
    }
  });
});
