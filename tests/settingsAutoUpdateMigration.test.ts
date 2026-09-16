import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Обновления обязательны (0.2.2) — разовая миграция general.autoUpdate.
 *
 * Зачем тест: у части установок автообновление было ВЫКЛЮЧЕНО, а с 0.2.2 проверка
 * идёт при каждом запуске и скачанное обновление нельзя отложить. Поэтому при
 * первом запуске новой версии ключ приводится к true и ставится маркер
 * autoUpdateMigrated — иначе выключенное значение вернулось бы после перезапуска
 * или перезаписи настроек. Второй тест фиксирует обратное: если маркер уже стоит,
 * значение НЕ переписывается (пользователь мог отредактировать файл руками).
 *
 * Модуль грузим через createRequire и сбрасываем его кэш: settings держит
 * состояние в памяти, а нам нужен «чистый запуск» приложения дважды.
 */
const req = createRequire(import.meta.url);

describe("Миграция автообновления (settings.load)", () => {
  let storage = "";
  const settingsFile = () => path.join(storage, "settings.json");

  /** Свежий require модуля настроек — имитация нового запуска приложения. */
  function freshSettings(): any {
    try {
      delete req.cache[req.resolve("../server/settings")];
    } catch {
      /* не критично */
    }
    return req("../server/settings");
  }

  beforeAll(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-upd-mig-"));
    process.env.MOONAPP_STORAGE = storage;
  });

  afterAll(() => {
    try {
      req("../server/fsUtil").removePath(storage);
    } catch {
      /* noop */
    }
  });

  it("включает автообновление у старой установки и пишет это на диск", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        general: { autoUpdate: false, language: "ru" },
      }),
      "utf8",
    );

    const got = freshSettings().get();

    expect(got.general.autoUpdate).toBe(true);
    expect(got.general.autoUpdateMigrated).toBe(true);
    // Настройки живут не только в кэше: файл перезаписан (маркер + значение).
    const onDisk = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(onDisk.general.autoUpdate).toBe(true);
    expect(onDisk.general.autoUpdateMigrated).toBe(true);
    // Остальные ключи не потерялись.
    expect(onDisk.general.language).toBe("ru");
  });

  it("не трогает значение, если маркер миграции уже стоит", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        general: { autoUpdate: false, autoUpdateMigrated: true },
      }),
      "utf8",
    );

    const got = freshSettings().get();
    expect(got.general.autoUpdate).toBe(false);
  });
});
