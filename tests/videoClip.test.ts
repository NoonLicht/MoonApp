import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Фрагмент видео (server/ts/videoClip.ts). */
const req = createRequire(import.meta.url);
let vc: any;
beforeAll(() => {
  vc = req("../server/videoClip");
});

describe("parseTime", () => {
  it("секунды и ЧЧ:ММ:СС", () => {
    expect(vc.parseTime("90")).toBe(90);
    expect(vc.parseTime("1:30")).toBe(90);
    expect(vc.parseTime("01:02:03")).toBe(3723);
    expect(vc.parseTime("0:05.5")).toBe(5.5);
  });
  it("неверное — null", () => {
    for (const v of ["", "abc", "1:75", "1:2:3:4", "-5", null, undefined]) expect(vc.parseTime(v)).toBeNull();
  });
});

describe("normalizeClip", () => {
  it("пустые границы — без фрагмента", () => {
    expect(vc.normalizeClip("", "")).toBeNull();
  });
  it("только начало берёт конец из длительности", () => {
    expect(vc.normalizeClip("1:00", "", 300)).toEqual({ from: 60, to: 300 });
  });
  it("конец обрезается по длительности", () => {
    expect(vc.normalizeClip("10", "9999", 120)).toEqual({ from: 10, to: 120 });
  });
  it("ошибки: порядок, начало за пределами, слишком длинный", () => {
    expect(() => vc.normalizeClip("50", "10")).toThrow("bad_clip");
    expect(() => vc.normalizeClip("500", "600", 100)).toThrow("bad_clip");
    expect(() => vc.normalizeClip("0", "7:00:00")).toThrow("clip_too_long");
    expect(() => vc.normalizeClip("10", "")).toThrow("bad_clip");
  });
});

describe("clipArgs", () => {
  it("формирует секцию для yt-dlp", () => {
    expect(vc.clipArgs({ from: 90, to: 3723 })).toEqual([
      "--download-sections",
      "*00:01:30-01:02:03",
      "--force-keyframes-at-cuts",
    ]);
  });
});
