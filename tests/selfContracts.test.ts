import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Контракты с собой (server/ts/selfContracts.ts). */
const req = createRequire(import.meta.url);
let c: any;
beforeAll(() => {
  c = req("../server/selfContracts");
});

const mk = (metric: string, target: string, limit: number) =>
  c.makeContract({ label: "тест", metric, target, limit }, 1);

const snap = {
  appSecondsToday: { vlc: 3600, spotify: 1800, chrome: 7200, Code: 600 },
  spendToday: 500,
  spendMonth: 12000,
  spendByCategoryMonth: { Еда: 9000, Транспорт: 3000 },
};

describe("проверка контрактов", () => {
  it("минуты по категории приложений за день", () => {
    const e = c.evaluate(mk("category_minutes_day", "media", 120), snap);
    expect(e.value).toBe(90);
    expect(e.unit).toBe("min");
    expect(e.status).toBe("ok"); // 90/120 = 0.75 — ещё ниже порога «near» (0.8)
  });

  it("статусы: ok < 80 % ≤ near ≤ 100 % < over", () => {
    expect(c.evaluate(mk("spend_month", "", 50000), snap).status).toBe("ok");
    expect(c.evaluate(mk("spend_month", "", 14000), snap).status).toBe("near");
    expect(c.evaluate(mk("spend_month", "", 12000), snap).status).toBe("near");
    expect(c.evaluate(mk("spend_month", "", 11000), snap).status).toBe("over");
  });

  it("категория трат и приложение без учёта регистра", () => {
    expect(c.evaluate(mk("category_spend_month", "еда", 10000), snap).value).toBe(9000);
    expect(c.evaluate(mk("app_minutes_day", "CHROME", 60), snap)).toMatchObject({ value: 120, status: "over" });
  });

  it("траты за день", () => {
    expect(c.evaluate(mk("spend_day", "", 1000), snap)).toMatchObject({ value: 500, status: "ok" });
  });
});

describe("данные и проверка ввода", () => {
  it("секунды за локальный день из почасовой статистики", () => {
    const stats = { "2026-10-12": { 9: { chrome: 100 }, 10: { chrome: 50, Code: 20 } }, "2026-10-11": { 9: { x: 5 } } };
    expect(c.appSecondsFor(stats, "2026-10-12")).toEqual({ chrome: 150, Code: 20 });
  });

  it("траты: день, месяц и по категориям, без будущих дат и доходов", () => {
    const txs = [
      { type: "expense", amount: 100, category: "Еда", date: "2026-10-12" },
      { type: "expense", amount: 50, category: "Еда", date: "2026-10-03" },
      { type: "income", amount: 9999, category: "Зарплата", date: "2026-10-01" },
      { type: "expense", amount: 70, category: "Еда", date: "2026-10-20" },
      { type: "expense", amount: 40, category: "Еда", date: "2026-09-30" },
    ];
    expect(c.spendSnapshot(txs, "2026-10-12")).toEqual({
      spendToday: 100,
      spendMonth: 150,
      spendByCategoryMonth: { Еда: 150 },
    });
  });

  it("валидация", () => {
    expect(c.isValid({ metric: "spend_day", limit: 100 })).toBeNull();
    expect(c.isValid({ metric: "nope", limit: 100 })).toBe("bad_metric");
    expect(c.isValid({ metric: "spend_day", limit: 0 })).toBe("bad_limit");
    expect(c.isValid({ metric: "category_minutes_day", target: "видео", limit: 5 })).toBe("bad_target");
    expect(c.isValid({ metric: "app_minutes_day", target: "", limit: 5 })).toBe("bad_target");
  });
});
