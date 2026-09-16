import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/security, переведённого на TS (server/ts/security.ts →
 * server/security.js).
 *
 * Модуль держится на трёх вещах, которые легко потерять при правках:
 *  1) CommonJS-форма (`require("./security")` отдаёт методы, без `default`);
 *  2) фолбэк AES-256-GCM, когда Electron safeStorage недоступен (standalone и
 *     тесты): секрет на диске лежит в формате `__aes__<iv>.<tag>.<data>`;
 *  3) ошибки дешифровки не вылетают наружу: get() возвращает null и пишет в лог.
 */
const req = createRequire(import.meta.url);

let storage: string;
let security: any;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-security-"));
  process.env.MOONAPP_STORAGE = storage;
  security = req("../server/security");
});

beforeEach(() => {
  fs.rmSync(path.join(storage, "secrets.json"), { force: true });
});

const secretsFile = (): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(storage, "secrets.json"), "utf8"));

describe("server/security — шифрование секретов", () => {
  it("require() отдаёт методы напрямую (без { default })", () => {
    expect(security.default).toBeUndefined();
    expect(typeof security.setSecret).toBe("function");
    expect(typeof security.getSecret).toBe("function");
  });

  it("секрет на диске зашифрован (AES-фолбэк вне Electron) и читается обратно", () => {
    security.setSecret("deepseek", "sk-секрет-123");
    const raw = secretsFile().deepseek;
    expect(raw.startsWith("__aes__")).toBe(true);
    expect(raw).not.toContain("sk-секрет-123");
    expect(security.getSecret("deepseek")).toBe("sk-секрет-123");
  });

  it("повторная запись того же имени перезаписывает значение (iv новый)", () => {
    security.setSecret("groq", "first");
    const iv1 = secretsFile().groq;
    security.setSecret("groq", "second");
    expect(secretsFile().groq).not.toBe(iv1);
    expect(security.getSecret("groq")).toBe("second");
  });

  it("hasSecret не расшифровывает, listSecrets отдаёт открытые значения", () => {
    expect(security.hasSecret("openai")).toBe(false);
    security.setSecret("openai", "k1");
    security.setSecret("tmdb", "k2");
    expect(security.hasSecret("openai")).toBe(true);
    expect(security.listSecrets()).toMatchObject({ openai: "k1", tmdb: "k2" });
  });

  it("битый/чужой формат не бросает наружу: get() → null", () => {
    fs.writeFileSync(
      path.join(storage, "secrets.json"),
      JSON.stringify({ x: "plain-text" }),
      "utf8",
    );
    expect(security.getSecret("x")).toBeNull();
    expect(() => security.decryptSecret("no-format")).toThrow(/unknown secret format/);
    expect(() => security.decryptSecret(42)).toThrow(/invalid secret/);
  });

  it("порядок имён для импорта настроек: провайдеры + tmdb", () => {
    const names = security.allowedSecretNames();
    expect(names).toContain("tmdb");
    expect(names.length).toBeGreaterThan(1);
  });
});
