import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

// Изолируем storage: логи и отчёты пишутся во временную папку.
beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-diag-"));
  process.env.PERSONAL_APP_STORAGE = tmp;
});

const SECRET_VALUE = "sk-super-secret-value-999";

describe("diagnostics (полный журнал и файл отчёта)", () => {
  it("пишет ВСЕ события в audit.log даже при выключенной телеметрии", async () => {
    const logger = (await import("../server/logger")).default;
    logger.action("ui.click", { page: "store", text: "Собрать логи" });
    logger.error("ui.error", { message: "boom" });

    const storage = process.env.PERSONAL_APP_STORAGE!;
    const audit = fs.readFileSync(logger.files.audit, "utf8");
    expect(audit).toContain("ui.click");
    expect(audit).toContain("Собрать логи");
    expect(audit).toContain("ui.error");
    expect(audit).toContain("boom");

    // Рабочий лог фильтруется настройками (telemetry=false по умолчанию):
    // action-события в app.log не попадают, а полный журнал их сохраняет.
    const app = fs.existsSync(logger.files.app) ? fs.readFileSync(logger.files.app, "utf8") : "";
    expect(app).not.toContain('"event":"ui.click"');
    expect(audit).toContain('"event":"ui.click"');
    expect(fs.existsSync(path.join(storage, "logs"))).toBe(true);
  });

  it("собирает файл отчёта в корне storage и маскирует секреты", async () => {
    // Секрет на диске: его значение НЕ должно попасть в отчёт.
    const security = await import("../server/security");
    security.setSecret("test-provider", SECRET_VALUE);

    const logBundle = await import("../server/logBundle");
    const report = logBundle.collect();

    expect(fs.existsSync(report.file)).toBe(true);
    expect(report.size).toBeGreaterThan(0);
    expect(path.dirname(report.file)).toBe(process.env.PERSONAL_APP_STORAGE!);
    expect(path.basename(report.file).startsWith("PersonalApp-logs-")).toBe(true);

    const text = fs.readFileSync(report.file, "utf8");
    // Обязательные секции отчёта.
    expect(text).toContain("==== Окружение ====");
    expect(text).toContain("==== Настройки по страницам");
    expect(text).toContain("==== Локальные настройки интерфейса");
    expect(text).toContain("==== Настройки приложения (сырой settings.json");
    expect(text).toContain("==== Скачанные файлы (storage/downloads) ====");
    expect(text).toContain("==== Полный журнал событий: audit.log");
    // События пользователя в отчёте присутствуют.
    expect(text).toContain("ui.click");
    expect(text).toContain("Собрать логи");
    // Секреты: только имя поля, значение скрыто.
    expect(text).toContain("test-provider");
    expect(text).not.toContain(SECRET_VALUE);
  });

  it("выводит настройки каждой страницы и снимок локальных настроек UI", async () => {
    const logger = (await import("../server/logger")).default;
    const settings = await import("../server/settings");
    // Настройки конкретных страниц: значения должны попасть в отчёт.
    settings.set({ store: { pageSize: 55 }, zapret: { mode: "service" } });
    // Снимок localStorage, как его шлёт кнопка «Собрать логи».
    logger.action("ui.settings.snapshot", {
      page: "settings",
      localStorage: { tasks_progress: { "1": 40 }, "aichat.cfg.touched": ["model"] },
      keys: ["tasks_progress", "aichat.cfg.touched"],
    });

    const logBundle = await import("../server/logBundle");
    const text = fs.readFileSync(logBundle.collect().file, "utf8");

    // Группировка настроек по страницам с человекочитаемыми заголовками.
    for (const page of ["Магазин приложений", "Конвертер файлов", "Видеосжатие", "ИИ-чат", "Обход блокировок", "Монитор системы"]) {
      expect(text).toContain(page);
    }
    expect(text).toContain("[страница: store]");
    expect(text).toContain('"pageSize": 55');
    expect(text).toContain('"mode": "service"');
    // Снимок локальных настроек интерфейса.
    expect(text).toContain("tasks_progress");
    expect(text).toContain("aichat.cfg.touched");
    // Маппинг секции на страницу доступен и роуту настроек (для журнала).
    expect(logBundle.pagesForSection("store")?.title).toBe("Магазин приложений");
    expect(logBundle.pagesForSection("zapret")?.id).toBe("bypass");
    expect(logBundle.pagesForSection("unknown-section")).toBeNull();
  });
});
