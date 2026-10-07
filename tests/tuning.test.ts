import { describe, it, expect } from "vitest";
import ru from "@/i18n/ru.json";
import en from "@/i18n/en.json";
import { CHECKLIST as UI_CHECKLIST } from "@/pages/tuning/parts/Checklist";

/**
 * Страница «Тюнинг ПК»: целостность каталога твиков (server/ts/tuningCatalog.ts)
 * и его согласованность с интерфейсом и переводами.
 */
const catalog = require("../server/tuningCatalog") as typeof import("../server/ts/tuningCatalog");
const { TWEAKS, CHECKLIST, IFEO_PRIORITY, PRIORITIES } = catalog;

type Texts = {
  tw: Record<string, { t: string; d: string }>;
  cl: Record<string, { t: string; d: string }>;
};

describe("каталог твиков", () => {
  it("id уникальны, у каждого твика есть операции", () => {
    const ids = TWEAKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TWEAKS) expect(t.ops.length, t.id).toBeGreaterThan(0);
  });

  it("значения реестра корректны: HKLM/HKCU, DWORD в диапазоне, есть имя", () => {
    for (const t of TWEAKS)
      for (const op of t.ops) {
        if (op.t !== "reg") continue;
        expect(op.key, t.id).toMatch(/^HK(LM|CU|U)\\/);
        expect(op.name, t.id).toBeTruthy();
        if (op.type === "REG_DWORD") {
          expect(Number.isInteger(op.value), `${t.id} ${op.name}`).toBe(true);
          expect(Number(op.value)).toBeGreaterThanOrEqual(0);
          expect(Number(op.value)).toBeLessThanOrEqual(0xffffffff);
          if (op.def !== undefined) expect(Number(op.def)).toBeLessThanOrEqual(0xffffffff);
        }
      }
  });

  it("у команд есть проверка, применение и откат", () => {
    for (const t of TWEAKS)
      for (const op of t.ops) {
        if (op.t !== "cmd") continue;
        expect(op.check.length, t.id).toBeGreaterThan(0);
        expect(op.apply.length, t.id).toBeGreaterThan(0);
        expect(op.revert.length, t.id).toBeGreaterThan(0);
        expect(() => new RegExp(op.on), t.id).not.toThrow();
        // {prev} без значения по умолчанию оставил бы пустой аргумент при откате без снимка
        if (JSON.stringify(op.revert).includes("{prev}") && op.cap)
          expect(op.def, t.id).toBeTruthy();
      }
  });

  it("твики сгруппированы по известным вкладкам", () => {
    const tabs = new Set([
      "windows",
      "scheduler",
      "usb",
      "network",
      "drivers",
      "debloat",
      "wu-essential",
      "wu-advanced",
      "wu-prefs",
    ]);
    for (const t of TWEAKS) expect(tabs.has(t.tab), t.id).toBe(true);
    for (const tab of tabs)
      expect(
        TWEAKS.some((t) => t.tab === tab),
        tab,
      ).toBe(true);
  });

  it("опасные твики помечены риском 2", () => {
    for (const id of ["winupdate", "mitigations"])
      expect(TWEAKS.find((t) => t.id === id)?.risk, id).toBe(2);
  });
});

describe("переводы страницы", () => {
  for (const [lang, dict] of Object.entries({ ru, en })) {
    it(`${lang}: у каждого твика и пункта чек-листа есть название и описание`, () => {
      const tn = (dict as unknown as { tuning: Texts }).tuning;
      for (const t of TWEAKS) {
        expect(tn.tw[t.id]?.t, `${lang} tw.${t.id}.t`).toBeTruthy();
        expect(tn.tw[t.id]?.d, `${lang} tw.${t.id}.d`).toBeTruthy();
      }
      for (const id of Object.values(CHECKLIST).flat()) {
        expect(tn.cl[id]?.t, `${lang} cl.${id}.t`).toBeTruthy();
        expect(tn.cl[id]?.d, `${lang} cl.${id}.d`).toBeTruthy();
      }
    });
  }

  it("в переводах нет лишних твиков и пунктов", () => {
    for (const dict of [ru, en]) {
      const tn = (dict as unknown as { tuning: Texts }).tuning;
      expect(Object.keys(tn.tw).sort()).toEqual(TWEAKS.map((t) => t.id).sort());
      expect(Object.keys(tn.cl).sort()).toEqual(Object.values(CHECKLIST).flat().sort());
    }
  });

  it("секции чек-листов и приоритеты переведены", () => {
    for (const dict of [ru, en]) {
      const tn = dict as unknown as {
        tuning: { section: Record<string, string>; prio: Record<string, string> };
      };
      for (const s of Object.keys(CHECKLIST)) expect(tn.tuning.section[s], s).toBeTruthy();
      for (const p of PRIORITIES) expect(tn.tuning.prio[p], p).toBeTruthy();
    }
  });
});

describe("согласованность интерфейса и сервера", () => {
  it("перечень чек-листов в интерфейсе совпадает с серверным", () => {
    expect(UI_CHECKLIST).toEqual(CHECKLIST);
  });

  it("для каждого приоритета есть значение IFEO", () => {
    for (const p of PRIORITIES) expect(IFEO_PRIORITY[p], p).toBeGreaterThan(0);
  });
});
