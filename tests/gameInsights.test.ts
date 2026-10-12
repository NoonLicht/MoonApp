import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Игровая аналитика (server/ts/gameInsights.ts). */
const req = createRequire(import.meta.url);
let gi: any;
beforeAll(() => {
  gi = req("../server/gameInsights");
});

describe("время игры и бэклог", () => {
  it("сопоставляет процесс с exe без учёта регистра и расширения", () => {
    const totals = { Cyberpunk2077: 3600, chrome: 100, "Cyberpunk2077.exe": 400 };
    expect(gi.playSecondsFor("D:\\Games\\Cyberpunk 2077\\Cyberpunk2077.exe", totals)).toBe(4000);
    expect(gi.playSecondsFor("", totals)).toBe(0);
    expect(gi.playSecondsFor("C:\\x\\unknown.exe", totals)).toBe(0);
  });

  it("порядок: играю сейчас → бэклог (старые раньше) → пройдено → брошено", () => {
    const mk = (id: string, status: string, playSeconds = 0, createdAt = 0) => ({
      id, name: id, status, playSeconds, createdAt,
    });
    const r = gi.backlogOrder([
      mk("dropped", "dropped"),
      mk("new", "backlog", 0, 200),
      mk("done", "done"),
      mk("playing-short", "playing", 10),
      mk("old", "backlog", 0, 100),
      mk("playing-long", "playing", 999),
    ]);
    expect(r.map((x: any) => x.id)).toEqual([
      "playing-long", "playing-short", "old", "new", "done", "dropped",
    ]);
  });
});

describe("gpuTier и recommend", () => {
  it("классифицирует видеокарты по названию", () => {
    expect(gi.gpuTier("NVIDIA GeForce RTX 4090")).toBe(5);
    expect(gi.gpuTier("NVIDIA GeForce RTX 3060 Ti")).toBe(2);
    expect(gi.gpuTier("NVIDIA GeForce GTX 1650")).toBe(0);
    expect(gi.gpuTier("AMD Radeon RX 7800 XT")).toBe(4);
    expect(gi.gpuTier("Intel(R) UHD Graphics 630")).toBe(0);
  });

  it("мощная карта на 1080p/60 — ультра без апскейла", () => {
    const r = gi.recommend({ gpuName: "RTX 4080", targetFps: 60, height: 1080 });
    expect(r.preset).toBe("ultra");
    expect(r.upscaler).toBe("none");
    expect(r.renderScale).toBe(1);
  });

  it("слабая карта на 1440p/144 — низкие и агрессивный апскейл", () => {
    const r = gi.recommend({ gpuName: "GTX 1650", targetFps: 144, height: 1440 });
    expect(r.preset).toBe("low");
    expect(r.upscaler).toBe("performance");
    expect(r.notes).not.toContain("frame-gen");
  });

  it("мало видеопамяти понижает пресет, высокий FPS на мощной карте включает генерацию кадров", () => {
    const low = gi.recommend({ gpuName: "RTX 4070", vramMb: 4096, targetFps: 60, height: 1080 });
    expect(low.preset).toBe("medium");
    expect(low.notes).toContain("vram-low");
    const fg = gi.recommend({ gpuName: "RTX 4080", targetFps: 120, height: 1440 });
    expect(fg.frameGen).toBe(true);
  });
});

describe("замеры кадров", () => {
  it("разбирает CSV PresentMon с запятой и ; с десятичной запятой", () => {
    const pm = "Application,MsBetweenPresents,Dropped\ngame.exe,16.6,0\ngame.exe,16.7,0\n";
    expect(gi.parseFrameCsv(pm)).toEqual([16.6, 16.7]);
    const cx = "Time;FrameTime\n0;16,5\n16;33,0\n";
    expect(gi.parseFrameCsv(cx)).toEqual([16.5, 33]);
    expect(gi.parseFrameCsv("a,b\n1,2")).toEqual([]);
  });

  it("считает средний FPS и 1% low", () => {
    const frames = [...Array(99).fill(10), 100]; // 99 кадров по 10 мс и один в 100 мс
    const s = gi.frameStats(frames);
    expect(s.frames).toBe(100);
    expect(s.avgFrameMs).toBe(10.9);
    expect(s.avgFps).toBe(91.7);
    expect(s.p1LowFps).toBe(10); // худший 1 % = один кадр в 100 мс
    expect(gi.frameStats([16, 16])).toBeNull();
  });

  it("сравнение: рост — better, шум — same, падение — worse", () => {
    const base = { frames: 1000, avgFps: 60, p1LowFps: 40, p01LowFps: 30, avgFrameMs: 16.7 };
    const up = gi.compareRuns(base, { ...base, avgFps: 72, p1LowFps: 50 });
    expect(up.verdict).toBe("better");
    expect(up.avgFpsDelta).toBe(12);
    expect(up.avgFpsPct).toBe(20);
    expect(gi.compareRuns(base, { ...base, avgFps: 60.5 }).verdict).toBe("same");
    expect(gi.compareRuns(base, { ...base, avgFps: 50, p1LowFps: 30 }).verdict).toBe("worse");
  });
});
