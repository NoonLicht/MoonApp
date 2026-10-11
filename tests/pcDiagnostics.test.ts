import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Расследование тормозов и паспорт ПК (server/ts/slowdown.ts, pcPassport.ts). */
const req = createRequire(import.meta.url);
let sd: any;
let pp: any;
beforeAll(() => {
  sd = req("../server/slowdown");
  pp = req("../server/pcPassport");
});

const sample = (t: number, o: Partial<any> = {}) => ({
  t,
  cpuTotal: 20,
  memAvailMb: 8000,
  diskPct: 10,
  diskQueue: 0,
  procs: [],
  ...o,
});

describe("расследование тормозов", () => {
  it("находит перегрузку процессора и виновника с причиной", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample(i * 3, {
        cpuTotal: 92,
        procs: [
          { name: "MsMpEng", cpu: 340, ioMbs: 5, memMb: 400 },
          { name: "chrome#1", cpu: 30, ioMbs: 0, memMb: 500 },
          { name: "chrome#2", cpu: 25, ioMbs: 0, memMb: 300 },
        ],
      }),
    );
    const v = sd.analyze(samples, { totalMemMb: 16000 });
    expect(v.main).toBe("cpu");
    expect(v.findings[0]).toMatchObject({ cause: "cpu", severity: "high", why: "defender" });
    expect(v.culprits[0].name).toBe("MsMpEng");
    // процессы chrome#N складываются в один
    expect(v.culprits.find((c: any) => c.name === "chrome")?.avgCpu).toBe(55);
  });

  it("диск: высокая загрузка и очередь, виновник по обмену", () => {
    const samples = Array.from({ length: 8 }, (_, i) =>
      sample(i * 3, {
        diskPct: 98,
        diskQueue: 6,
        procs: [{ name: "SearchIndexer", cpu: 5, ioMbs: 80, memMb: 100 }],
      }),
    );
    const v = sd.analyze(samples);
    expect(v.main).toBe("disk");
    expect(v.findings[0].why).toBe("indexer");
    expect(v.peak.diskPct).toBe(98);
  });

  it("память: мало свободной", () => {
    const samples = Array.from({ length: 5 }, (_, i) => sample(i * 3, { memAvailMb: 400, procs: [{ name: "vmmem", cpu: 2, ioMbs: 0, memMb: 9000 }] }));
    const v = sd.analyze(samples, { totalMemMb: 16000 });
    expect(v.main).toBe("memory");
    expect(v.findings[0].why).toBe("vm");
  });

  it("спокойная система — без находок; пустой ввод — пустой вердикт", () => {
    expect(sd.analyze([sample(0), sample(3)], { totalMemMb: 16000 }).main).toBe("none");
    expect(sd.analyze([]).samples).toBe(0);
  });

  it("разбирает строку замера и отбрасывает мусор", () => {
    const s = sd.parseSample('{"t":2.5,"cpu":41,"mem":5000,"disk":120,"queue":1,"procs":[["a",10,1.5,30],["b"]]}');
    expect(s).toMatchObject({ t: 2.5, cpuTotal: 41, diskPct: 100 });
    expect(s.procs).toHaveLength(2);
    expect(sd.parseSample("не json")).toBeNull();
  });
});

describe("паспорт ПК", () => {
  const base = () => ({
    generatedAt: Date.UTC(2026, 9, 12),
    system: { hostname: "PC", osName: "Windows 11", osVersion: "10.0", osBuild: "26200", arch: "x64", uptimeSec: 7200 },
    cpu: { model: "Ryzen 7", coresPhysical: 8, coresLogical: 16 },
    memoryMb: 16384,
    gpus: [{ name: "RTX 3060", memoryMb: 12288 }],
    disks: [{ name: "C:", totalGb: 500, fs: "NTFS" }],
    drivers: [
      { cls: "DISPLAY", name: "RTX 3060", vendor: "NVIDIA", version: "31.0.15.1", date: "2021-05-01" },
      { cls: "NET", name: "Realtek GbE", vendor: "Realtek", version: "10.50", date: "2026-01-10" },
    ],
    tuning: { applied: [], history: [{ at: Date.UTC(2026, 8, 1), kind: "apply", ok: true, detail: "Игровой режим" }] },
    problems: [{ source: "whisper", message: "model not found", count: 3, firstAt: 1, lastAt: Date.UTC(2026, 9, 1), level: "error" }],
  });

  it("находит изменения между снимками", () => {
    const a = base();
    const b = base();
    b.generatedAt += 86_400_000;
    b.memoryMb = 32768;
    b.gpus = [{ name: "RTX 4070", memoryMb: 12288 }];
    b.drivers[1].version = "10.60";
    b.system.osBuild = "26300";
    const ch = pp.diffPassports(a, b).map((c: any) => c.text);
    expect(ch).toEqual(
      expect.arrayContaining([
        "RAM: 16 → 32 ГБ",
        "GPU добавлена: RTX 4070",
        "GPU пропала: RTX 3060",
        "Драйвер «Realtek GbE»: 10.50 → 10.60",
        "Windows: сборка 26200 → 26300",
      ]),
    );
    expect(pp.diffPassports(null, b)).toEqual([]);
  });

  it("устаревшие драйверы важных классов", () => {
    const st = pp.staleDrivers(base().drivers, Date.UTC(2026, 9, 12));
    expect(st.map((d: any) => d.name)).toEqual(["RTX 3060"]);
  });

  it("документ содержит разделы, а имя ПК можно скрыть", () => {
    const md = pp.toMarkdown(base(), { changes: [] });
    for (const h of ["# Паспорт ПК", "## Железо", "## Драйверы", "## История изменений", "## Что ломалось"])
      expect(md).toContain(h);
    expect(md).toContain("Ryzen 7");
    expect(md).toContain("Игровой режим");
    expect(md).toContain("whisper ×3");
    expect(md).toContain("Имя: PC");
    expect(pp.toMarkdown(base(), { changes: [], anonymize: true })).toContain("Имя: —");
  });

  it("хранилище накапливает изменения", () => {
    const a = base();
    const b = base();
    b.memoryMb = 8192;
    let s = pp.update({ last: null, changes: [] }, a);
    expect(s.added).toEqual([]);
    s = pp.update(s.store, b);
    expect(s.added).toHaveLength(1);
    expect(s.store.changes).toHaveLength(1);
  });
});
