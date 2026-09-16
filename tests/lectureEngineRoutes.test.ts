import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Роуты настройки движка /api/lecture/engine/* — на РЕАЛЬНОМ express.
 *
 * Что здесь ловится (регрессы, которые не видно в юнит-тестах модуля):
 *  • все действия обязаны отдавать ОДИН И ТОТ ЖЕ объект setupInfo(): панель
 *    настроек после каждого клика перезаписывает состояние целиком, и частичный
 *    ответ стёр бы каталог моделей/прогресс скачивания;
 *  • ошибки приходят с КОДОМ (unknown_model, build_not_installed, …) — панель
 *    переводит их через i18n.lecture.setup.err*, а не показывает стек;
 *  • «выбрать» нескачанную модель/сборку нельзя: сначала скачивание, потом
 *    активация (иначе whisper-cli запустится с несуществующим файлом);
 *  • POST /engine/gpu { mode } БЕЗ deviceId не должен сбрасывать выбранную
 *    видеокарту, иначе на машине с двумя GPU номер терялся при переключении
 *    «Видеокарта ↔ Только процессор».
 *
 * Сеть не трогаем: скачивание проверяем только на отказе (неизвестный id).
 * Модули грузим через createRequire — роутер и whisperEngine обязаны быть в
 * одном инстансе модуля (см. tests/proxyCoreRoutes.test.ts).
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

  it("GET /engine/setup отдаёт полное состояние для панели", async () => {
    const res = await fetch(`${base}/api/lecture/engine/setup`);
    expect(res.status).toBe(200);
    const s: any = await res.json();
    expect(s.engine).toBeTruthy();
    expect(s.engine.ready).toBe(false); // пустой storage — движка нет
    expect(s.builds[0].id).toBe("legacy"); // установленная копия идёт первой
    expect(s.builds.length).toBeGreaterThanOrEqual(5);
    expect(s.models.length).toBeGreaterThanOrEqual(6);
    expect(s.task.state).toBe("idle");
    expect(s.dirs.whisper.startsWith(storage)).toBe(true);
    // Детект GPU отработал: панель получает готовый объект, а не pending.
    expect(typeof s.gpu.cudaCapable).toBe("boolean");
    expect(s.gpu.pending).toBeUndefined();
  });

  it("POST /engine/gpu: режим сохраняется, номер карты не сбрасывается", async () => {
    const off = await post("/gpu", { mode: "off" });
    expect(off.status).toBe(200);
    expect(off.body.engine.gpu).toBe("off");

    const gpu1 = await post("/gpu", { mode: "auto", deviceId: 1 });
    expect(gpu1.body.engine.gpu).toBe("auto");
    expect(gpu1.body.engine.deviceId).toBe(1);

    // Кнопка «Только процессор» не несёт deviceId — выбор карты обязан остаться.
    const off2 = await post("/gpu", { mode: "off" });
    expect(off2.body.engine.gpu).toBe("off");
    expect(off2.body.engine.deviceId).toBe(1);

    // Назад в авто — карта та же, состояние читается из настроек, а не из кэша.
    const back = await post("/gpu", { mode: "auto" });
    expect(back.body.engine.gpu).toBe("auto");
    expect(back.body.engine.deviceId).toBe(1);

    const fresh = await fetch(`${base}/api/lecture/engine/setup`).then((r) => r.json());
    expect((fresh as any).engine.deviceId).toBe(1);
  });

  it("POST /engine/model: ошибки по кодам, без «тихой» активации", async () => {
    const notDownloaded = await post("/model", { id: "large-v3" });
    expect(notDownloaded.status).toBe(400);
    expect(notDownloaded.body.error).toBe("model_not_downloaded");

    for (const body of [
      { id: "nope" },
      { id: "nope", action: "download" },
      { id: "nope", action: "remove" },
    ]) {
      const bad = await post("/model", body);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("unknown_model");
    }

    // «Авто» — валидное действие: очищает выбранную модель, а не падает.
    const auto = await post("/model", { id: "" });
    expect(auto.status).toBe(200);
    expect(auto.body.engine.modelId).toBe("");
  });

  it("POST /engine/build: нескачанную сборку выбрать нельзя", async () => {
    const notInstalled = await post("/build", { id: "cuda124" });
    expect(notInstalled.status).toBe(400);
    expect(notInstalled.body.error).toBe("build_not_installed");

    const unknown = await post("/build", { id: "nope" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_build");

    const unknownDl = await post("/build", { id: "nope", action: "download" });
    expect(unknownDl.status).toBe(400);
    expect(unknownDl.body.error).toBe("unknown_build");

    // Авто-режим доступен всегда: это «выбери лучшую из установленных».
    const auto = await post("/build", { id: "auto" });
    expect(auto.status).toBe(200);
    expect(auto.body.engine.build).toBe(null); // в пустом storage ставить нечего
    expect(auto.body.builds.some((b: any) => b.id === "cuda124")).toBe(true);
  });

  it("POST /engine/bin: путь проверяется, пустая строка возвращает автопоиск", async () => {
    const missing = await post("/bin", {
      path: path.join(storage, "no-such-dir", "whisper-cli.exe"),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("bin_not_found");

    // Любой существующий файл подходит как «ручной движок» (здесь — node.exe).
    const custom = await post("/bin", { path: process.execPath });
    expect(custom.status).toBe(200);
    expect(custom.body.engine.buildCustom).toBe(true);
    expect(custom.body.engine.bin).toBe(process.execPath);
    expect(custom.body.engine.ready).toBe(false); // модели в storage нет

    const reset = await post("/bin", { path: "   " });
    expect(reset.status).toBe(200);
    expect(reset.body.engine.buildCustom).toBe(false);
    expect(reset.body.engine.bin).toBe(null);
    expect(reset.body.engine.build).toBe(null);
  });

  it("POST /engine/cancel и /engine/verify без движка отвечают предсказуемо", async () => {
    const cancel = await post("/cancel");
    expect(cancel.status).toBe(200);
    expect(cancel.body.task.state).toBe("idle"); // нечего отменять — не ошибка

    const verify = await post("/verify");
    expect(verify.status).toBe(200);
    expect(verify.body.verify.ok).toBe(false);
    expect(verify.body.verify.error).toBe("whisper_not_installed");

    // Итог self-test кэшируется в модуле: панель видит его после перезагрузки.
    const fresh: any = await fetch(`${base}/api/lecture/engine/setup`).then((r) => r.json());
    expect(fresh.verify.error).toBe("whisper_not_installed");
    expect(typeof fresh.verify.at).toBe("number");
  });
});
