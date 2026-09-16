import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "module";

/**
 * Контракт server/settings, переведённого на TS (server/ts/settings.ts →
 * server/settings.js).
 *
 * Модуль обязан остаться CommonJS (без { default: ... }): ~23 .js-модуля берут
 * его объектом и вызывают settings.get(...). Отдельно фиксируем «якорные»
 * дефолты, на которые завязан остальной код: при переносе 449-строчного файла
 * значения легко потерять, а ошибка была бы тихой (фича просто вернулась бы к
 * другому поведению).
 */
const req = createRequire(import.meta.url);

let settings: any;

beforeAll(() => {
  // settings читает MOONAPP_STORAGE при require — уводим storage во временный каталог.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-settings-"));
  settings = req("../server/settings");
});

describe("server/settings — контракт модуля", () => {
  it("require() отдаёт объект с публичным API (а не { default })", () => {
    expect(settings.default).toBeUndefined();
    for (const name of ["load", "get", "set", "importAll", "sanitizePatch"]) {
      expect(typeof settings[name], `settings.${name}`).toBe("function");
    }
    expect(typeof settings.DEFAULTS).toBe("object");
  });

  it("DEFAULTS содержит секции, на которые опираются страницы", () => {
    for (const section of [
      "general",
      "appearance",
      "performance",
      "window",
      "chat",
      "store",
      "converter",
      "video",
      "music",
      "media",
      "movies",
      "myspace",
      "voice",
      "compressor",
      "sitebak",
      "monitor",
      "backup",
      "lecture",
      "zapret",
      "advanced",
    ]) {
      expect(typeof settings.DEFAULTS[section], section).toBe("object");
    }
  });

  it("якорные значения дефолтов не поехали", () => {
    const d = settings.DEFAULTS;
    expect(d.general.startPage).toBe("store");
    expect(d.advanced.logLevel).toBe("info");
    expect(d.advanced.telemetry).toBe(false);
    expect(d.monitor.refreshMs).toBe(500);
    expect(d.backup.intervalHours).toBe(24);
    expect(d.zapret.mode).toBe("service");
    expect(d.compressor.crf).toBe(23);
    expect(d.sitebak.maxConcurrent).toBe(3);
    expect(d.lecture.conspectusProvider).toBe("deepseek");
    expect(d.lecture.conspectusTrigger).toBe("smart");
    expect(d.lecture.diarizeSpeakers).toBe(-1);
  });

  it("get() отдаёт секцию из загруженного дерева", () => {
    expect(settings.get("chat").provider).toBe("openai");
    expect(settings.get()).toBe(settings.load());
  });
});
