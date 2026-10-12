import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Единый планировщик задач (server/ts/jobQueue.ts -> server/jobQueue.js).
 * Проверяем поведение: лимиты ресурсов, приоритеты, пауза, отмена, повтор.
 */
const req = createRequire(import.meta.url);

let mod: any;
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-jq-"));
  mod = req("../server/jobQueue");
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe("jobQueue", () => {
  it("не запускает больше задач на ресурс, чем лимит", async () => {
    const s = mod.createScheduler({ gpu: 1 });
    const g = gate();
    const order: string[] = [];
    const mk = (n: string) =>
      s.enqueue({
        engine: "t",
        label: n,
        resource: "gpu",
        run: async () => {
          order.push(`start:${n}`);
          await g.p;
          order.push(`end:${n}`);
        },
      });
    mk("a");
    mk("b");
    await tick();
    expect(order).toEqual(["start:a"]);
    expect(s.stats().gpu).toMatchObject({ running: 1, waiting: 1 });
    g.open();
    await tick(20);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("разные ресурсы не мешают друг другу", async () => {
    const s = mod.createScheduler({ gpu: 1, cpu: 1 });
    const g = gate();
    const started: string[] = [];
    for (const r of ["gpu", "cpu"]) {
      s.enqueue({
        engine: "t",
        label: r,
        resource: r,
        run: async () => {
          started.push(r);
          await g.p;
        },
      });
    }
    await tick();
    expect(started.sort()).toEqual(["cpu", "gpu"]);
    g.open();
  });

  it("высокий приоритет обгоняет ожидающих", async () => {
    const s = mod.createScheduler({ cpu: 1 });
    const g = gate();
    const order: string[] = [];
    const mk = (n: string, priority = 0) =>
      s.enqueue({
        engine: "t",
        label: n,
        resource: "cpu",
        priority,
        run: async () => {
          order.push(n);
          if (n === "first") await g.p;
        },
      });
    mk("first");
    mk("low");
    mk("urgent", 10);
    await tick();
    g.open();
    await tick(20);
    expect(order).toEqual(["first", "urgent", "low"]);
  });

  it("пауза удерживает задачу в очереди, resume возвращает", async () => {
    const s = mod.createScheduler({ cpu: 1 });
    const g = gate();
    let ran = false;
    s.enqueue({ engine: "t", label: "busy", resource: "cpu", run: () => g.p });
    const id = s.enqueue({
      engine: "t",
      label: "p",
      resource: "cpu",
      run: async () => {
        ran = true;
      },
    });
    expect(s.pause(id)).toBe(true);
    g.open();
    await tick(20);
    expect(ran).toBe(false);
    expect(s.resume(id)).toBe(true);
    await tick(20);
    expect(ran).toBe(true);
  });

  it("отмена ожидающей задачи и сигнал отмены у запущенной", async () => {
    const s = mod.createScheduler({ cpu: 1 });
    let sawAbort = false;
    const runId = s.enqueue({
      engine: "t",
      label: "run",
      resource: "cpu",
      run: (ctx: any) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        }),
    });
    const waitId = s.enqueue({ engine: "t", label: "w", resource: "cpu", run: async () => {} });
    await tick();
    expect(s.cancel(waitId)).toBe(true);
    expect(s.cancel(runId)).toBe(true);
    await tick(20);
    expect(sawAbort).toBe(true);
    const states = Object.fromEntries(s.list().map((j: any) => [j.label, j.state]));
    expect(states).toEqual({ run: "canceled", w: "canceled" });
    expect(s.cancel(runId)).toBe(false);
  });

  it("автоповтор: падает, затем успешно, и считает попытки", async () => {
    const s = mod.createScheduler({ net: 1 });
    let calls = 0;
    s.enqueue({
      engine: "t",
      label: "flaky",
      resource: "net",
      maxAttempts: 3,
      backoffMs: 5,
      run: async () => {
        calls++;
        if (calls < 3) throw new Error("сеть");
      },
    });
    await tick(80);
    const j = s.list()[0];
    expect(calls).toBe(3);
    expect(j.state).toBe("done");
    expect(j.attempts).toBe(3);
  });

  it("исчерпанные попытки дают failed, retry возвращает в работу", async () => {
    const s = mod.createScheduler({ net: 1 });
    let fail = true;
    const id = s.enqueue({
      engine: "t",
      label: "x",
      resource: "net",
      run: async () => {
        if (fail) throw new Error("боом");
      },
    });
    await tick(20);
    expect(s.list()[0]).toMatchObject({ state: "failed", error: "боом" });
    fail = false;
    expect(s.retry(id)).toBe(true);
    await tick(20);
    expect(s.list()[0].state).toBe("done");
  });

  it("withSlot ждёт слот и возвращает результат; ошибки пробрасываются", async () => {
    const s = mod.createScheduler({ gpu: 1 });
    const g = gate();
    const order: string[] = [];
    s.enqueue({
      engine: "t",
      label: "holder",
      resource: "gpu",
      run: async () => {
        order.push("holder");
        await g.p;
      },
    });
    const res = s.withSlot("gpu", async () => {
      order.push("slot");
      return 42;
    });
    await tick();
    expect(order).toEqual(["holder"]);
    g.open();
    expect(await res).toBe(42);
    await expect(
      s.withSlot("gpu", async () => {
        throw new Error("ой");
      }),
    ).rejects.toThrow("ой");
    // скрытые слоты не попадают в список задач
    expect(s.list().every((j: any) => j.label !== "slot")).toBe(true);
  });

  it("setPaused останавливает запуск новых задач", async () => {
    const s = mod.createScheduler({ cpu: 2 });
    s.setPaused(true);
    let ran = false;
    s.enqueue({
      engine: "t",
      label: "a",
      resource: "cpu",
      run: async () => {
        ran = true;
      },
    });
    await tick(20);
    expect(ran).toBe(false);
    s.setPaused(false);
    await tick(20);
    expect(ran).toBe(true);
  });

  it("общий планировщик виден в Диспетчере задач как engine «queue»", async () => {
    const reg = req("../server/taskRegistry");
    const id = mod.scheduler.enqueue({
      engine: "unit",
      label: "виден",
      resource: "cpu",
      run: async () => {},
    });
    await tick(20);
    const t = reg.listAll().find((x: any) => x.engine === "queue" && x.id === id);
    expect(t).toMatchObject({ label: "виден", done: true, progress: 100 });
  });
});
