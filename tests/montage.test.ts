import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Сшивка по смыслу (server/ts/montage.ts). */
const req = createRequire(import.meta.url);
let m: any;
beforeAll(() => {
  m = req("../server/montage");
});

const clip = (ref: string, s: number, e: number, score: number, ids = [1]) => ({
  title: `Лекция ${ref}`,
  ref,
  startMs: s * 1000,
  endMs: e * 1000,
  chunkIds: ids,
  snippet: "…",
  score,
});

describe("план монтажа", () => {
  it("берёт лучшие по релевантности в пределах лимита времени", () => {
    const plan = m.planMontage(
      [clip("1", 0, 100, 0.9), clip("2", 0, 100, 0.8), clip("3", 0, 100, 0.7)],
      { maxSeconds: 250 },
    );
    expect(plan.map((c: any) => c.ref)).toEqual(["1", "2"]);
    expect(m.totalSeconds(plan)).toBe(200);
  });

  it("первый клип берётся даже если один превышает лимит", () => {
    const plan = m.planMontage([clip("1", 0, 900, 0.9)], { maxSeconds: 60 });
    expect(plan).toHaveLength(1);
  });

  it("пересекающиеся отрывки одной записи не дублируются", () => {
    const plan = m.planMontage([clip("1", 0, 100, 0.9), clip("1", 50, 150, 0.8), clip("1", 200, 260, 0.5)]);
    expect(plan.map((c: any) => [c.startMs / 1000, c.endMs / 1000])).toEqual([
      [0, 100],
      [200, 260],
    ]);
  });

  it("хронологический порядок сортирует по записи и времени", () => {
    const plan = m.planMontage([clip("10", 0, 10, 0.9), clip("2", 50, 60, 0.8), clip("2", 0, 10, 0.7)], {
      order: "chronological",
    });
    expect(plan.map((c: any) => `${c.ref}@${c.startMs / 1000}`)).toEqual(["2@0", "2@50", "10@0"]);
  });
});

describe("ffmpeg и титры", () => {
  it("строит filter_complex на все входы", () => {
    const a = m.ffmpegArgs(["a.wav", "b.wav"], "out.mp3", 0.5);
    expect(a.filter((x: string) => x === "-i")).toHaveLength(2);
    const f = a[a.indexOf("-filter_complex") + 1];
    expect(f).toContain("concat=n=2:v=0:a=1[out]");
    expect(f).toContain("apad=pad_dur=0.5");
    expect(a).toContain("libmp3lame");
    expect(() => m.ffmpegArgs([], "x.mp3")).toThrow("no_inputs");
  });

  it("титры считают позицию с учётом пауз", () => {
    const caps = m.captions([clip("1", 60, 70, 1), clip("2", 0, 20, 1)], 1);
    expect(caps.map((c: any) => [c.at, c.from])).toEqual([
      ["00:00:00", "00:01:00"],
      ["00:00:11", "00:00:00"],
    ]);
  });
});
