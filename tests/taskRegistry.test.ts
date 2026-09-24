import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Диспетчер фоновых задач (server/ts/taskRegistry.ts) — агрегатор job'ов всех
 * движков (компрессия/апскейл/озвучка/лекции/архив) для UI-попапа
 * (src/components/TaskManagerPanel.tsx) и для централизованной остановки всех
 * активных задач при закрытии приложения (electron/main.js → before-quit).
 *
 * Тестируем сам реестр изолированно (без реальных движков — не тянем ffmpeg
 * и т.п.): регистрация провайдера, агрегация, cancel/pause/resume по (engine,
 * id), устойчивость к сломанному провайдеру, killAllActive.
 */
const req = createRequire(import.meta.url);

beforeEach(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-taskreg-"));
  // Каждый тест — свежий модуль: providers — module-level Map, между тестами
  // регистрации накапливались бы иначе.
  if (req.cache) {
    for (const k of Object.keys(req.cache)) {
      if (k.includes("taskRegistry") || k.includes("routes" + path.sep + "tasks")) delete req.cache[k];
    }
  }
});

function taskRegistry(): any {
  return req("../server/taskRegistry");
}

describe("taskRegistry — агрегатор фоновых задач", () => {
  it("listAll собирает задачи всех зарегистрированных провайдеров", () => {
    const tr = taskRegistry();
    tr.registerProvider({
      engine: "fake-a",
      list: () => [
        {
          id: "1",
          engine: "fake-a",
          label: "job 1",
          stage: "encode",
          progress: 50,
          createdAt: 100,
          done: false,
          canCancel: true,
          canPause: false,
          paused: false,
        },
      ],
      cancel: () => true,
    });
    tr.registerProvider({
      engine: "fake-b",
      list: () => [
        {
          id: "2",
          engine: "fake-b",
          label: "job 2",
          stage: "queued",
          progress: 0,
          createdAt: 200,
          done: false,
          canCancel: true,
          canPause: false,
          paused: false,
        },
      ],
      cancel: () => true,
    });
    const all = tr.listAll();
    expect(all.map((t: any) => t.id).sort()).toEqual(["1", "2"]);
    // Новые сначала.
    expect(all[0].createdAt).toBeGreaterThanOrEqual(all[1].createdAt);
  });

  it("cancel/pause/resume маршрутизируются по имени движка", () => {
    const tr = taskRegistry();
    const calls: string[] = [];
    tr.registerProvider({
      engine: "fake-c",
      list: () => [],
      cancel: (id: string) => {
        calls.push(`cancel:${id}`);
        return true;
      },
      pause: (id: string) => {
        calls.push(`pause:${id}`);
        return true;
      },
      resume: (id: string) => {
        calls.push(`resume:${id}`);
        return true;
      },
    });
    expect(tr.cancel("fake-c", "x1")).toBe(true);
    expect(tr.pause("fake-c", "x1")).toBe(true);
    expect(tr.resume("fake-c", "x1")).toBe(true);
    expect(calls).toEqual(["cancel:x1", "pause:x1", "resume:x1"]);
    // Неизвестный движок — false, не исключение.
    expect(tr.cancel("no-such-engine", "x1")).toBe(false);
  });

  it("провайдер без pause/resume — вызовы просто возвращают false", () => {
    const tr = taskRegistry();
    tr.registerProvider({ engine: "fake-d", list: () => [], cancel: () => false });
    expect(tr.pause("fake-d", "x")).toBe(false);
    expect(tr.resume("fake-d", "x")).toBe(false);
  });

  it("сломанный provider.list() не обрушивает listAll() для остальных", () => {
    const tr = taskRegistry();
    tr.registerProvider({
      engine: "fake-broken",
      list: () => {
        throw new Error("boom");
      },
      cancel: () => false,
    });
    tr.registerProvider({
      engine: "fake-ok",
      list: () => [
        {
          id: "9",
          engine: "fake-ok",
          label: "ok",
          stage: "encode",
          progress: 1,
          createdAt: 1,
          done: false,
          canCancel: true,
          canPause: false,
          paused: false,
        },
      ],
      cancel: () => true,
    });
    const all = tr.listAll();
    expect(all.some((t: any) => t.id === "9")).toBe(true);
  });

  it("killAllActive отменяет каждую незавершённую задачу ровно один раз", () => {
    const tr = taskRegistry();
    const cancelled: string[] = [];
    tr.registerProvider({
      engine: "fake-e",
      list: () => [
        {
          id: "a",
          engine: "fake-e",
          label: "a",
          stage: "encode",
          progress: 10,
          createdAt: 1,
          done: false,
          canCancel: true,
          canPause: false,
          paused: false,
        },
        {
          id: "b",
          engine: "fake-e",
          label: "b",
          stage: "done",
          progress: 100,
          createdAt: 2,
          done: true, // уже завершена — killAllActive не должен её трогать
          canCancel: false,
          canPause: false,
          paused: false,
        },
      ],
      cancel: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    const n = tr.killAllActive();
    expect(n).toBe(1);
    expect(cancelled).toEqual(["a"]);
  });
});

describe("POST /api/tasks/:engine/:id/cancel — маршрут", () => {
  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/", req("../server/routes/tasks"));
    return app;
  };

  const call = async (app: express.Express, method: string, path_: string) => {
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path_}`, { method });
      return { status: res.status, body: await res.json() };
    } finally {
      srv.close();
    }
  };

  it("неизвестная задача → 404", async () => {
    const r = await call(makeApp(), "POST", "/no-such-engine/xyz/cancel");
    expect(r.status).toBe(404);
  });

  it("GET / отдаёт { tasks: [] } когда никто не зарегистрирован сверх дефолтных провайдеров", async () => {
    const r = await call(makeApp(), "GET", "/");
    // Реальные движки (compressor/tts/...) регистрируются, только если их
    // модуль был require'ирован где-то раньше в процессе — здесь достаточно
    // проверить форму ответа, а не пустоту списка.
    expect(Array.isArray(r.body.tasks)).toBe(true);
  });
});
