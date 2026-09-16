import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "module";

/**
 * Контракт server/config, переведённого на TS (server/ts/config.ts →
 * server/config.js).
 *
 * Тридцать обычных .js-модулей делают `const { DIRS, FILES } = require("./config")`,
 * поэтому модуль обязан остаться CommonJS (без { default: ... }) и продолжать
 * создавать каталоги хранилища прямо при require: на этом держится и dev-старт,
 * и упакованная сборка (путь приходит из electron/storagePath.js).
 */
const req = createRequire(import.meta.url);

let cfg: any;
let storage: string;

beforeAll(() => {
  // config читает MOONAPP_STORAGE при require — уводим хранилище во временный каталог.
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-config-"));
  process.env.MOONAPP_STORAGE = storage;
  cfg = req("../server/config");
});
describe("server/config — пути хранилища", () => {
  it("require() отдаёт объект с DIRS/FILES/PORT (а не { default })", () => {
    expect(cfg.default).toBeUndefined();
    expect(cfg.PORT).toBe(4000);
    expect(typeof cfg.DIRS).toBe("object");
    expect(typeof cfg.FILES).toBe("object");
  });

  it("все каталоги DIRS созданы на диске и лежат внутри storage", () => {
    const dirs = Object.entries(cfg.DIRS) as [string, string][];
    expect(dirs.length).toBeGreaterThan(20);
    for (const [name, dir] of dirs) {
      expect(dir.startsWith(storage), `${name} вне storage: ${dir}`).toBe(true);
      expect(fs.statSync(dir).isDirectory(), `${name} — не каталог`).toBe(true);
    }
  });

  it("файлы FILES лежат в корне storage, а рабочий лог — в logs", () => {
    expect(path.dirname(cfg.FILES.data)).toBe(storage);
    expect(path.dirname(cfg.FILES.settings)).toBe(storage);
    expect(path.dirname(cfg.FILES.secrets)).toBe(storage);
    expect(cfg.FILES.log).toBe(path.join(storage, "logs", "app.log"));
  });

  it("каталоги кэшей движков создаются сразу, а не при первой установке", () => {
    for (const key of ["ffmpeg", "ytdlp", "singbox", "torrents", "convertIn", "convertOut"]) {
      expect(fs.existsSync(cfg.DIRS[key]), key).toBe(true);
    }
  });
});
