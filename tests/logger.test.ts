import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "module";

/**
 * Контракт server/logger, переведённого на TS (server/ts/logger.ts →
 * server/logger.js).
 *
 * Модуль обязан остаться CommonJS: ~50 обычных .js-модулей делают
 * require("./logger") и ждут объект с методами напрямую, а не { default: ... }.
 * Тест фиксирует и эту форму экспорта, и разделение журналов: audit.log — все
 * события, app.log — только проходящие фильтры advanced.*.
 */
const req = createRequire(import.meta.url);

let logger: any;
let storage: string;

beforeAll(() => {
  // Пути журналов config вычисляет при require — уводим storage во временный каталог.
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-logger-"));
  process.env.MOONAPP_STORAGE = storage;
  logger = req("../server/logger");
});
const readApp = () =>
  fs.existsSync(logger.files.app) ? fs.readFileSync(logger.files.app, "utf8") : "";
const readAudit = () => fs.readFileSync(logger.files.audit, "utf8");

describe("server/logger — контракт CommonJS-модуля", () => {
  it("require() возвращает объект с методами уровней (а не { default })", () => {
    expect(logger.default).toBeUndefined();
    for (const method of ["debug", "info", "warn", "error", "action", "log"]) {
      expect(typeof logger[method], `logger.${method}`).toBe("function");
    }
  });

  it("пути журналов лежат в storage/logs", () => {
    expect(logger.files.audit).toBe(path.join(storage, "logs", "audit.log"));
    expect(logger.files.auditRotated).toBe(path.join(storage, "logs", "audit.1.log"));
    expect(logger.files.app).toBe(path.join(storage, "logs", "app.log"));
  });

  it("action попадает только в audit.log (телеметрия по умолчанию выключена)", () => {
    logger.action("ui.click", { page: "logger-test" });
    expect(readAudit()).toContain('"event":"ui.click"');
    expect(readApp()).not.toContain('"event":"ui.click"');
  });

  it("log() с неизвестным уровнем падает обратно на info и пишет в app.log", () => {
    logger.log("banana", "logger.unknownLevel", {});
    const app = readApp();
    expect(app).toContain('"event":"logger.unknownLevel"');
    expect(app).toContain('"level":"info"');
  });
});
