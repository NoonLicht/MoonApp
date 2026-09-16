import { describe, it, expect, beforeEach } from "vitest";
import { collectUiSettings, applyUiSettings } from "@/lib/uiSettings";

/**
 * Локальные настройки страниц (localStorage) — часть экспорта/импорта настроек.
 *
 * Здесь важно: снимок переносит настройки страниц КАК ЕСТЬ (сырыми строками, без
 * разбора JSON — иначе чужой формат значения мог бы испортиться), не тащит в
 * файл токены доступа и умеет писать их обратно.
 */
class FakeStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  clear() {
    this.map.clear();
  }
}

describe("uiSettings — снимок и применение настроек страниц", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
  });

  it("собирает настройки страниц и НЕ тащит токены", () => {
    localStorage.setItem("aichat.cfg.v2", '{"temperature":0.3}');
    localStorage.setItem("tasks_progress", '{"task:1":true}');
    localStorage.setItem("moonapp.token", "secret-token");

    const snap = collectUiSettings();
    expect(snap["aichat.cfg.v2"]).toBe('{"temperature":0.3}');
    expect(snap.tasks_progress).toBe('{"task:1":true}');
    expect(snap["moonapp.token"]).toBeUndefined();
  });

  it("применяет снимок обратно (round-trip) и пропускает мусор", () => {
    const n = applyUiSettings({
      "aichat.cfg.v2": '{"temperature":0.9}',
      tasks_progress: "{}",
      "moonapp.token": "другой-токен", // секреты из файла не принимаем
      broken: 42, // значение не строка
    });
    expect(n).toBe(2);
    expect(localStorage.getItem("aichat.cfg.v2")).toBe('{"temperature":0.9}');
    expect(localStorage.getItem("tasks_progress")).toBe("{}");
    expect(localStorage.getItem("moonapp.token")).toBeNull();
  });

  it("не падает на пустом или неверном блоке ui", () => {
    expect(applyUiSettings(null)).toBe(0);
    expect(applyUiSettings([])).toBe(0);
    expect(applyUiSettings("строка")).toBe(0);
  });
});
