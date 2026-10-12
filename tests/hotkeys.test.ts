import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCombo,
  formatCombo,
  eventToCombo,
  matchesCombo,
  isValidCombo,
  getCombo,
  setCombo,
  findConflict,
  HOTKEYS,
} from "../src/lib/hotkeys";

/** Редактируемые горячие клавиши (src/lib/hotkeys.ts). */
const ev = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

function fakeStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => fakeStorage());

describe("разбор и сравнение", () => {
  it("parseCombo понимает Cmd/Control как Ctrl и регистр", () => {
    expect(parseCombo("cmd+shift+k")).toEqual({ ctrl: true, alt: false, shift: true, key: "K" });
    expect(parseCombo("Alt+F5")).toEqual({ ctrl: false, alt: true, shift: false, key: "F5" });
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("Ctrl+")).toBeNull();
  });

  it("formatCombo даёт стабильный порядок модификаторов", () => {
    expect(formatCombo(parseCombo("shift+alt+ctrl+x")!)).toBe("Ctrl+Alt+Shift+X");
  });

  it("matchesCombo: Ctrl и Meta взаимозаменяемы, лишний модификатор — не совпадение", () => {
    expect(matchesCombo(ev("k", { ctrlKey: true }), "Ctrl+K")).toBe(true);
    expect(matchesCombo(ev("K", { metaKey: true }), "Ctrl+K")).toBe(true);
    expect(matchesCombo(ev("k", { ctrlKey: true, shiftKey: true }), "Ctrl+K")).toBe(false);
    expect(matchesCombo(ev("Control", { ctrlKey: true }), "Ctrl+K")).toBe(false);
  });

  it("eventToCombo пропускает одиночный модификатор", () => {
    expect(eventToCombo(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(eventToCombo(ev("s", { ctrlKey: true }))).toBe("Ctrl+S");
    expect(eventToCombo(ev(" ", { altKey: true }))).toBe("Alt+SPACE");
  });

  it("isValidCombo требует модификатор (кроме F-клавиш)", () => {
    expect(isValidCombo("K")).toBe(false);
    expect(isValidCombo("Ctrl+K")).toBe(true);
    expect(isValidCombo("F9")).toBe(true);
  });
});

describe("хранение и конфликты", () => {
  it("по умолчанию — стандартное сочетание, переопределение сохраняется и сбрасывается", () => {
    expect(getCombo("palette")).toBe("Ctrl+K");
    setCombo("palette", "Ctrl+P");
    expect(getCombo("palette")).toBe("Ctrl+P");
    setCombo("palette", null);
    expect(getCombo("palette")).toBe("Ctrl+K");
  });

  it("испорченное значение в хранилище игнорируется", () => {
    (globalThis as any).localStorage.setItem("moonapp.hotkeys", '{"palette":"+++"}');
    expect(getCombo("palette")).toBe("Ctrl+K");
    (globalThis as any).localStorage.setItem("moonapp.hotkeys", "не json");
    expect(getCombo("palette")).toBe("Ctrl+K");
  });

  it("findConflict указывает занятое действие", () => {
    expect(findConflict("chatSwitcher", "Ctrl+K")).toBe("palette");
    expect(findConflict("chatSwitcher", "Ctrl+Shift+K")).toBeNull();
    expect(HOTKEYS.length).toBeGreaterThanOrEqual(3);
  });
});
