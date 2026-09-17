import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Провайдер и модель для ИИ-оформления заметок (/api/myspace/ai/config).
 *
 * Реальная жалоба: в заметках всплывало
 * `api error 400: ... The supported API model names are deepseek-flash,
 * deepseek-v4-pro, but you passed depseek-flash` — провайдер/модель брались
 * только из настроек чата, и опечатку нельзя было исправить из страницы заметок,
 * а выбор не сохранялся.
 *
 * Теперь выбор живёт в myspace.ai.provider/model: здесь проверяем и сам обмен
 * (сохранение, «как в чате», запрет неизвестного провайдера), и то, что
 * сохранённая модель реально уходит в запрос к провайдеру.
 */
const req = createRequire(import.meta.url);
const ANSWER = "## Оформлено\n\n- пункт";

describe("ИИ-оформление заметок: выбор провайдера и модели", () => {
  let srv: any = null;
  let base = "";
  let storage = "";
  let settings: any;
  let vault: any;
  let providers: any;
  let security: any;
  let lastModel = "";
  let lastProvider = "";

  const api = async (route: string, init?: RequestInit) => {
    const res = await fetch(`${base}/api/myspace${route}`, init);
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* пустое тело */
    }
    return { status: res.status, body };
  };
  const post = (route: string, body: unknown) =>
    api(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-notescfg-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = require("express");
    settings = req("../server/settings");
    vault = req("../server/myspace-vault");
    providers = req("../server/providers");
    security = req("../server/security");
    const router = require("../server/routes/myspace");

    const realGetProvider = providers.getProvider;
    providers.getProvider = (id: string) => {
      // Неизвестный провайдер должен падать так же, как в жизни (иначе тест
      // не поймал бы «мёртвый» выбор в настройках).
      try {
        realGetProvider(id);
      } catch {
        throw new Error(`unknown provider: ${id}`);
      }
      return {
        id,
        models: ["deepseek-chat"],
        listModels: async () => ["deepseek-flash", "deepseek-v4-pro"],
        chat: async (opts: any) => {
          lastModel = String(opts.model);
          lastProvider = id;
          return ANSWER;
        },
      };
    };
    security.getSecret = (name: string) => (name === "deepseek" ? "test-key" : "");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/myspace", router);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => {
    try {
      srv?.close();
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  beforeEach(() => {
    lastModel = "";
    lastProvider = "";
    settings.set({ chat: { provider: "openai", model: "gpt-4o-mini" } });
    settings.set({ myspace: { ai: { provider: "", model: "" } } });
  });

  it("без своего выбора работает «как в чате» и показывает список провайдеров", async () => {
    const { status, body } = await api("/ai/config");
    expect(status).toBe(200);
    expect(body.providerFromChat).toBe(true);
    expect(body.providerId).toBe("openai");
    expect(body.chatProvider).toBe("openai");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.hasKey).toBe(false); // ключ сохранён только у deepseek
    const ids = body.providers.map((p: any) => p.id);
    expect(ids).toContain("deepseek");
    expect(body.providers.find((p: any) => p.id === "deepseek").hasKey).toBe(true);
  });

  it("выбор провайдера сохраняется в настройках и виден в ответе", async () => {
    const { status, body } = await post("/ai/config", { providerId: "deepseek" });
    expect(status).toBe(200);
    expect(body.providerFromChat).toBe(false);
    expect(body.providerId).toBe("deepseek");
    expect(body.hasKey).toBe(true);
    expect(settings.get("myspace").ai.provider).toBe("deepseek");
    // Ответ GET совпадает с записанным: выбор переживёт перезапуск приложения.
    const again = await api("/ai/config");
    expect(again.body.providerId).toBe("deepseek");
    expect(again.body.providerFromChat).toBe(false);
  });

  it("неизвестный провайдер отклоняется — «мёртвого» выбора в настройках не остаётся", async () => {
    const { status, body } = await post("/ai/config", { providerId: "нет-такого" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/notes_ai_provider_unknown: нет-такого/);
    expect(settings.get("myspace").ai.provider).toBe("");
  });

  it("смена провайдера обнуляет модель, а сохранённая модель уходит в запрос", async () => {
    // Смена провайдера: имя модели от прежнего сервиса почти наверняка не подойдёт.
    const switched = await post("/ai/config", { providerId: "deepseek" });
    expect(switched.body.model).toBe("");

    const saved = await post("/ai/config", { model: "deepseek-v4-pro" });
    expect(saved.status).toBe(200);
    expect(saved.body.model).toBe("deepseek-v4-pro");
    expect(settings.get("myspace").ai.model).toBe("deepseek-v4-pro");

    vault.writeFile("Заметка.md", "черновик   текста", {});
    const fmt = await post("/ai/format", { path: "Заметка.md" });
    expect(fmt.status).toBe(200);
    expect(lastProvider).toBe("deepseek");
    expect(lastModel).toBe("deepseek-v4-pro");
  });

  it("пустой провайдер возвращает «как в чате»", async () => {
    await post("/ai/config", { providerId: "deepseek", model: "deepseek-chat" });
    const back = await post("/ai/config", { providerId: "" });
    expect(back.body.providerFromChat).toBe(true);
    expect(back.body.providerId).toBe("openai");
    expect(settings.get("myspace").ai.provider).toBe("");
  });

  it("живой список моделей берётся у провайдера, ошибки — на 400", async () => {
    const ok = await api("/ai/models?provider=deepseek");
    expect(ok.status).toBe(200);
    expect(ok.body.models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);

    const unknown = await api("/ai/models?provider=нет-такого");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/notes_ai_provider_unknown/);

    // Провайдер без ключа: подсказка «добавьте ключ в Настройках».
    const noKey = await api("/ai/models?provider=openai");
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toMatch(/notes_ai_not_configured: openai/);
  });
});