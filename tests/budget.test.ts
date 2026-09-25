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

describe("server/budget — CRUD операций", () => {
  it("create/list/remove работают, некорректная сумма отклоняется", () => {
    const tx = engine.create({ type: "expense", amount: 100, category: "Еда", date: "2026-09-10" });
    expect(tx.id).toBeTruthy();
    expect(engine.list()).toHaveLength(1);

    expect(() => engine.create({ type: "expense", amount: -5, category: "Еда" })).toThrow("invalid_amount");
    expect(() => engine.create({ type: "expense", amount: NaN, category: "Еда" })).toThrow("invalid_amount");

    expect(engine.remove(tx.id)).toBe(true);
    expect(engine.remove(tx.id)).toBe(false);
    expect(engine.list()).toHaveLength(0);
  });

  it("create без даты подставляет сегодняшнюю в формате YYYY-MM-DD", () => {
    const tx = engine.create({ type: "income", amount: 500, category: "Зарплата" });
    expect(tx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    engine.remove(tx.id);
  });
});

describe("server/budget — помесячная агрегация", () => {
  it("monthlySummary группирует по месяцу и категории, считает доходы/расходы раздельно", () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    engine.create({ type: "expense", amount: 100, category: "Еда", date: `${thisMonth}-05` });
    engine.create({ type: "expense", amount: 50, category: "Еда", date: `${thisMonth}-06` });
    engine.create({ type: "expense", amount: 30, category: "Транспорт", date: `${thisMonth}-07` });
    engine.create({ type: "income", amount: 1000, category: "Зарплата", date: `${thisMonth}-01` });

    const summary = engine.monthlySummary(3);
    expect(summary).toHaveLength(3);
    const current = summary[summary.length - 1];
    expect(current.month).toBe(thisMonth);
    expect(current.income).toBe(1000);
    expect(current.expense).toBe(180);
    expect(current.byCategory["Еда"]).toBe(150);
    expect(current.byCategory["Транспорт"]).toBe(30);
  });
});
