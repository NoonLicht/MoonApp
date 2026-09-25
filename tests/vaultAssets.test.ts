import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-vaultassets-"));
process.env.MOONAPP_STORAGE = storage;

const req = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vaultAssets: any = req("../server/vaultAssets");

// Минимальный валидный PNG (1x1 прозрачный пиксель).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("server/vaultAssets — сохранение картинок, вставленных в заметки", () => {
  it("сохраняет картинку и находит её обратно по id", () => {
    const { id, ext } = vaultAssets.saveAsset(PNG_1x1, "screenshot.png", "image/png");
    expect(id).toMatch(/^[a-f0-9]{20}$/);
    expect(ext).toBe(".png");

    const found = vaultAssets.findAsset(id);
    expect(found).not.toBeNull();
    expect(found.mime).toBe("image/png");
    expect(fs.existsSync(found.path)).toBe(true);
    expect(fs.readFileSync(found.path)).toEqual(PNG_1x1);
  });

  it("определяет расширение по mime, если у файла нет знакомого расширения", () => {
    const { ext } = vaultAssets.saveAsset(PNG_1x1, "blob", "image/jpeg");
    expect(ext).toBe(".jpg");
  });

  it("falls back to .png для неизвестного mime и без расширения", () => {
    const { ext } = vaultAssets.saveAsset(PNG_1x1, "pasted", "application/octet-stream");
    expect(ext).toBe(".png");
  });

  it("findAsset возвращает null для несуществующего/невалидного id", () => {
    expect(vaultAssets.findAsset("not-a-valid-id")).toBeNull();
    expect(vaultAssets.findAsset("a".repeat(20))).toBeNull();
  });

  it("файлы реально лежат внутри storage/vault/assets", () => {
    const { id, ext } = vaultAssets.saveAsset(PNG_1x1, "x.png", "image/png");
    const expected = path.join(storage, "vault", "assets", `${id}${ext}`);
    expect(fs.existsSync(expected)).toBe(true);
  });
});
