import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** История буфера обмена (server/ts/clipboardHistory.ts). */
const req = createRequire(import.meta.url);
let ch: any;
beforeAll(() => {
  ch = req("../server/clipboardHistory");
});

const DAY = 86_400_000;

describe("фильтр секретов", () => {
  it("не запоминает карты, ключи и токены", () => {
    expect(ch.looksSensitive("4539 1488 0343 6467")).toBe(true);
    expect(ch.looksSensitive("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
    expect(ch.looksSensitive("sk-abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(ch.looksSensitive("Xk3jd92Lm0qPz81Vb7Tn5")).toBe(true);
  });

  it("обычный текст и ссылки проходят", () => {
    expect(ch.looksSensitive("Привет, мир! Это обычная заметка")).toBe(false);
    expect(ch.looksSensitive("https://example.com/path/to/page?id=12345678901234567890")).toBe(false);
    expect(ch.looksSensitive("1234 5678")).toBe(false);
  });
});

describe("addEntry", () => {
  it("добавляет новое наверх и поднимает дубликат без нового id", () => {
    let l = ch.addEntry([], "первое", 1000).list;
    l = ch.addEntry(l, "второе", 2000).list;
    const id = l.find((e: any) => e.text === "первое").id;
    const r = ch.addEntry(l, "первое", 3000);
    expect(r.added).toBe(false);
    expect(r.list.map((e: any) => e.text)).toEqual(["первое", "второе"]);
    expect(r.list[0].id).toBe(id);
    expect(r.list[0].at).toBe(3000);
  });

  it("пропускает пустое, слишком длинное и секретное", () => {
    expect(ch.addEntry([], "   ").added).toBe(false);
    expect(ch.addEntry([], "x".repeat(ch.MAX_CHARS + 1)).added).toBe(false);
    expect(ch.addEntry([], "4539 1488 0343 6467").added).toBe(false);
  });
});

describe("prune", () => {
  it("просроченные удаляются, закреплённые остаются", () => {
    const now = 100 * DAY;
    const list = [
      { id: "a", text: "старое", at: now - 10 * DAY, pinned: false },
      { id: "b", text: "старое закреплённое", at: now - 10 * DAY, pinned: true },
      { id: "c", text: "свежее", at: now - DAY, pinned: false },
    ];
    expect(ch.prune(list, now).map((e: any) => e.id)).toEqual(["b", "c"]);
  });

  it("обрезает до MAX_ITEMS, не трогая закреплённые", () => {
    const now = 10 * DAY;
    const list = Array.from({ length: ch.MAX_ITEMS + 20 }, (_v, i) => ({
      id: `i${i}`,
      text: `t${i}`,
      at: now - i,
      pinned: i === ch.MAX_ITEMS + 10,
    }));
    const out = ch.prune(list, now);
    expect(out.length).toBe(ch.MAX_ITEMS);
    expect(out.some((e: any) => e.pinned)).toBe(true);
  });
});

describe("поиск и закрепление", () => {
  const list = [
    { id: "a", text: "Alpha beta", at: 1, pinned: false },
    { id: "b", text: "gamma", at: 3, pinned: false },
    { id: "c", text: "ALPHA two", at: 2, pinned: true },
  ];
  it("ищет без учёта регистра, закреплённые первыми", () => {
    expect(ch.search(list, "alpha").map((e: any) => e.id)).toEqual(["c", "a"]);
    expect(ch.search(list, "").map((e: any) => e.id)).toEqual(["c", "b", "a"]);
  });
  it("setPinned и remove", () => {
    expect(ch.setPinned(list, "b", true).find((e: any) => e.id === "b").pinned).toBe(true);
    expect(ch.remove(list, "a").length).toBe(2);
  });
});
