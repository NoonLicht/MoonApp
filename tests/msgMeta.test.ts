import { describe, it, expect } from "vitest";
import { msgMeta, msgTime } from "@/pages/ai-chat/lib/msgMeta";

const U = { tok: "ток", sec: "с" };

describe("подпись под сообщением", () => {
  it("токены, время генерации и время суток", () => {
    const now = new Date();
    const d = new Date(now.getTime() - 60_000);
    const iso = d.toISOString().replace("T", " ").slice(0, 19);
    const out = msgMeta({ text: "x".repeat(3500), tokens: 1200, gen_ms: 9400, created_at: iso }, U, now);
    expect(out).toMatch(/^≈1\.2k ток · 9\.4 с · \d\d:\d\d$/);
  });

  it("без сохранённых токенов оценивает по длине, вчерашнее — с датой", () => {
    const now = new Date("2026-10-13T12:00:00");
    const out = msgMeta({ text: "x".repeat(70), created_at: "2026-10-11 10:00:00" }, U, now);
    expect(out).toMatch(/^≈20 ток · \d\d\.\d\d \d\d:\d\d$/);
    expect(msgTime(undefined)).toBe("");
  });
});
