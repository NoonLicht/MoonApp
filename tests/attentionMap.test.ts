import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Карта внимания (server/ts/attentionMap.ts). */
const req = createRequire(import.meta.url);
let a: any;
beforeAll(() => {
  a = req("../server/attentionMap");
});

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("категории приложений", () => {
  it("распознаёт по имени процесса", () => {
    expect(a.categoryOf("chrome")).toBe("browser");
    expect(a.categoryOf("Code")).toBe("dev");
    expect(a.categoryOf("Telegram")).toBe("chat");
    expect(a.categoryOf("steam")).toBe("game");
    expect(a.categoryOf("неизвестное")).toBe("other");
  });
});

describe("сетка недели", () => {
  const day = (h: Record<number, Record<string, number>>) =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [String(k), v]));

  it("раскладывает приложения, лекции и задачи по часам", () => {
    const stats = {
      "2026-10-10": day({ 10: { chrome: 1800, Code: 600 }, 22: { steam: 3000 } }),
    };
    const w = a.buildWeek({
      end: "2026-10-10",
      stats,
      lectures: [{ startMs: local(2026, 10, 10, 9, 30), durationMs: 90 * 60_000 }],
      tasksDone: [local(2026, 10, 10, 14, 5), local(2026, 10, 10, 14, 50)],
      days: 3,
    });
    expect(w.days.map((d: any) => d.date)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
    const d = w.days[2];
    expect(d.cells[10].appSec).toBe(2400);
    expect(d.cells[10].topApp).toBe("chrome");
    // лекция 9:30–11:00: полчаса в 9-м, час в 10-м
    expect(d.cells[9].lectureSec).toBe(1800);
    expect(d.cells[10].lectureSec).toBe(3600);
    expect(d.cells[14].tasks).toBe(2);
    expect(d.activeHours).toBe(3);
    expect(w.maxAppSec).toBe(3000);
  });

  it("считает вероятный сон по самой долгой паузе между днями", () => {
    const active = (hs: number[]) => Object.fromEntries(hs.map((h) => [String(h), { Code: 1200 }]));
    const stats = {
      "2026-10-08": active([10, 11, 12, 20, 21, 22, 23]),
      "2026-10-09": active([0, 1, 9, 10]), // сидел до 2, проснулся к 9
      "2026-10-10": active([9]),
    };
    const w = a.buildWeek({ end: "2026-10-10", stats, lectures: [], tasksDone: [], days: 3 });
    expect(w.days[0].sleep).toEqual({ from: 2, to: 9, hours: 7 });
    expect(w.days[1].sleep).toEqual({ from: 18, to: 9, hours: 15 });
    expect(w.days[2].sleep).toBeNull();
  });

  it("выбирает самую долгую тишину, а не первую", () => {
    const stats = { "2026-10-09": { "22": { Code: 1000 } }, "2026-10-10": { "1": { Code: 1000 }, "3": { Code: 1000 } } };
    const w = a.buildWeek({ end: "2026-10-10", stats, lectures: [], tasksDone: [], days: 2 });
    expect(w.days[0].sleep).toEqual({ from: 4, to: 12, hours: 8 });
  });
});

describe("факты и выводы", () => {
  it("считает вечернюю долю, ночные дни и серию часов", () => {
    const hrs: Record<number, Record<string, number>> = {};
    for (let h = 9; h <= 18; h++) hrs[h] = { Code: 3000 };
    hrs[23] = { chrome: 1800 };
    const stats = { "2026-10-10": hrs };
    const w = a.buildWeek({ end: "2026-10-10", stats, lectures: [], tasksDone: [], days: 1 });
    const f = a.factsOf(w, stats);
    expect(f.longestStreakHours).toBe(10);
    expect(f.lateNightDays).toBe(1);
    expect(f.eveningShare).toBeGreaterThan(0.1);
    expect(f.topApps[0].app).toBe("Code");
    expect(f.categories[0].category).toBe("dev");
    expect(a.insightsFrom(f)).toContain("streak:10");
  });

  it("промпт содержит сетку и вопрос", () => {
    const w = a.buildWeek({ end: "2026-10-10", stats: {}, lectures: [], tasksDone: [], days: 2 });
    const p = a.buildAskPrompt("почему вечером нет сил?", w, a.factsOf(w, {}));
    expect(p).toContain("2026-10-09");
    expect(p).toContain("почему вечером нет сил?");
  });
});
