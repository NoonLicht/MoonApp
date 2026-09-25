import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/budget");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-budget-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/budget");
});

// RUB-операции не снимают курс (см. комментарий у create() в budget.ts),
// поэтому реальная сеть здесь не нужна — эти тесты работают офлайн.
async function reachesCbr(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("https://www.cbr-xml-daily.ru/daily_json.js", { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
const cbrReachable = await reachesCbr();

describe("server/budget — CRUD операций", () => {
  it("create/list/remove работают, некорректная сумма отклоняется", async () => {
    const tx = await engine.create({ type: "expense", amount: 100, category: "Еда", date: "2026-09-10" });
    expect(tx.id).toBeTruthy();
    expect(tx.currency).toBe("RUB");
    expect(engine.list()).toHaveLength(1);

    await expect(engine.create({ type: "expense", amount: -5, category: "Еда" })).rejects.toThrow(
      "invalid_amount",
    );
    await expect(engine.create({ type: "expense", amount: NaN, category: "Еда" })).rejects.toThrow(
      "invalid_amount",
    );

    expect(engine.remove(tx.id)).toBe(true);
    expect(engine.remove(tx.id)).toBe(false);
    expect(engine.list()).toHaveLength(0);
  });

  it("create без даты подставляет сегодняшнюю в формате YYYY-MM-DD", async () => {
    const tx = await engine.create({ type: "income", amount: 500, category: "Зарплата" });
    expect(tx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    engine.remove(tx.id);
  });

  it("convertAmount: та же валюта — без конвертации; RUB↔RUB не требует снимка курса", async () => {
    const tx = await engine.create({ type: "expense", amount: 100, category: "Еда" });
    expect(engine.convertAmount(tx, "RUB")).toBe(100);
    engine.remove(tx.id);
  });

  it("convertAmount: рублёвая операция без снимка курса не конвертируется в другую валюту", async () => {
    const tx = await engine.create({ type: "expense", amount: 100, category: "Еда" });
    expect(tx.rates).toBeNull();
    expect(engine.convertAmount(tx, "USD")).toBeNull();
    engine.remove(tx.id);
  });

  it.runIf(cbrReachable)(
    "операция в валюте снимает реальный курс ЦБ РФ и конвертируется в RUB",
    async () => {
      const tx = await engine.create({
        type: "expense",
        amount: 10,
        category: "Другое",
        currency: "USD",
      });
      expect(tx.currency).toBe("USD");
      expect(tx.rates).not.toBeNull();
      expect(tx.rates!.USD).toBeGreaterThan(1); // доллар точно дороже рубля
      const inRub = engine.convertAmount(tx, "RUB");
      expect(inRub).toBeCloseTo(10 * tx.rates!.USD, 5);
      engine.remove(tx.id);
    },
    15000,
  );
});

describe("server/budget — помесячная агрегация", () => {
  it("monthlySummary группирует по месяцу и категории, считает доходы/расходы раздельно", async () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await engine.create({ type: "expense", amount: 100, category: "Еда", date: `${thisMonth}-05` });
    await engine.create({ type: "expense", amount: 50, category: "Еда", date: `${thisMonth}-06` });
    await engine.create({ type: "expense", amount: 30, category: "Транспорт", date: `${thisMonth}-07` });
    await engine.create({ type: "income", amount: 1000, category: "Зарплата", date: `${thisMonth}-01` });

    const summary = engine.monthlySummary(3);
    expect(summary).toHaveLength(3);
    const current = summary[summary.length - 1];
    expect(current.month).toBe(thisMonth);
    expect(current.income).toBe(1000);
    expect(current.expense).toBe(180);
    expect(current.byCategory["Еда"]).toBe(150);
    expect(current.byCategory["Транспорт"]).toBe(30);
    expect(current.unconverted).toBe(0);
  });
});

describe("server/budget — CSV-импорт", () => {
  it("родной формат (date,type,category,amount,note) импортируется, битые строки пропускаются", () => {
    const before = engine.list().length;
    const csv =
      "date,type,category,amount,note\n" +
      "2026-09-01,income,Зарплата,1000,ЗП сентябрь\n" +
      "2026-09-05,expense,Еда,50,Пятёрочка\n" +
      "broken,line,,notanumber,x\n";
    const r = engine.importCsv(csv);
    expect(r.imported).toBe(2);
    expect(r.skipped).toBe(1);
    expect(engine.list().length).toBe(before + 2);
  });

  it("банковский формат (Date;Description;Amount со знаком) распознаётся, разделитель ; и дата DD.MM.YYYY", () => {
    const before = engine.list().length;
    const csv = "Date;Description;Amount\n01.09.2026;Salary;+2000\n03.09.2026;Grocery store;-45.50\n";
    const r = engine.importCsv(csv);
    expect(r.imported).toBe(2);
    expect(r.skipped).toBe(0);

    const all = engine.list();
    const salary = all.find((x) => x.note === "Salary");
    const grocery = all.find((x) => x.note === "Grocery store");
    expect(salary?.type).toBe("income");
    expect(salary?.amount).toBe(2000);
    expect(salary?.date).toBe("2026-09-01");
    expect(grocery?.type).toBe("expense");
    expect(grocery?.amount).toBe(45.5);
    expect(engine.list().length).toBe(before + 2);
  });

  it("пустой файл и файл без колонки суммы отклоняются с понятной ошибкой", () => {
    expect(engine.importCsv("").errors).toContain("empty_file");
    expect(engine.importCsv("foo,bar\n1,2\n").errors).toContain("no_amount_column");
  });
});
