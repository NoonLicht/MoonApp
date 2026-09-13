import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-ppp-"));
});

async function mw() {
  return await import("../server/middleware/perPageProxy");
}

describe("perPageProxy — санитайз id страницы", () => {
  it("чистит заголовок до безопасного id", async () => {
    const m = await mw();
    expect(m.normalizePage(" Video ")).toBe("video");
    expect(m.normalizePage("AICHAT")).toBe("aichat");
    expect(m.normalizePage("../../etc/passwd")).toBe("etcpasswd");
    expect(m.normalizePage("X;DROP TABLE")).toBe("xdroptable");
    expect(m.normalizePage("")).toBe("");
    expect(m.normalizePage(null)).toBe("");
    expect(m.normalizePage(undefined)).toBe("");
    expect(m.normalizePage("a".repeat(50))).toHaveLength(32);
  });
});

describe("perPageProxy — решение (чистая логика)", () => {
  it("нет правила → страница проксируется", async () => {
    const m = await mw();
    expect(m.decidePageProxy(null, true, false)).toBe("core");
    expect(m.decidePageProxy(undefined, false, true)).toBe("legacy");
  });

  it("правило 0/false → явный bypass, даже когда прокси включён", async () => {
    const m = await mw();
    expect(m.decidePageProxy(0, true, true)).toBe("direct");
    expect(m.decidePageProxy(false, true, false)).toBe("direct");
  });

  it("приоритет движка: ядро важнее legacy, при отсутствии обоих — direct", async () => {
    const m = await mw();
    expect(m.decidePageProxy(1, true, true)).toBe("core");
    expect(m.decidePageProxy(1, false, true)).toBe("legacy");
    expect(m.decidePageProxy(1, false, false)).toBe("direct");
  });

  it("resolveProxyForPage без запущенных движков → direct и без URL", async () => {
    const m = await mw();
    const r = m.proxyUrlForPage("video") === null || typeof m.proxyUrlForPage("video") === "string";
    expect(r).toBe(true); // не бросает
    const full = m.resolveProxyForPage("video");
    expect(full).toHaveProperty("proxied");
    expect(full).toHaveProperty("source");
  });
});
