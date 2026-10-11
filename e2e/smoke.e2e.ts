import { test, expect } from "@playwright/test";
import { launchApp, type Launched } from "./launch";

let ctx: Launched;

test.beforeAll(async () => {
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx?.close();
});

test("приложение стартует и рисует интерфейс", async () => {
  await expect(ctx.page).toHaveTitle(/MoonApp/);
  // корневой элемент React наполнился
  await expect(ctx.page.locator("#root > *").first()).toBeVisible({ timeout: 30_000 });
});

test("локальный API отвечает окну", async () => {
  const ok = await ctx.page.evaluate(async () => {
    // токен окно получает по IPC, поэтому ходим тем же клиентом, что и интерфейс
    const r = await fetch("/api/health").catch(() => null);
    return r ? r.status : 0;
  });
  // 200 — API доступен без токена в окне; 401 — токен обязателен (тоже признак живого сервера)
  expect([200, 401]).toContain(ok);
});

/** Запрос к локальному API из окна приложения с токеном (как делает интерфейс). */
async function api(method: string, url: string, body?: unknown) {
  return ctx.page.evaluate(
    async ([m, u, b]) => {
      const token = window.appBridge?.getToken?.() ?? "";
      const r = await fetch(u as string, {
        method: m as string,
        headers: { "Content-Type": "application/json", "x-moonapp-token": token },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url, body] as const,
  );
}

test("бэкап: создать, проверить по манифесту, восстановить", async () => {
  const created = await api("POST", "/api/backup");
  expect(created.status).toBe(201);
  const list = await api("GET", "/api/backup");
  const id = (list.json as { id?: string }[]).find((b) => b.id)?.id;
  expect(id).toBeTruthy();
  const verify = await api("GET", `/api/backup/${id}/verify`);
  expect(verify.status).toBe(200);
  expect(verify.json.hasManifest).toBe(true);
  expect(verify.json.ok).toBe(true);
  const restored = await api("POST", `/api/backup/${id}/restore`);
  expect(restored.status).toBe(200);
  expect(restored.json.ok).toBe(true);
});

test("бюджет: операция добавляется и видна в списке", async () => {
  const add = await api("POST", "/api/budget/transactions", {
    type: "expense",
    amount: 123,
    category: "Еда",
    note: "e2e",
    currency: "RUB",
  });
  expect(add.status).toBe(201);
  const list = await api("GET", "/api/budget/transactions");
  expect((list.json as { note?: string }[]).some((t) => t.note === "e2e")).toBe(true);
  await api("DELETE", `/api/budget/transactions/${add.json.id}`);
});

test("дерево заметок отвечает", async () => {
  const r = await api("GET", "/api/myspace/tree");
  expect(r.status).toBe(200);
});
