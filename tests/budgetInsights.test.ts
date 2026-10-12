import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Инсайты бюджета (server/ts/budgetInsights.ts). */
const req = createRequire(import.meta.url);
let bi: any;
beforeAll(() => {
  bi = req("../server/budgetInsights");
});

const ex = (date: string, amount: number, note: string, category = "Другое") => ({
  type: "expense" as const,
  amount,
  category,
  note,
  date,
});

describe("runway", () => {
  it("считает хватит ли и сколько можно тратить в день", () => {
    // 30 дней по 500 → среднее 500/день
    const txs = Array.from({ length: 30 }, (_, i) => ex(`2026-03-${String(i + 1).padStart(2, "0")}`, 500, "еда"));
    const r = bi.runway({ txs, available: 5000, today: "2026-03-30", payday: "2026-04-09", fixedUntilPayday: 1000 });
    expect(r.daysUntilPayday).toBe(10);
    expect(r.avgDaily).toBe(500);
    expect(r.enough).toBe(false);
    expect(r.dailyAllowance).toBe(400); // (5000 - 1000) / 10
    const ok = bi.runway({ txs, available: 20000, today: "2026-03-30", payday: "2026-04-09" });
    expect(ok.enough).toBe(true);
    expect(ok.leftover).toBeGreaterThan(0);
  });

  it("trimTop исключает крупные разовые траты из темпа", () => {
    const txs = [ex("2026-03-10", 50000, "ноутбук"), ex("2026-03-11", 300, "еда"), ex("2026-03-12", 300, "еда")];
    const plain = bi.runway({ txs, available: 1000, today: "2026-03-30", payday: "2026-04-09" });
    const trimmed = bi.runway({ txs, available: 1000, today: "2026-03-30", payday: "2026-04-09", trimTop: 1 });
    expect(trimmed.avgDaily).toBeLessThan(plain.avgDaily / 10);
  });
});

describe("findSubscriptions", () => {
  it("находит ежемесячное списание и помечает давно не списывавшееся", () => {
    const txs = [
      ex("2025-10-05", 299, "Netflix", "Подписки"),
      ex("2025-11-05", 299, "Netflix", "Подписки"),
      ex("2025-12-05", 299, "Netflix", "Подписки"),
      ex("2026-01-05", 299, "Netflix", "Подписки"),
      ex("2026-01-20", 1500, "Продукты"),
      ex("2026-02-02", 900, "Продукты"),
    ];
    const subs = bi.findSubscriptions(txs, "2026-04-20");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ name: "netflix", amount: 299, charges: 4, everyDays: 31, stale: true });
    expect(subs[0].yearlyCost).toBeGreaterThan(3400);
    expect(subs[0].yearlyCost).toBeLessThan(3700);
    expect(bi.findSubscriptions(txs, "2026-02-01")[0].stale).toBe(false);
  });

  it("нерегулярные покупки не считаются подпиской", () => {
    const txs = [ex("2026-01-01", 500, "кафе"), ex("2026-01-03", 500, "кафе"), ex("2026-02-25", 500, "кафе")];
    expect(bi.findSubscriptions(txs, "2026-03-01")).toEqual([]);
  });
});

describe("compareMonths и whatIf", () => {
  const txs = [
    ex("2026-02-03", 1000, "а", "Еда"),
    ex("2026-02-10", 500, "б", "Транспорт"),
    ex("2026-03-03", 1500, "а", "Еда"),
    ex("2026-03-12", 700, "в", "Развлечения"),
  ];
  it("разница по категориям, отсортирована по модулю", () => {
    const r = bi.compareMonths(txs, "2026-02", "2026-03");
    expect(r.totalA).toBe(1500);
    expect(r.totalB).toBe(2200);
    expect(r.categories[0]).toMatchObject({ category: "Развлечения", delta: 700 });
    expect(r.categories.find((c: any) => c.category === "Еда")).toMatchObject({ delta: 500, pct: 50 });
    const ent = r.categories.find((c: any) => c.category === "Развлечения");
    expect(ent.pct).toBeNull();
  });

  it("what-if: экономия в месяц и год", () => {
    const r = bi.whatIf(txs, { Еда: 20, Развлечения: 50 }, { months: 2, today: "2026-03-31" });
    // Еда за 2 месяца 2500 → 1250/мес × 20 % = 250; Развлечения 700 → 350/мес × 50 % = 175
    expect(r.perMonth).toBe(425);
    expect(r.perYear).toBe(5100);
    expect(r.byCategory[0].category).toBe("Еда");
  });
});

describe("personalInflation", () => {
  it("средневзвешенный рост цен на повторяющиеся покупки", () => {
    const milk = [
      ex("2025-10-01", 80, "Молоко"),
      ex("2025-11-01", 85, "Молоко"),
      ex("2025-12-01", 90, "Молоко"),
      ex("2026-01-01", 100, "Молоко"),
    ];
    const r = bi.personalInflation([...milk, ex("2026-01-02", 5000, "ноутбук")]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: "молоко", first: 80, last: 100, pct: 25 });
    expect(r.overallPct).toBe(25);
    expect(bi.personalInflation([]).overallPct).toBeNull();
  });
});

describe("taxDeductions", () => {
  it("считает лечение, учёбу и спорт по годам с лимитом и возвратом 13%", () => {
    const r = bi.taxDeductions([
      ex("2025-03-01", 100000, "Стоматолог", "Здоровье"),
      ex("2025-05-01", 80000, "Курсы английского", "Образование"),
      ex("2025-06-01", 10000, "Абонемент в фитнес", "Спорт"),
      ex("2025-07-01", 5000, "Кафе", "Еда"),
      ex("2024-02-01", 20000, "Аптека", "Другое"),
    ]);
    expect(r.years.map((y: any) => y.year)).toEqual([2025, 2024]);
    const y25 = r.years[0];
    expect(y25.total).toBe(190000);
    expect(y25.eligible).toBe(150000);
    expect(y25.overLimit).toBe(40000);
    expect(y25.refund).toBe(19500);
    expect(r.years[1].refund).toBe(2600);
  });

  it("доходы и посторонние траты не учитываются", () => {
    const r = bi.taxDeductions([
      { type: "income", amount: 5000, category: "Здоровье", note: "", date: "2025-01-01" },
      ex("2025-01-02", 300, "Кофе"),
    ]);
    expect(r.years).toEqual([]);
  });
});
