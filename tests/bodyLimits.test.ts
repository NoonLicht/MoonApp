import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/** Лимиты тела запроса (server/ts/bodyLimits.ts -> server/bodyLimits.js). */
const req = createRequire(import.meta.url);
const m = (): any => req("../server/bodyLimits");

describe("bodyLimits", () => {
  it("по умолчанию 2 МБ", () => {
    expect(m().jsonLimitFor("/api/chat")).toBe("2mb");
  });

  it("доски получают большой лимит раньше общего myspace", () => {
    expect(m().jsonLimitFor("/api/myspace/holst")).toBe("40mb");
    expect(m().jsonLimitFor("/api/myspace/notes")).toBe("16mb");
  });

  it("префикс не цепляет похожие пути", () => {
    expect(m().jsonLimitFor("/api/budgetx")).toBe("2mb");
    expect(m().jsonLimitFor("/api/budget/import")).toBe("16mb");
  });

  it("статус берётся из ошибки body-parser, иначе 500", () => {
    expect(m().statusOf({ status: 413 })).toBe(413);
    expect(m().statusOf({ statusCode: 400 })).toBe(400);
    expect(m().statusOf(new Error("x"))).toBe(500);
    expect(m().statusOf(null)).toBe(500);
  });

  it("сообщения для слишком большого и битого тела понятные", () => {
    expect(m().publicMessage({ type: "entity.too.large", limit: 2097152 })).toContain("2 МБ");
    expect(m().publicMessage({ type: "entity.parse.failed" })).toContain("JSON");
    expect(m().publicMessage(new Error("boom"))).toBe("boom");
  });
});
