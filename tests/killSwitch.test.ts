import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const req = createRequire(import.meta.url);
const engine: typeof import("../server/killSwitch") = req("../server/killSwitch");

/**
 * Реальные (не мок) проверки того, что НЕ требует прав администратора:
 * чтение статуса firewall-правила через код выхода netsh (см. killSwitch.ts —
 * критично не парсить текст, который зависит от локали Windows). Add/delete
 * правила требуют UAC (server/ts/elevate.ts, Start-Process -Verb RunAs) и не
 * могут быть кликнуты автоматически в этой сессии — этот путь проверен только
 * ревью кода и повторным использованием уже проверенного в проекте elevate.ts.
 */
describe("server/killSwitch — статус без прав администратора", () => {
  it("status() возвращает форму без падений; armed по умолчанию false", async () => {
    const s = await engine.status();
    expect(s.armed).toBe(false);
    expect(typeof s.blocking).toBe("boolean");
    expect(typeof s.proxyRunning).toBe("boolean");
    expect(typeof s.error).toBe("string");
  });

  it("blocking=false на чистой машине (правило MoonApp-KillSwitch-Block не установлено)", async () => {
    const s = await engine.status();
    expect(s.blocking).toBe(false);
  });

  it("startupCleanup() не падает, даже если правила нет (идемпотентно)", async () => {
    await expect(engine.startupCleanup()).resolves.toBeUndefined();
  });

  it("disarm() без предварительного arm() не падает и возвращает ok (нечего снимать)", async () => {
    const r = await engine.disarm();
    expect(r.ok).toBe(true);
  });
});
