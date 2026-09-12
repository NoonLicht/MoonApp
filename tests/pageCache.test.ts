import { describe, it, expect } from "vitest";
import { evictPages, touchPage, samePages, KEEP_ALIVE_DEFAULT_LIMIT } from "../src/utils/pageCache";

type P = "a" | "b" | "c" | "d" | "e" | "f" | "g";

const base = {
  active: "a" as P,
  busy: [] as P[],
  lastUsed: {} as Record<string, number>,
  limit: KEEP_ALIVE_DEFAULT_LIMIT,
  idleMs: 0,
  now: 1_000_000,
};

describe("pageCache — LRU-кэш живых страниц", () => {
  it("touchPage поднимает страницу в начало без дублей", () => {
    expect(touchPage(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touchPage(["a", "b"], "z")).toEqual(["z", "a", "b"]);
  });

  it("samePages сравнивает по значению", () => {
    expect(samePages(["a", "b"], ["a", "b"])).toBe(true);
    expect(samePages(["a", "b"], ["b", "a"])).toBe(false);
    expect(samePages(["a"], ["a", "b"])).toBe(false);
  });

  it("без превышения лимита и простоя ничего не выгружается", () => {
    expect(evictPages({ ...base, alive: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("выгружает самые старые при превышении лимита", () => {
    const out = evictPages({ ...base, alive: ["a", "b", "c", "d"], limit: 2 });
    expect(out).toEqual(["a", "b"]);
  });

  it("никогда не выгружает активную страницу", () => {
    // активная — в хвосте (искусственный случай) не должна исчезнуть
    const out = evictPages({ ...base, alive: ["b", "c", "a"], active: "a", limit: 1 });
    expect(out).toContain("a");
  });

  it("не выгружает страницы с активной задачей", () => {
    const out = evictPages({ ...base, alive: ["a", "b", "c", "d"], busy: ["d"], limit: 2 });
    // "a" — активная, "d" — занята: обе остаются, вытесняются хвостовые "b"/"c".
    expect(out).toEqual(["a", "d"]);
  });

  it("выгружает простаивающие дольше idleMs", () => {
    const lastUsed = { a: base.now, b: base.now - 10 * 60_000, c: base.now - 60_000 };
    const out = evictPages({ ...base, alive: ["a", "b", "c"], lastUsed, idleMs: 5 * 60_000 });
    expect(out).toEqual(["a", "c"]);
  });

  it("простой не выгружает занятые и активную страницу", () => {
    const lastUsed = { a: base.now - 60 * 60_000, b: base.now - 60 * 60_000 };
    const out = evictPages({ ...base, alive: ["a", "b"], busy: ["b"], lastUsed, idleMs: 60_000 });
    expect(out).toEqual(["a", "b"]);
  });

  it("idleMs = 0 отключает выгрузку по времени", () => {
    const lastUsed = { a: base.now - 99 * 60_000, b: base.now - 99 * 60_000 };
    expect(evictPages({ ...base, alive: ["a", "b"], lastUsed, idleMs: 0 })).toEqual(["a", "b"]);
  });

  it("неизвестная история простоя считается свежей", () => {
    const out = evictPages({ ...base, alive: ["a", "b"], lastUsed: {}, idleMs: 60_000 });
    expect(out).toEqual(["a", "b"]);
  });

  it("лимит не может стать нулевым", () => {
    const out = evictPages({ ...base, alive: ["a", "b", "c"], limit: 0 });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]).toBe("a");
  });
});
