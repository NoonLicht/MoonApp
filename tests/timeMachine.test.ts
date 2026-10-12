import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** «Машина времени» (server/ts/timeMachine.ts). */
const req = createRequire(import.meta.url);
let tm: any;
beforeAll(() => {
  tm = req("../server/timeMachine");
});

const at = (d: string) => new Date(`${d}T12:00:00`).getTime();

describe("снимки", () => {
  it("берёт последний коммит не позже даты", () => {
    const commits = [
      { oid: "a", timestamp: at("2026-01-10"), message: "" },
      { oid: "b", timestamp: at("2026-02-10"), message: "" },
      { oid: "c", timestamp: at("2026-03-10"), message: "" },
    ];
    expect(tm.pickCommit(commits, tm.endOfDay("2026-02-28")).oid).toBe("b");
    expect(tm.pickCommit(commits, tm.endOfDay("2026-02-10")).oid).toBe("b");
    expect(tm.pickCommit(commits, tm.endOfDay("2025-12-31"))).toBeNull();
  });

  it("граница диапазона — самая ранняя запись среди источников", () => {
    const r = tm.rangeOf({
      commits: [{ oid: "a", timestamp: at("2026-02-10"), message: "" }],
      txDates: ["2026-01-05"],
      taskCreated: ["2026-01-20T10:00:00.000Z"],
      diaryDates: ["2026-03-01"],
      now: at("2026-04-01"),
    });
    expect(r).toEqual({ from: "2026-01-05", to: "2026-04-01" });
  });
});

describe("траты на дату", () => {
  const txs = [
    { type: "income", amount: 1000, category: "Зарплата", date: "2026-01-01" },
    { type: "expense", amount: 200, category: "Еда", date: "2026-01-15" },
    { type: "expense", amount: 50, category: "Еда", date: "2026-01-20" },
    { type: "expense", amount: 300, category: "Жильё", date: "2026-02-01" },
    { type: "expense", amount: 10, category: "Еда", date: "2026-01-31", currency: "USD", rates: { USD: 90 } },
  ];
  it("считает баланс и категории месяца только до даты", () => {
    const b = tm.budgetAsOf(txs, "2026-01-25");
    expect(b.count).toBe(3);
    expect(b.income).toBe(1000);
    expect(b.expense).toBe(250);
    expect(b.balance).toBe(750);
    expect(b.monthByCategory).toEqual([{ category: "Еда", amount: 250 }]);
  });

  it("пересчитывает валюту по сохранённому курсу", () => {
    expect(tm.budgetAsOf(txs, "2026-01-31").expense).toBe(1150);
  });
});

describe("задачи на дату", () => {
  const tasks = [
    { id: "1", title: "старая", status: "done", created_at: "2026-01-01T10:00:00.000Z", updated_at: "2026-01-05T10:00:00.000Z" },
    { id: "2", title: "потом закрыта", status: "completed", created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-03-05T10:00:00.000Z" },
    { id: "3", title: "ещё не было", status: "todo", created_at: "2026-04-01T10:00:00.000Z", updated_at: "2026-04-01T10:00:00.000Z" },
  ];
  it("скрывает будущие, а позже закрытые показывает открытыми", () => {
    const r = tm.tasksAsOf(tasks, "2026-02-01");
    expect(r.map((t: any) => [t.id, t.status])).toEqual([
      ["1", "done"],
      ["2", "open"],
    ]);
  });
});

describe("восстановление копией", () => {
  it("не затирает существующее: подбирает свободное имя", () => {
    const taken = new Set(["notes/План (из 2026-01-01).md"]);
    expect(tm.restoredName("notes/План.md", "2026-01-01", (p: string) => taken.has(p))).toBe(
      "notes/План (из 2026-01-01) 2.md",
    );
    expect(tm.restoredName("notes/Без расширения", "2026-01-01", () => false)).toBe(
      "notes/Без расширения (из 2026-01-01)",
    );
  });

  it("автоснимок по интервалу", () => {
    expect(tm.shouldSnapshot(0, 6 * 3_600_000, 6)).toBe(true);
    expect(tm.shouldSnapshot(0, 6 * 3_600_000 - 1, 6)).toBe(false);
  });
});
