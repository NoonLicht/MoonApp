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
  describe("perPageProxy — fetch без прокси", () => {
    it("pageFetch без активного движка зовёт обычный fetch и не подменяет init", async () => {
      const m = await mw();
      const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
      const orig = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch;
      try {
        const res = await m.pageFetch("https://example.com/x", { headers: { a: "b" } });
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://example.com/x");
        expect(calls[0].init?.headers).toEqual({ a: "b" });
        // dispatcher добавляется ТОЛЬКО когда страница реально проксируется.
        expect(calls[0].init && "dispatcher" in calls[0].init).toBe(false);
      } finally {
        globalThis.fetch = orig;
      }
    });

    it("getUndiciDispatcherForPage без движка не бросает", async () => {
      const m = await mw();
      expect(() => m.getUndiciDispatcherForPage("movies")).not.toThrow();
    });
  });

  describe("perPageProxy — контракт упаковки", () => {
    it("undici объявлен в dependencies (иначе в сборке проксирование молча выключится)", () => {
      // Регресс на реальный дефект: undici был только транзитивной devDependency
      // (@electron/rebuild → node-gyp), electron-builder его в app.asar не клал.
      // В dev-режиме запросы шли через прокси, в установленном приложении —
      // напрямую под DPI-блокировку: «прокси подключён, а страница фильмов пустая».
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
      );
      expect(pkg.dependencies?.undici, "undici должен быть в dependencies").toBeTruthy();
    });
  });
});
