import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Подписки и регулярные платежи, прогноз месяца и импорт OFX
 * (server/ts/budgetRecurring.ts, server/ts/budget.ts).
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-budget-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let rec: any;
let budget: any;
beforeAll(() => {
  rec = req("../server/budgetRecurring");
  budget = req("../server/budget");
});

const base = (over: object = {}) => ({
  id: "r1",
  name: "Netflix",
  amount: 100,
  currency: "RUB",
  category: "Подписки",
  type: "expense",
  interval: "month",
  startDate: "2026-01-31",
  remindDays: 3,
  active: true,
  ...over,
});

describe("повторения", () => {
  it("месячный платёж «31-го» уходит на последний день короткого месяца и возвращается", () => {
    expect(rec.occurrence("2026-01-31", "month", 0)).toBe("2026-01-31");
    expect(rec.occurrence("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(rec.occurrence("2026-01-31", "month", 2)).toBe("2026-03-31");
    expect(rec.occurrence("2024-01-31", "month", 1)).toBe("2024-02-29"); // високосный
  });

  it("недельный и годовой интервалы", () => {
    expect(rec.occurrence("2026-03-01", "week", 2)).toBe("2026-03-15");
    expect(rec.occurrence("2024-02-29", "year", 1)).toBe("2025-02-28");
    expect(rec.occurrence("2024-02-29", "year", 4)).toBe("2028-02-29");
  });

  it("occurrencesBetween уважает окно и endDate", () => {
    const r = base({ startDate: "2026-01-10", endDate: "2026-04-10" });
    expect(rec.occurrencesBetween(r, "2026-02-01", "2026-12-31")).toEqual([
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
    ]);
  });
});

describe("ближайшие списания и напоминания", () => {
  it("nextDue идёт после lastPaid; неактивные и завершённые не показываются", () => {
    const r = base({ startDate: "2026-01-10", lastPaid: "2026-02-10" });
    expect(rec.nextDue(r)).toBe("2026-03-10");
    expect(rec.nextDue(base({ active: false }))).toBeNull();
    expect(rec.nextDue(base({ startDate: "2026-01-10", endDate: "2026-01-20", lastPaid: "2026-01-10" }))).toBeNull();
  });

  it("upcoming: окно по дням, флаг remind, просроченные первыми", () => {
    const list = [
      base({ id: "a", startDate: "2026-06-12", remindDays: 3 }),
      base({ id: "b", startDate: "2026-06-20", remindDays: 3 }),
      base({ id: "c", startDate: "2026-06-05", remindDays: 3 }), // просрочен
      base({ id: "d", startDate: "2026-09-01" }), // за пределами окна
    ];
    const u = rec.upcoming(list, "2026-06-10", 14);
    expect(u.map((x: any) => x.recurring.id)).toEqual(["c", "a", "b"]);
    expect(u[0].inDays).toBe(-5);
    expect(u[1]).toMatchObject({ inDays: 2, remind: true });
    expect(u[2]).toMatchObject({ inDays: 10, remind: false });
  });

  it("monthlyEquivalent приводит недели и годы к месяцу", () => {
    expect(rec.monthlyEquivalent(base({ amount: 1200, interval: "year" }))).toBe(100);
    expect(rec.monthlyEquivalent(base({ amount: 100, interval: "week" }))).toBeCloseTo(433.33, 2);
  });
});

describe("прогноз месяца", () => {
  const tx = (date: string, amount: number, note = "", currency = "RUB") => ({
    id: date + amount,
    type: "expense",
    amount,
    category: "Еда",
    note,
    date,
    createdAt: 0,
    currency,
    rates: null,
  });

  it("потрачено + обычный темп на оставшиеся дни + будущие регулярные", () => {
    // 10 июня: 10 дней прошло, в июне 30 дней → осталось 20.
    const txs = [tx("2026-06-02", 500), tx("2026-06-08", 500), tx("2026-06-05", 300, "Netflix")];
    const recs = [base({ startDate: "2026-06-05", lastPaid: "2026-06-05" }), base({ id: "r2", name: "Gym", amount: 1000, startDate: "2026-06-25" })];
    const f = rec.forecastMonth(txs, recs, "2026-06-10", "RUB");
    expect(f.spentSoFar).toBe(1300);
    // обычные траты = 1300 − 300 (Netflix уже оплачен) = 1000 за 10 дней → 100/день
    expect(f.dailyVariable).toBe(100);
    expect(f.recurringAhead).toBe(1000); // Gym 25 июня; Netflix в июне уже оплачен
    expect(f.projectedTotal).toBe(1300 + 100 * 20 + 1000);
  });

  it("операции в другой валюте без курса не учитываются, но считаются пропущенными", () => {
    const f = rec.forecastMonth([tx("2026-06-02", 50, "", "USD")], [], "2026-06-10", "RUB");
    expect(f.spentSoFar).toBe(0);
    expect(f.skipped).toBe(1);
  });
});

describe("OFX", () => {
  const OFX_V1 = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>RUB
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260603120000<TRNAMT>-250.50<FITID>A1<NAME>Кофейня
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260605<TRNAMT>90000,00<FITID>A2<NAME>Зарплата<MEMO>июнь
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>bad<TRNAMT>-1<FITID>A3
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it("разбирает SGML-выписку: даты, знак суммы, запятая как разделитель, битые строки", () => {
    const p = rec.parseOfx(OFX_V1);
    expect(p.currency).toBe("RUB");
    expect(p.skipped).toBe(1);
    expect(p.items).toEqual([
      { date: "2026-06-03", amount: -250.5, name: "Кофейня", fitid: "A1", currency: "RUB" },
      { date: "2026-06-05", amount: 90000, name: "Зарплата", fitid: "A2", currency: "RUB" },
    ]);
  });

  it("XML-вариант с закрывающими тегами", () => {
    const p = rec.parseOfx(
      "<OFX><STMTTRN><DTPOSTED>20260101</DTPOSTED><TRNAMT>-10</TRNAMT><FITID>X</FITID><NAME>Shop</NAME></STMTTRN></OFX>",
    );
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ amount: -10, name: "Shop", date: "2026-01-01" });
  });

  it("повторный импорт той же выписки не дублирует операции", () => {
    const p = rec.parseOfx(OFX_V1);
    const first = budget.importOfxItems(p.items, p.skipped);
    expect(first).toMatchObject({ imported: 2, duplicates: 0 });
    const again = budget.importOfxItems(p.items, p.skipped);
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
    const list = budget.list();
    expect(list.filter((t: any) => t.externalId === "A1")).toHaveLength(1);
    expect(list.find((t: any) => t.externalId === "A2")).toMatchObject({ type: "income", amount: 90000 });
  });

  it("CSV тоже защищён от повторного импорта (дата+сумма+описание)", () => {
    const csv = "date,amount,description\n2026-07-01,-100,Такси\n2026-07-02,-50,Метро\n";
    expect(budget.importCsv(csv)).toMatchObject({ imported: 2, duplicates: 0 });
    expect(budget.importCsv(csv)).toMatchObject({ imported: 0, duplicates: 2 });
  });
});

describe("хранилище подписок", () => {
  it("create → upcoming → pay создаёт операцию и сдвигает следующее списание", async () => {
    const start = new Date();
    const ymd = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    const r = rec.create({ name: "Spotify", amount: 199, interval: "month", startDate: ymd, remindDays: 2 });
    expect(rec.getUpcoming(1).some((u: any) => u.recurring.id === r.id && u.due === ymd)).toBe(true);
    const tx = await rec.markPaid(r.id);
    expect(tx).toMatchObject({ amount: 199, note: "Spotify", category: "Подписки", date: ymd });
    const next = rec.list().find((x: any) => x.id === r.id);
    expect(next.lastPaid).toBe(ymd);
    expect(rec.nextDue(next)).toBe(rec.occurrence(ymd, "month", 1));
    expect(rec.remove(r.id)).toBe(true);
  });

  it("валидация: пустое имя и неположительная сумма отклоняются", () => {
    expect(() => rec.create({ name: " ", amount: 5 })).toThrow("invalid_name");
    expect(() => rec.create({ name: "x", amount: 0 })).toThrow("invalid_amount");
  });
});
