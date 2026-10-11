import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** «Цена в часах» и прогноз накоплений (server/ts/budgetHours.ts). */
const req = createRequire(import.meta.url);
let b: any;
beforeAll(() => {
  b = req("../server/budgetHours");
});

const inc = (date: string, amount: number) => ({ type: "income", amount, category: "Зарплата", note: "", date });
const exp = (date: string, amount: number, category = "Еда", note = "") => ({
  type: "expense",
  amount,
  category,
  note,
  date,
});

describe("ставка в час", () => {
  const txs = [inc("2026-07-05", 90000), inc("2026-08-05", 100000), inc("2026-09-05", 110000), inc("2026-10-05", 10000)];

  it("берёт среднее по последним полным месяцам, текущий неполный не считает", () => {
    const r = b.hourRates(txs, "2026-10-12");
    expect(r.monthlyIncome).toBe(100000);
    expect(r.basedOnMonths).toBe(3);
    expect(r.perWorkHour).toBe(625);
    expect(r.perLifeHour).toBeCloseTo(208.33, 1);
  });

  it("ручной доход и часы переопределяют расчёт", () => {
    const r = b.hourRates(txs, "2026-10-12", { monthlyIncome: 80000, workHoursPerMonth: 80 });
    expect(r.perWorkHour).toBe(1000);
    expect(r.basedOnMonths).toBe(0);
  });

  it("без дохода цены в часах нет", () => {
    const r = b.hourRates([exp("2026-10-01", 100)], "2026-10-12");
    expect(r.perWorkHour).toBe(0);
    expect(b.priceInHours(500, r)).toBeNull();
  });

  it("если полных месяцев нет, использует текущий", () => {
    expect(b.hourRates([inc("2026-10-02", 48000)], "2026-10-12").monthlyIncome).toBe(48000);
  });
});

describe("цена покупки", () => {
  it("переводит сумму в рабочие часы, часы жизни и рабочие дни", () => {
    const r = b.hourRates([inc("2026-09-01", 160000)], "2026-10-12"); // 1000 ₽/ч
    const p = b.priceInHours(8000, r);
    expect(p.workHours).toBe(8);
    expect(p.workDays).toBe(1);
    expect(p.lifeHours).toBeCloseTo(8000 / (160000 / 480), 1);
  });

  it("отчёт за месяц: категории и самые дорогие в часах", () => {
    const rates = b.hourRates([inc("2026-09-01", 160000)], "2026-10-12");
    const rep = b.hoursReport(
      [exp("2026-10-03", 4000, "Еда", "ужин"), exp("2026-10-05", 16000, "Одежда", "куртка"), exp("2026-09-30", 999)],
      "2026-10",
      rates,
    );
    expect(rep.totalExpense).toBe(20000);
    expect(rep.totalWorkHours).toBe(20);
    expect(rep.top[0]).toMatchObject({ note: "куртка", workHours: 16 });
    expect(rep.byCategory[0].category).toBe("Одежда");
  });
});

describe("прогноз накоплений", () => {
  const txs = [
    inc("2026-07-01", 100000),
    exp("2026-07-10", 70000),
    inc("2026-08-01", 100000),
    exp("2026-08-10", 70000),
    inc("2026-09-01", 100000),
    exp("2026-09-10", 70000),
  ];

  it("считает срок и дату при текущем темпе", () => {
    const f = b.savingForecast(txs, "2026-10-12", { target: 100000, have: 10000 });
    expect(f.monthlySaving).toBe(30000);
    expect(f.remaining).toBe(90000);
    expect(f.monthsNeeded).toBe(3);
    expect(f.reachedOn).toBe("2027-01-12");
  });

  it("для срока показывает нужный взнос и достижимость", () => {
    const ok = b.savingForecast(txs, "2026-10-12", { target: 100000, byDate: "2027-02-12" });
    expect(ok.byDate.feasible).toBe(true);
    const hard = b.savingForecast(txs, "2026-10-12", { target: 300000, byDate: "2027-01-12" });
    expect(hard.byDate.feasible).toBe(false);
    expect(hard.byDate.requiredPerMonth).toBeGreaterThan(30000);
  });

  it("если накоплений нет — достижение невозможно", () => {
    const f = b.savingForecast([inc("2026-09-01", 1000), exp("2026-09-02", 5000)], "2026-10-12", { target: 100 });
    expect(f.monthsNeeded).toBeNull();
    expect(f.reachedOn).toBeNull();
  });

  it("цель уже достигнута", () => {
    expect(b.savingForecast(txs, "2026-10-12", { target: 100, have: 500 }).monthsNeeded).toBe(0);
  });
});
