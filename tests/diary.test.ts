import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Дневник (server/ts/diary.ts): файлы по датам, серия дней, сводка недели. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-diary-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let d: any;
beforeAll(() => {
  d = req("../server/diary");
});

describe("даты и безопасность путей", () => {
  it("принимает только существующие календарные даты", () => {
    expect(d.isValidDate("2026-02-28")).toBe(true);
    expect(d.isValidDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "../../x", "2026-01-01/../a", "", null, 5]) {
      expect(d.isValidDate(bad), String(bad)).toBe(false);
    }
  });

  it("запись/чтение выходят только в каталог дневника; плохая дата — ошибка", () => {
    expect(() => d.readEntry("../../secrets")).toThrow("invalid_date");
    expect(() => d.writeEntry("2026-01-01/../../evil", "x")).toThrow("invalid_date");
    expect(fs.existsSync(path.join(STORAGE, "evil.md"))).toBe(false);
  });
});

describe("записи", () => {
  it("write → read → list; пустой текст удаляет файл", () => {
    d.writeEntry("2026-06-01", "# Хороший день\nСходил в зал и написал код");
    d.writeEntry("2026-06-03", "- купил хлеб");
    expect(d.readEntry("2026-06-01")).toMatchObject({ exists: true });
    expect(d.readEntry("2026-06-02")).toEqual({ date: "2026-06-02", content: "", exists: false });
    const list = d.listEntries();
    expect(list.map((i: any) => i.date)).toEqual(["2026-06-03", "2026-06-01"]);
    expect(list[1]).toMatchObject({ preview: "Хороший день", words: 8 });
    expect(d.listEntries("2026-06-02", "2026-06-30").map((i: any) => i.date)).toEqual(["2026-06-03"]);
    d.writeEntry("2026-06-03", "   ");
    expect(d.readEntry("2026-06-03").exists).toBe(false);
  });

  it("шаблон хранится отдельно и не попадает в список записей", () => {
    expect(d.getTemplate()).toBeNull();
    d.setTemplate("## Утро\n\n## Вечер");
    expect(d.getTemplate()).toBe("## Утро\n\n## Вечер");
    expect(d.listEntries().some((i: any) => i.date.startsWith("_"))).toBe(false);
    expect(d.setTemplate("")).toBeNull();
    expect(d.getTemplate()).toBeNull();
  });
});

describe("серия дней", () => {
  it("считает подряд идущие дни; сегодняшний пропуск не рвёт серию", () => {
    expect(d.streak(["2026-06-08", "2026-06-09", "2026-06-10"], "2026-06-10")).toBe(3);
    expect(d.streak(["2026-06-08", "2026-06-09"], "2026-06-10")).toBe(2); // сегодня ещё не писали
    expect(d.streak(["2026-06-07", "2026-06-09"], "2026-06-10")).toBe(1);
    expect(d.streak(["2026-06-01"], "2026-06-10")).toBe(0);
  });
});

