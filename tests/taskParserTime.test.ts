import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Разбор времени в заголовке задачи (server/routes/myspace-tasks.js).
 *
 * Регресс-контекст: блок «at 20:00» (плюс am/pm) лежал ТРЕМЯ копиями — внутри
 * веток «tomorrow», «today» и «next monday». Копии уже почти разошлись, поэтому
 * логика сведена в matchTime/applyTime. Тесты бьют по ЖИВОМУ роуту
 * POST /api/myspace/tasks: важно, что все три ветки по-прежнему дописывают
 * время в уже вычисленную дату, а не только что код «выглядит» общим.
 *
 * Ожидаемые даты считаем той же локальной арифметикой, что и парсер, и
 * сравниваем ISO-строки — так проверка не зависит от часового пояса стенда.
 */
const require = createRequire(import.meta.url);

const isoTodayAt = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const isoTomorrowAt = (h: number, m: number) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const isoNextMondayAt = (h: number, m: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let daysUntil = 1 - d.getDay(); // 1 = понедельник
  if (daysUntil <= 0) daysUntil += 7;
  d.setDate(d.getDate() + daysUntil);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

describe("Парсер времени задач (/api/myspace/tasks)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";

  /** Создать задачу и вернуть её тело. */
  async function createTask(title: string) {
    const res = await fetch(`${base}/api/myspace/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-tasks-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = require("express");
    const router = require("../server/routes/myspace-tasks");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/myspace/tasks", router);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => {
    try {
      srv?.close();
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("«tomorrow at 20:00» — время ставится на завтрашний вечер", async () => {
    const task: any = await createTask("Купить хлеб tomorrow at 20:00");
    expect(task.dueDate).toBe(isoTomorrowAt(20, 0));
    expect(task.title).toBe("Купить хлеб");
  });

  it("«today at 9:30» — время ставится на сегодня", async () => {
    const task: any = await createTask("Позвонить today at 9:30");
    expect(task.dueDate).toBe(isoTodayAt(9, 30));
    expect(task.title).toBe("Позвонить");
  });

  it("«next monday at 14:00» — время ставится на ближайший понедельник", async () => {
    const task: any = await createTask("Отчёт next monday at 14:00");
    expect(task.dueDate).toBe(isoNextMondayAt(14, 0));
    expect(task.title).toBe("Отчёт");
  });

  it("12-часовой формат: pm добавляет 12 часов, 12 am — это полночь", async () => {
    const pm: any = await createTask("Встреча today at 9:30 pm");
    expect(pm.dueDate).toBe(isoTodayAt(21, 30));

    const midnight: any = await createTask("Смена today at 12:00 am");
    expect(midnight.dueDate).toBe(isoTodayAt(0, 0));

    const noon: any = await createTask("Обед today at 12:00 pm");
    expect(noon.dueDate).toBe(isoTodayAt(12, 0));
  });

  it("без времени дата не получает часов: «tomorrow» остаётся полуночью", async () => {
    const task: any = await createTask("Задача tomorrow");
    expect(task.dueDate).toBe(isoTomorrowAt(0, 0));
    expect(task.title).toBe("Задача");
  });

  it("время вырезается из заголовка, а не остаётся в нём", async () => {
    const task: any = await createTask("Созвон tomorrow at 11:00 с командой");
    expect(task.title).not.toContain("at");
    expect(task.title).toContain("Созвон");
    expect(task.title).toContain("командой");
  });

  it("копипаста блока времени не вернулась", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "server", "routes", "myspace-tasks.js"),
      "utf8",
    );
    const copies = (src.match(/const timeMatch = text\.match/g) || []).length;
    expect(copies, "дубли блока времени вернулись").toBe(0);
    expect((src.match(/function matchTime\(/g) || []).length).toBe(1);
    expect((src.match(/function applyTime\(/g) || []).length).toBe(1);
  });
});
