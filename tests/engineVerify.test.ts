import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/** Проверка контрольных сумм движков (scripts/ts/engineVerify.ts -> scripts/engineVerify.js). */
const req = createRequire(import.meta.url);
const m = (): any => req("../scripts/engineVerify");
const H = "a".repeat(64);

describe("engineVerify", () => {
  it("sha256 пустой строки известен", () => {
    expect(m().sha256(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("parseSums читает формат sha256sum, включая «*имя»", () => {
    const text = `${H}  yt-dlp.exe\r\n${"B".repeat(64)} *yt-dlp_x86.exe\n# мусор\n`;
    const r = m().parseSums(text);
    expect(r["yt-dlp.exe"]).toBe(H);
    expect(r["yt-dlp_x86.exe"]).toBe("b".repeat(64));
  });

  it("parseSingleSum находит хэш и возвращает null без него", () => {
    expect(m().parseSingleSum(`${H}  ffmpeg.zip`)).toBe(H);
    expect(m().parseSingleSum("нет хэша")).toBeNull();
  });

  it("assertSha256 бросает при расхождении", () => {
    const data = Buffer.from("abc");
    const good = m().sha256(data);
    expect(() => m().assertSha256("x", data, good)).not.toThrow();
    expect(() => m().assertSha256("x", data, H)).toThrow(/не совпала/);
  });

  it("checkLock: первая запись добавляется, дальше сверяется", () => {
    const lock: Record<string, string> = {};
    const data = Buffer.from("v1");
    expect(m().checkLock(lock, "k", data, false).added).toBe(true);
    expect(m().checkLock(lock, "k", data, false).added).toBe(false);
    expect(() => m().checkLock(lock, "k", Buffer.from("v2"), false)).toThrow(/не совпал/);
  });

  it("checkLock в strict-режиме не дописывает", () => {
    expect(() => m().checkLock({}, "k", Buffer.from("x"), true)).toThrow(/нет записи/);
  });
});
