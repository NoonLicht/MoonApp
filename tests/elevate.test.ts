import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/elevate, переведённого на TS (server/ts/elevate.ts →
 * server/elevate.js).
 *
 * Запуск с UAC — единственный путь к winws.exe и службе zapret, поэтому
 * проверяем экранирование аргументов (через него в PowerShell попадают пути
 * из настроек: кавычка в пути сломала бы всю команду) и форму модуля. Сам
 * spawn powershell в тестах не запускаем — UAC-диалог интерактивен.
 */
const req = createRequire(import.meta.url);

let elevate: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-elevate-"));
  elevate = req("../server/elevate");
});

describe("server/elevate — экранирование и форма модуля", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(elevate.default).toBeUndefined();
    expect(typeof elevate.runElevated).toBe("function");
    expect(typeof elevate.psQuote).toBe("function");
  });

  it("psQuote оборачивает в одинарные кавычки", () => {
    expect(elevate.psQuote("C:\\zapret\\winws.exe")).toBe("'C:\\zapret\\winws.exe'");
  });

  it("одинарная кавычка внутри аргумента удваивается (иначе обрыв строки в PS)", () => {
    expect(elevate.psQuote("it's ok")).toBe("'it''s ok'");
    expect(elevate.psQuote("C:\\O'Brien\\a.bat")).toBe("'C:\\O''Brien\\a.bat'");
  });

  it("не-строки приводятся к строке (числа, undefined)", () => {
    expect(elevate.psQuote(42)).toBe("'42'");
    expect(elevate.psQuote(undefined)).toBe("'undefined'");
  });

  it("runElevated возвращает промис и не бросает синхронно на пустом exe", () => {
    const p = elevate.runElevated("", [], { wait: false, softTimeoutMs: 1 });
    expect(typeof p.then).toBe("function");
    return p.then((r: any) => {
      // Мягкий таймаут срабатывает раньше реального запуска → pending.
      expect(r).toMatchObject({ ok: true, pending: true, exitCode: null, pid: null });
    });
  });
});
