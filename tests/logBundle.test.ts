import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/logBundle, переведённого на TS (server/ts/logBundle.ts →
 * server/logBundle.js).
 *
 * Содержимое самого отчёта проверяет tests/diagnostics.test.ts — здесь то, что
 * рядом с ним не покрыто: форма модуля для require(), версия приложения без
 * Electron, список отчётов и ротация (в storage не должно копиться больше 10
 * файлов, и уезжать должны самые старые).
 */
const req = createRequire(import.meta.url);

let logBundle: any;
let storage: string;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-logbundle-"));
  process.env.MOONAPP_STORAGE = storage;
  logBundle = req("../server/logBundle");
});

/** Создать фальшивый отчёт с заданным временем изменения. */
function fakeReport(name: string, ageMs: number): string {
  const file = path.join(storage, `MoonApp-logs-${name}.txt`);
  fs.writeFileSync(file, "старый отчёт\n", "utf8");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}

describe("server/logBundle — форма модуля и отчёты", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(logBundle.default).toBeUndefined();
    expect(typeof logBundle.collect).toBe("function");
    expect(typeof logBundle.listReports).toBe("function");
    expect(typeof logBundle.pagesForSection).toBe("function");
    expect(Array.isArray(logBundle.PAGE_SETTINGS)).toBe(true);
  });

  it("версия приложения без Electron берётся из package.json, а не 'unknown'", () => {
    const version = logBundle.appVersion();
    expect(version).not.toBe("unknown");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("общая секция настроек ('media') закреплена за страницей видео", () => {
    expect(logBundle.pagesForSection("media")?.id).toBe("video");
    expect(logBundle.pagesForSection("general")?.id).toBe("settings");
  });

  it("listReports сортирует отчёты от новых к старым", () => {
    const older = fakeReport("2020-01-01_00-00-00", 3 * 60 * 1000);
    const newer = fakeReport("2020-01-02_00-00-00", 1 * 60 * 1000);

    const names = logBundle.listReports().map((r: { file: string }) => r.file);
    expect(names).toContain(older);
    expect(names).toContain(newer);
    expect(names.indexOf(newer)).toBeLessThan(names.indexOf(older));
    // Размер уже посчитан — роуту настроек не нужен лишний stat.
    const entry = logBundle.listReports().find((r: { file: string }) => r.file === newer);
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ротация держит не больше 10 отчётов и убирает самые старые", () => {
    // 12 «старых» файлов + новый отчёт от collect() = должно остаться MAX_REPORTS.
    const made = Array.from({ length: 12 }, (_, i) =>
      fakeReport(`old-${String(i).padStart(2, "0")}`, (100 - i) * 60 * 1000),
    );

    const report = logBundle.collect();
    const after = logBundle.listReports();

    expect(after.length).toBe(10);
    // Самый старый файл удалён…
    expect(fs.existsSync(made[0])).toBe(false);
    // …а свежий отчёт на месте.
    expect(after.map((r: { file: string }) => r.file)).toContain(report.file);
  });
});