describe("неделя", () => {
  it("weekRange: понедельник–воскресенье, в том числе через границу месяца и года", () => {
    expect(d.weekRange("2026-06-10")).toMatchObject({ start: "2026-06-08", end: "2026-06-14" });
    expect(d.weekRange("2026-06-14").start).toBe("2026-06-08"); // воскресенье
    expect(d.weekRange("2026-06-08").start).toBe("2026-06-08"); // понедельник
    expect(d.weekRange("2026-01-01")).toMatchObject({ start: "2025-12-29", end: "2026-01-04" });
    expect(d.weekRange("2026-06-10").days).toHaveLength(7);
  });

  const src = {
    entries: [
      { date: "2026-06-09", content: "Работал над проектом" },
      { date: "2026-06-20", content: "другая неделя" },
      { date: "2026-06-10", content: "   " },
    ],
    tasks: [
      { title: "A", status: "completed", created_at: "2026-06-01T10:00:00Z", updated_at: "2026-06-09T10:00:00Z" },
      { title: "B", status: "todo", created_at: "2026-06-10T08:00:00Z", updated_at: "2026-06-10T08:00:00Z" },
      { title: "C", status: "completed", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
    ],
    notes: [
      { title: "Идеи", updated_at: "2026-06-11 12:00:00" },
      { title: "Старая", updated_at: "2026-01-01 00:00:00" },
    ],
    lectures: [{ title: "Матан", started_at: "2026-06-12 09:00:00" }],
  };

  it("collectWeek отбирает только данные этой недели", () => {
    const w = d.collectWeek("2026-06-10", src);
    expect(w.entries.map((e: any) => e.date)).toEqual(["2026-06-09"]);
    expect(w.tasksDone).toEqual(["A"]);
    expect(w.tasksCreated).toEqual(["B"]);
    expect(w.notesTouched).toEqual(["Идеи"]);
    expect(w.lectures).toEqual(["Матан"]);
  });

  const labels = { title: "Week", entries: "Entries", tasksDone: "Done", tasksCreated: "Added", notes: "Notes", lectures: "Lectures", nothing: "Nothing." };

  it("buildDigest: цифровая сводка без ИИ; пустая неделя — заглушка", () => {
    const text = d.buildDigest(d.collectWeek("2026-06-10", src), labels);
    expect(text).toContain("## Week 2026-06-08 — 2026-06-14");
    expect(text).toContain("**Done: 1**\n- A");
    expect(text).toContain("2026-06-09: Работал над проектом");
    const empty = d.buildDigest(d.collectWeek("2026-06-10", { entries: [], tasks: [], notes: [], lectures: [] }), labels);
    expect(empty).toContain("Nothing.");
  });

  it("buildWeekPrompt содержит данные недели и язык ответа и не выдаёт чужие недели", () => {
    const p = d.buildWeekPrompt(d.collectWeek("2026-06-10", src), "English");
    expect(p).toContain("English");
    expect(p).toContain("### 2026-06-09");
    expect(p).toContain("ВЫПОЛНЕННЫЕ ЗАДАЧИ:\n- A");
    expect(p).not.toContain("другая неделя");
  });

  it("weekSummary без ключа ИИ возвращает цифровую сводку, а не падает", async () => {
    d.writeEntry("2026-06-09", "Работал над проектом");
    const r = await d.weekSummary("2026-06-10", "Russian", labels);
    expect(r.ai).toBe(false);
    expect(r.markdown).toContain("Работал над проектом");
    expect(typeof r.aiError).toBe("string");
  });
});

describe("сохранённый итог недели", () => {
  it("общий для всех дней недели (пн–вс), правится и удаляется", () => {
    expect(d.getSavedSummary("2026-03-04").exists).toBe(false);
    d.saveSummary("2026-03-04", "## Итог\n\nХорошая неделя", { ai: true, model: "m" });
    for (const day of ["2026-03-02", "2026-03-04", "2026-03-08"]) {
      const s = d.getSavedSummary(day);
      expect(s.exists, day).toBe(true);
      expect(s.markdown).toContain("Хорошая неделя");
      expect(s.ai).toBe(true);
    }
    // соседняя неделя — пустая
    expect(d.getSavedSummary("2026-03-09").exists).toBe(false);
    // ручная правка сохраняет признак «писал ИИ» и помечает правку
    const e = d.saveSummary("2026-03-06", "Мой текст", { edited: true });
    expect(e.ai).toBe(true);
    expect(e.edited).toBe(true);
    // пустой текст удаляет итог
    expect(d.saveSummary("2026-03-05", "  ").exists).toBe(false);
    expect(d.getSavedSummary("2026-03-04").exists).toBe(false);
  });

  it("не мешает списку записей дневника", () => {
    d.saveSummary("2026-04-01", "x", { ai: true });
    expect(d.listEntries().some((i: { date: string }) => i.date.startsWith("_"))).toBe(false);
  });
});

describe("итог, прикреплённый к дню", () => {
  it("хранится отдельно от записи и не меняет её текст", () => {
    d.writeEntry("2026-05-04", "сырая запись");
    expect(d.getDaySummary("2026-05-04").exists).toBe(false);
    d.saveDaySummary("2026-05-04", "## Итог\n\nготово", { ai: true, model: "m" });
    expect(d.getDaySummary("2026-05-04")).toMatchObject({ exists: true, ai: true, markdown: "## Итог\n\nготово" });
    expect(d.getDaySummary("2026-05-05").exists).toBe(false);
    expect(d.readEntry("2026-05-04").content).toBe("сырая запись");
    expect(d.saveDaySummary("2026-05-04", " ").exists).toBe(false);
    expect(() => d.getDaySummary("../x")).toThrow("invalid_date");
  });
});
