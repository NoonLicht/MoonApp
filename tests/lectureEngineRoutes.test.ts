import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Роуты /api/lecture/engine/whisper — на РЕАЛЬНОМ express.
 *
 *  - все действия отдают ОДИН И ТОТ ЖЕ объект asrGguf.info(): панель после клика
 *    перезаписывает состояние целиком;
 *  - ошибки приходят КОДОМ (unknown_model, model_not_downloaded, ...) для i18n;
 *  - нескачанную модель выбрать нельзя.
 *
 * Сеть не трогаем: скачивание проверяем только на отказе (неизвестный id).
 */
const require = createRequire(import.meta.url);

describe("Lecture engine routes (/api/lecture/engine/*)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";

  /** POST с JSON-телом; возвращает { status, body }. */
  async function post(p: string, body: any = {}) {
    const res = await fetch(`${base}/api/lecture/engine${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-engine-routes-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = require("express");
    const router = require("../server/routes/lecture");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/lecture", router);
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

  it("GET /engine/whisper отдаёт каталог моделей для панели", async () => {
    const res = await fetch(`${base}/api/lecture/engine/whisper`);
    expect(res.status).toBe(200);
    const s: any = await res.json();
    expect(s.installed).toBe(false);
    expect(s.defaultQuant).toBe("Q4_K_M");
    expect(s.models.length).toBeGreaterThanOrEqual(20);
    expect(s.task.state).toBe("idle");
    expect(s.dir.startsWith(storage)).toBe(true);
  });

  it("POST gpu: режим сохраняется и приходит в ответе", async () => {
    const off = await post("/whisper", { action: "gpu", mode: "off" });
    expect(off.status).toBe(200);
    expect(off.body.gpu).toBe("off");
    const back = await post("/whisper", { action: "gpu", mode: "auto" });
    expect(back.body.gpu).toBe("auto");
  });

  it("ошибки по кодам, без тихой активации", async () => {
    const notDownloaded = await post("/whisper", {
      action: "select",
      id: "whisper-small-Q4_K_M.gguf",
    });
    expect(notDownloaded.status).toBe(400);
    expect(notDownloaded.body.error).toBe("model_not_downloaded");

    for (const body of [
      { action: "select", id: "nope" },
      { action: "download", id: "nope" },
      { action: "remove", id: "nope" },
    ]) {
      const bad = await post("/whisper", body);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("unknown_model");
    }
    const unk = await post("/whisper", { action: "что-то" });
    expect(unk.status).toBe(400);
    expect(unk.body.error).toBe("unknown_action");
  });

  it("cancel без задачи отвечает предсказуемо", async () => {
    const cancel = await post("/whisper", { action: "cancel" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.task.state).toBe("idle");
  });
});
