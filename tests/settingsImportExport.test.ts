import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Экспорт и импорт ВСЕХ настроек (страница «Настройки») — на реальном express.
 *
 * Что здесь ловится:
 *  • экспорт отдаёт файл со всеми секциями settings.json (настройки всех
 *    страниц) и НЕ отдаёт ключи API, пока не попросили явно;
 *  • импорт применяет только известные ключи и НАЗЫВАЕТ то, что пропустил:
 *    молчаливый «успех» на чужом файле — худший вариант для пользователя;
 *  • ключи API импортируются лишь по флагу importSecrets и лишь известных имён
 *    (иначе файл мог бы дописать в secrets.json произвольную запись);
 *  • принимается и наш файл экспорта, и «сырой» settings.json из storage;
 *  • настройки реально записаны в storage/settings.json (не только в кэш).
 *
 * Модули грузим через createRequire — роутер и settings обязаны быть в одном
 * инстансе (см. tests/lectureEngineRoutes.test.ts).
 */
const req = createRequire(import.meta.url);

describe("Настройки: экспорт и импорт (HTTP)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";

  async function call(method: string, p: string, body?: unknown) {
    const res = await fetch(`${base}/api/settings${p}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* не-JSON в ответе — ниже проверим статус */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const security = () => req("../server/security");

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-settings-io-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = req("express");
    const router = req("../server/routes/settings");
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/settings", router);
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
      req("../server/fsUtil").removePath(storage);
    } catch {
      /* noop */
    }
  });

  it("экспорт отдаёт файл со всеми секциями настроек и локальными настройками UI", async () => {
    const r = await call("POST", "/export", { ui: { "aichat.cfg.v2": '{"temperature":0.3}' } });
    expect(r.status).toBe(200);
    // Имя файла — ASCII, иначе Node отклоняет заголовок Content-Disposition.
    expect(r.headers.get("content-disposition")).toMatch(
      /attachment; filename="moonapp-settings-\d{4}-\d{2}-\d{2}\.json"/,
    );

    const p = r.body;
    expect(p.kind).toBe("moonapp-settings");
    expect(p.app).toBe("MoonApp");
    // Секции разных страниц: внешний вид, ИИ-чат, лекции, сжатие, обход.
    expect(p.settings.appearance.theme).toBeTruthy();
    expect(p.settings.chat.provider).toBeTruthy();
    expect(p.settings.lecture.conspectusProvider).toBe("deepseek");
    expect(p.settings.compressor.codec).toBeTruthy();
    expect(p.settings.zapret.mode).toBeTruthy();
    // Локальные настройки страниц (localStorage) переносятся блоком ui.
    expect(p.ui["aichat.cfg.v2"]).toContain("0.3");
    // Ключи API не уходят из приложения без явного согласия пользователя.
    expect(p.secrets).toBeUndefined();
  });

  it("экспорт с includeSecrets отдаёт расшифрованные ключи", async () => {
    security().setSecret("deepseek", "sk-test-123");
    const r = await call("POST", "/export", { includeSecrets: true });
    expect(r.body.secrets.deepseek).toBe("sk-test-123");
  });

  it("импорт применяет известные настройки, пишет файл и сообщает о пропущенных", async () => {
    const r = await call("POST", "/import", {
      app: "MoonApp",
      kind: "moonapp-settings",
      appVersion: "0.2.0",
      settings: {
        appearance: { theme: "light", fontSize: 18 },
        chat: { temperature: 0.2 },
        notASection: { x: 1 }, // нет в DEFAULTS — неизвестная секция
        general: { language: 42 }, // чужой тип: ожидалась строка
      },
      ui: { tasks_progress: "{}" },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.appearance.theme).toBe("light");
    expect(r.body.settings.appearance.fontSize).toBe(18);
    expect(r.body.settings.chat.temperature).toBe(0.2);
    expect(r.body.applied).toBeGreaterThan(0);
    expect(r.body.skipped).toContain("notASection");
    expect(r.body.skipped).toContain("general.language");
    expect(r.body.sourceVersion).toBe("0.2.0");
    // ui возвращается клиенту: localStorage — его зона, сервер его не пишет.
    expect(r.body.ui.tasks_progress).toBe("{}");

    // Настройки сохранены НА ДИСК (проверять только кэш недостаточно).
    const onDisk = JSON.parse(fs.readFileSync(path.join(storage, "settings.json"), "utf8"));
    expect(onDisk.appearance.theme).toBe("light");
    expect(onDisk.appearance.fontSize).toBe(18);
    expect(typeof onDisk.appearance.fontSize).toBe("number");
  });

  it("ключи API: без флага не трогаем, с флагом — только известные имена", async () => {
    security().setSecret("deepseek", "sk-test-123");

    const off = await call("POST", "/import", { settings: {}, secrets: { deepseek: "sk-new" } });
    expect(off.body.keysApplied).toBe(0);
    expect(off.body.keysSkipped).toContain("deepseek");
    expect(security().getSecret("deepseek")).toBe("sk-test-123"); // не перезаписан

    const on = await call("POST", "/import", {
      settings: {},
      importSecrets: true,
      secrets: { deepseek: "sk-new", hacker: "evil" },
    });
    expect(on.body.keysApplied).toBe(1);
    expect(on.body.keysSkipped).toContain("hacker");
    expect(security().getSecret("deepseek")).toBe("sk-new");
    expect(security().hasSecret("hacker")).toBe(false); // чужие имена не пишем
  });

  it("«сырой» settings.json (без обёртки) тоже импортируется", async () => {
    const r = await call("POST", "/import", { appearance: { theme: "oled" } });
    expect(r.status).toBe(200);
    expect(r.body.settings.appearance.theme).toBe("oled");
  });

  it("мусор вместо файла настроек отклоняется с 400", async () => {
    const r = await call("POST", "/import", [1, 2, 3]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_format");
  });
});
