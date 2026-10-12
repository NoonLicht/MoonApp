import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Voice Vault (server/ts/voiceVault.ts). */
const req = createRequire(import.meta.url);
let v: any;
beforeAll(() => {
  v = req("../server/voiceVault");
});

const chunk = (id: number, s: number, text: string) => ({ id, start_ms: s * 1000, end_ms: s * 1000 + 4000, text });

describe("отрезок вокруг момента", () => {
  const chunks = [
    chunk(1, 0, "Начнём с организационных вопросов."),
    chunk(2, 5, "Дедлайн по диплому — пятнадцатое мая."),
    chunk(3, 10, "Работу нужно сдать на кафедру."),
    chunk(4, 15, "Теперь перейдём к теме лекции."),
  ];

  it("берёт чанк момента и следующие в пределах лимита", () => {
    const s = v.segmentFor(chunks, 6000, 90);
    expect(s.chunkIds).toEqual([2, 3]);
    expect(s.startMs).toBe(5000);
    expect(s.endMs).toBe(14000);
    expect(s.text).toContain("Дедлайн");
  });

  it("момент между чанками — ближайший следующий; после конца — последний", () => {
    expect(v.segmentFor(chunks, 9000, 40).chunkIds[0]).toBe(3);
    expect(v.segmentFor(chunks, 999000, 40).chunkIds).toEqual([4]);
  });

  it("без текста отрезка нет", () => {
    expect(v.segmentFor([chunk(1, 0, "  ")], 0)).toBeNull();
    expect(v.segmentFor([], 0)).toBeNull();
  });

  it("всегда берёт хотя бы один чанк, даже длинный", () => {
    const long = [chunk(1, 0, "слово ".repeat(300))];
    expect(v.segmentFor(long, 0, 100).chunkIds).toEqual([1]);
  });
});

describe("выдержка", () => {
  it("центрируется на первом найденном слове запроса", () => {
    const text = "Вступление ".repeat(30) + "Дедлайн по диплому через неделю. " + "Продолжение ".repeat(30);
    const e = v.excerpt(text, "дедлайн диплом", 120);
    expect(e).toContain("Дедлайн по диплому");
    expect(e.startsWith("…")).toBe(true);
    expect(v.excerpt("коротко", "что-то")).toBe("коротко");
  });
});
