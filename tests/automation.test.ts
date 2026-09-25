import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/automation");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-automation-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/automation");
});

describe("server/automation — CRUD лаунчеров", () => {
  it("create/list/remove работают", () => {
    const created = engine.createLauncher({ name: "Test Launcher", exePath: "C:\\tools\\x.exe", args: "--flag" });
    expect(created.id).toBeTruthy();
    expect(created.args).toBe("--flag");

    const list1 = engine.listLaunchers();
    expect(list1).toHaveLength(1);

    expect(engine.removeLauncher(created.id)).toBe(true);
    expect(engine.listLaunchers()).toHaveLength(0);
  });

  it("launch несуществующей записи/файла честно сообщает об ошибке", () => {
    expect(engine.launch("no-such-id").ok).toBe(false);
    const created = engine.createLauncher({ name: "Ghost", exePath: "C:\\nowhere\\ghost.exe" });
    const r = engine.launch(created.id);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("exe_not_found");
  });
});

describe("server/automation — планировщик заданий Windows (реальный schtasks, папка \\MoonApp\\)", () => {
  const taskName = `vitest-${Date.now()}`;

  afterAll(async () => {
    await engine.deleteScheduledTask(taskName);
  });

  it("createScheduledTask отклоняет запрос с несуществующим лаунчером", async () => {
    const r = await engine.createScheduledTask({
      name: "whatever",
      launcherId: "no-such-id",
      schedule: "DAILY",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("launcher_not_found");
  });

  it("полный цикл: создать реальное задание в \\MoonApp\\, увидеть его в списке, запустить и удалить", async () => {
    const launcher = engine.createLauncher({ name: "Notepad", exePath: "C:\\Windows\\System32\\notepad.exe" });

    const created = await engine.createScheduledTask({
      name: taskName,
      launcherId: launcher.id,
      schedule: "DAILY",
      time: "23:59",
    });
    expect(created.ok).toBe(true);

    const list = await engine.listScheduledTasks();
    expect(list.some((tsk) => tsk.name === taskName)).toBe(true);

    const ran = await engine.runScheduledTaskNow(taskName);
    expect(ran.ok).toBe(true);

    const deleted = await engine.deleteScheduledTask(taskName);
    expect(deleted.ok).toBe(true);

    const listAfter = await engine.listScheduledTasks();
    expect(listAfter.some((tsk) => tsk.name === taskName)).toBe(false);
  }, 20000);
});
