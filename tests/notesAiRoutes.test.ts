import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Роуты ИИ-оформления заметок (server/routes/myspace.js):
 *   POST /api/myspace/ai/format      { path }
 *   POST /api/myspace/ai/regenerate  { path }
 *
 * Проверяем связку «роут ↔ notesAi ↔ vault»: результат записывается в файл
 * заметки (frontmatter не теряется), sidecar появляется/переезжает/удаляется
 * вместе с заметкой, а коды errors notes_ai_* уходят клиенту со статусом 400 —
 * страница переводит их в подсказки.
 *
 * Провайдер чата подменён заглушкой: тест не должен ни ходить в сеть, ни
 * требовать реального ключа.
 */
const req = createRequire(import.meta.url);

const ANSWER = "## Оформлено\n\n- пункт";

describe("ИИ-оформление заметок (/api/myspace/ai/*)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";
  let vault: any;
  let notesAi: any;
  let providers: any;
  let security: any;
  let fsUtil: any;
  let modelAnswer: string;

  const notesDir = (): string => path.join(storage, "vault", "notes");
  const aiDir = (): string => path.join(notesDir(), ".ai");
  const noteFile = (name: string): string => path.join(notesDir(), name);

  /** Запрос к роуту с телом JSON. */
  async function post(route: string, body: unknown) {
    const res = await fetch(`${base}/api/myspace${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* тело без JSON не должен видеть ни один сценарий, но тест не падает */
    }
    return { status: res.status, body: json };
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-notesai-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = require("express");
    const router = require("../server/routes/myspace");
    vault = req("../server/myspace-vault");
    notesAi = req("../server/notesAi");
    providers = req("../server/providers");
    security = req("../server/security");
    fsUtil = req("../server/fsUtil");
    providers.getProvider = () => ({
      id: "deepseek",
      models: ["deepseek-chat"],
      listModels: async () => ["deepseek-chat"],
      chat: async () => modelAnswer,
    });
    security.getSecret = () => "test-key";

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
    modelAnswer = ANSWER;
    for (const dir of [notesDir(), aiDir()]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      for (const entry of fs.readdirSync(dir)) fsUtil.removePath(path.join(dir, entry));
    }
  });it("«Оформить» пишет ответ модели в заметку и сохраняет frontmatter", async () => {
    vault.writeFile("Конспект.md", "черновик   текста\n\n\n без разметки", {
      title: "Конспект",
      folder: "Учёба",
    });

    const { status, body } = await post("/ai/format", { path: "Конспект.md" });
    expect(status).toBe(200);
    expect(body.content).toBe(ANSWER);
    expect(body.regenerated).toBe(false);
    expect(body.provider).toBe("deepseek");

    const saved = vault.readFile("Конспект.md");
    expect(saved.content.trim()).toBe(ANSWER);
    // frontmatter заметки на месте (роут пишет через vault.writeFile).
    expect(saved.frontmatter.title).toBe("Конспект");
    expect(saved.frontmatter.folder).toBe("Учёба");
    // «Сырой» текст сохранён для «Регенерировать».
    expect(notesAi.readSource("Конспект.md")).toBe("черновик   текста\n\n\n без разметки");
  });

  it("«Регенерировать» пересобирает текст из исходника целиком", async () => {
    vault.writeFile("Конспект.md", "исходный черновик", {});
    await post("/ai/format", { path: "Конспект.md" });

    // Пользователь правил оформленный текст — регенерация это перетирает.
    vault.writeFile("Конспект.md", "ручные правки", {});
    modelAnswer = "## Заново\n\n- из исходника";

    const { status, body } = await post("/ai/regenerate", { path: "Конспект.md" });
    expect(status).toBe(200);
    expect(body.regenerated).toBe(true);
    expect(body.rawChars).toBe("исходный черновик".length);
    expect(vault.readFile("Конспект.md").content.trim()).toBe("## Заново\n\n- из исходника");
  });

  it("«Регенерировать» без исходника — 400 notes_ai_no_source", async () => {
    vault.writeFile("Новая.md", "текст без истории", {});
    const { status, body } = await post("/ai/regenerate", { path: "Новая.md" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/notes_ai_no_source/);
    // Заметка не тронута.
    expect(vault.readFile("Новая.md").content.trim()).toBe("текст без истории");
  });

  it("без path и для несуществующей заметки — 400/404, без вызова модели", async () => {
    const noPath = await post("/ai/format", {});
    expect(noPath.status).toBe(400);
    expect(noPath.body.error).toBe("path required");

    const missing = await post("/ai/format", { path: "Нет такой.md" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not found");
  });

  it("пустую заметку оформлять нечего — 400, файл и исходник не создаются", async () => {
    vault.writeFile("Пустая.md", "   \n\n", {});
    const { status, body } = await post("/ai/format", { path: "Пустая.md" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/notes_ai_empty_note/);
    expect(notesAi.sourceInfo("Пустая.md").exists).toBe(false);
  });

  it("нет ключа провайдера — 400 с кодом для подсказки в интерфейсе", async () => {
    security.getSecret = () => "";
    try {
      vault.writeFile("Заметка.md", "черновик", {});
      const { status, body } = await post("/ai/format", { path: "Заметка.md" });
      expect(status).toBe(400);
      expect(body.error).toMatch(/notes_ai_not_configured: deepseek/);
    } finally {
      security.getSecret = () => "test-key";
    }
  });

  it("сбой модели (сеть/сервер) — 500, заметка не перезаписана", async () => {
    providers.getProvider = () => ({
      id: "deepseek",
      models: ["deepseek-chat"],
      listModels: async () => ["deepseek-chat"],
      chat: async () => {
        throw new Error("HTTP 500");
      },
    });
    try {
      vault.writeFile("Заметка.md", "черновик", {});
      const { status, body } = await post("/ai/format", { path: "Заметка.md" });
      expect(status).toBe(500);
      expect(body.error).toMatch(/HTTP 500/);
      expect(vault.readFile("Заметка.md").content.trim()).toBe("черновик");
      // Исходник при этом уже сохранён — регенерация возможна после починки ключа.
      expect(notesAi.sourceInfo("Заметка.md").exists).toBe(true);
    } finally {
      providers.getProvider = () => ({
        id: "deepseek",
        models: ["deepseek-chat"],
        listModels: async () => ["deepseek-chat"],
        chat: async () => modelAnswer,
      });
    }
  });

  it("переименование заметки переносит исходник, удаление — убирает", async () => {
    vault.writeFile("Старое.md", "черновик", {});
    await post("/ai/format", { path: "Старое.md" });
    expect(notesAi.sourceInfo("Старое.md").exists).toBe(true);

    const renamed = await fetch(`${base}/api/myspace/rename`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "Старое.md", newPath: "Новое.md" }),
    });
    expect(renamed.status).toBe(200);
    expect(notesAi.sourceInfo("Старое.md").exists).toBe(false);
    expect(notesAi.sourceInfo("Новое.md").exists).toBe(true);

    const deleted = await fetch(
      `${base}/api/myspace/file?path=${encodeURIComponent("Новое.md")}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(notesAi.sourceInfo("Новое.md").exists).toBe(false);
    expect(fs.existsSync(noteFile("Новое.md"))).toBe(false);
  });
});