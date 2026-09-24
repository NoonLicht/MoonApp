import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/appTimeTracker");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-apptracker-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/appTimeTracker");
});

describe("server/appTimeTracker — статус и данные (без реального PowerShell)", () => {
  it("status() честно сообщает tracking:false, пока start() не вызван", () => {
    expect(engine.status()).toEqual({ tracking: false });
  });

  it("todayStats() на пустом storage отдаёт пустой список", () => {
    const t = engine.todayStats();
    expect(t.apps).toEqual([]);
    expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("history() на пустом storage отдаёт пустой массив", () => {
    expect(engine.history(7)).toEqual([]);
  });

  it("stop() без активного трекинга не падает", () => {
    expect(engine.stop()).toEqual({ ok: true });
    expect(engine.status().tracking).toBe(false);
  });
});
