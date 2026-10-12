import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Алерты и история монитора (server/ts/monitorAlerts.ts) — только чистое ядро. */
const req = createRequire(import.meta.url);
let ma: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ma-"));
  ma = req("../server/monitorAlerts");
});

const sample = (t: number, over: Record<string, unknown> = {}) => ({
  t,
  cpuTemp: 50,
  gpuTemp: 50,
  cpuLoad: 10,
  ramPercent: 40,
  diskFree: { "C:": 50 },
  ...over,
});
const MIN = 60_000;

describe("AlertEngine", () => {
  it("перегрев срабатывает только после выдержки и не чаще cooldown", () => {
    const e = new ma.AlertEngine();
    const hot = (t: number) => sample(t, { cpuTemp: 95 });
    expect(e.evaluate(hot(0))).toEqual([]);
    expect(e.evaluate(hot(30_000))).toEqual([]);
    const fired = e.evaluate(hot(MIN));
    expect(fired).toHaveLength(1);
    expect(fired[0].rule).toBe("cpu-temp");
    expect(e.evaluate(hot(2 * MIN))).toEqual([]); // cooldown
    expect(e.evaluate(hot(12 * MIN))).toHaveLength(1); // cooldown прошёл
  });

  it("кратковременный всплеск сбрасывает таймер выдержки", () => {
    const e = new ma.AlertEngine();
    e.evaluate(sample(0, { cpuTemp: 95 }));
    e.evaluate(sample(40_000, { cpuTemp: 60 }));
    expect(e.evaluate(sample(70_000, { cpuTemp: 95 }))).toEqual([]);
  });

  it("мало места на диске — сразу, SMART не Healthy — сразу", () => {
    const e = new ma.AlertEngine();
    const fired = e.evaluate(sample(1, { diskFree: { "D:": 4.2 } }), [
      { name: "WD", health: "Warning", operational: "OK", temperatureC: null, wearPercent: null },
    ]);
    expect(fired.map((f: any) => f.rule).sort()).toEqual(["disk-space", "smart"]);
    expect(fired.find((f: any) => f.rule === "disk-space").message).toContain("D:");
  });

  it("журнал ограничен", () => {
    const e = new ma.AlertEngine(ma.DEFAULT_RULES, 3);
    for (let i = 0; i < 10; i++) {
      e.evaluate(sample(i * 25 * 3_600_000, { diskFree: { "C:": 1 } }));
    }
    expect(e.log).toHaveLength(3);
  });
});

describe("History", () => {
  it("не растёт сверх лимита и прореживает выдачу", () => {
    const h = new ma.History(100);
    for (let i = 0; i < 250; i++) h.push(sample(i * 1000));
    expect(h.size).toBe(100);
    const s = h.series(10 * MIN, 20, 250 * 1000);
    expect(s).toHaveLength(20);
    expect(s[0].t).toBeLessThan(s[19].t);
  });

  it("load отбрасывает мусор", () => {
    const h = new ma.History(10);
    h.load([sample(1), { x: 1 }, null]);
    expect(h.size).toBe(1);
  });
});

describe("разбор данных", () => {
  it("parseSmart: один объект и массив, битый JSON", () => {
    const one = ma.parseSmart(
      JSON.stringify({ FriendlyName: "Samsung 980", HealthStatus: "Healthy", Temperature: 41 }),
    );
    expect(one).toEqual([
      { name: "Samsung 980", health: "Healthy", operational: "", temperatureC: 41, wearPercent: null },
    ]);
    expect(ma.parseSmart("[{\"FriendlyName\":\"A\"},{\"FriendlyName\":\"B\"}]")).toHaveLength(2);
    expect(ma.parseSmart("не json")).toEqual([]);
  });

  it("sampleFromSnapshot считает свободное место и берёт максимум температуры GPU", () => {
    const s = ma.sampleFromSnapshot(
      {
        cpu: { temperatureC: 70, loadTotalPercent: 33 },
        memory: { usedPercent: 61 },
        gpu: [{ temperatureC: 55 }, { temperatureC: 72 }, { temperatureC: null }],
        disks: [
          { drive: "C:", totalGb: 500, freeGb: 50 },
          { drive: "E:", totalGb: null, freeGb: null },
        ],
      },
      123,
    );
    expect(s).toEqual({
      t: 123,
      cpuTemp: 70,
      gpuTemp: 72,
      cpuLoad: 33,
      ramPercent: 61,
      diskFree: { "C:": 10 },
    });
  });
});
