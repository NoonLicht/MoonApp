import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

async function mod() {
  return await import("../electron/storagePath");
}

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Перенос данных из старого места (storage рядом с exe, версии ≤ 0.3.3) в
 * %APPDATA%\MoonApp\storage. Главное требование: существующие данные
 * пользователя не перетираются, добавляется только отсутствующее.
 */
describe("storagePath — перенос данных из старого места", () => {
  it("переносит только отсутствующие файлы и НЕ перетирает существующие", async () => {
    const m = await mod();
    const legacy = tmpDir("moon-legacy-");
    const storage = tmpDir("moon-storage-");

    // Старое место: настройки и скачанный «пак» модели.
    fs.writeFileSync(path.join(legacy, "settings.json"), JSON.stringify({ legacy: true }));
    fs.mkdirSync(path.join(legacy, "models", "realesrgan"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "models", "realesrgan", "model.onnx"), "weights");

    // Новое место: приложение уже настроено — эти данные главные.
    fs.mkdirSync(path.join(storage, "models"), { recursive: true });
    fs.writeFileSync(path.join(storage, "settings.json"), JSON.stringify({ current: true }));

    const copied = m.mergeMissing(legacy, storage);

    expect(copied).toBe(1); // скопирован только отсутствующий model.onnx
    expect(JSON.parse(fs.readFileSync(path.join(storage, "settings.json"), "utf8"))).toEqual({
      current: true,
    });
    expect(fs.readFileSync(path.join(storage, "models", "realesrgan", "model.onnx"), "utf8")).toBe(
      "weights",
    );
  });

  it("не падает, если старого места нет", async () => {
    const m = await mod();
    const storage = tmpDir("moon-storage-");
    expect(m.mergeMissing(path.join(storage, "missing"), storage)).toBe(0);
  });

  it("не роняет перенос, когда на месте каталога лежит файл", async () => {
    const m = await mod();
    const legacy = tmpDir("moon-legacy-");
    const storage = tmpDir("moon-storage-");

    fs.mkdirSync(path.join(legacy, "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "logs", "app.log"), "line");
    fs.writeFileSync(path.join(storage, "logs"), "файл вместо каталога");

    expect(() => m.mergeMissing(legacy, storage)).not.toThrow();
    expect(fs.readFileSync(path.join(storage, "logs"), "utf8")).toBe("файл вместо каталога");
  });
});
