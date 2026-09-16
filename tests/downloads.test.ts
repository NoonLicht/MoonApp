import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/downloads, переведённого на TS (server/ts/downloads.ts →
 * server/downloads.js).
 *
 * Это политика страницы «Магазин» поверх общего цикла загрузки: имя файла из
 * адреса, каталог назначения из настроек и — главное — запрет на запуск
 * скачанных скриптов (.bat/.cmd), иначе магазин превращается в канал
 * удалённого выполнения кода.
 */
const req = createRequire(import.meta.url);

let storage: string;
let downloads: any;
let settings: any;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-downloads-"));
  process.env.MOONAPP_STORAGE = storage;
  settings = req("../server/settings");
  downloads = req("../server/downloads");
});

describe("server/downloads — имя файла из адреса", () => {
  it("require() отдаёт методы напрямую (без { default })", () => {
    expect(downloads.default).toBeUndefined();
    expect(typeof downloads.download).toBe("function");
  });

  it("берёт basename, декодирует проценты и вычищает небезопасные символы", () => {
    expect(downloads.fileNameFromUrl("https://x.dev/setup.exe")).toBe("setup.exe");
    expect(downloads.fileNameFromUrl("https://x.dev/a%20b%20c.zip")).toBe("a_b_c.zip");
    // Для адреса-каталога имя не выдумывается: basename от "/dir/" — "dir".
    expect(downloads.fileNameFromUrl("https://x.dev/dir/")).toBe("dir");
    expect(downloads.fileNameFromUrl("https://x.dev/")).toBe("download.bin");
    expect(downloads.fileNameFromUrl("не url")).toBe("download.bin");
  });

  it("не пропускает путь-обход: слэши и ../ не остаются в имени", () => {
    const name = downloads.fileNameFromUrl("https://x.dev/../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });
});

describe("server/downloads — каталог и установщики", () => {
  it("resolveDestDir по умолчанию отдаёт storage/downloads и создаёт его", () => {
    settings.set({ store: { downloadDir: "" } });
    const dir = downloads.resolveDestDir();
    expect(dir).toBe(path.join(storage, "downloads"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("resolveDestDir уважает настройку store.downloadDir", () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), "pa-dldir-"));
    settings.set({ store: { downloadDir: custom } });
    expect(downloads.resolveDestDir()).toBe(custom);
  });

  it("ALLOWED_EXT не содержит .bat/.cmd", () => {
    expect(downloads.ALLOWED_EXT).toContain(".exe");
    expect(downloads.ALLOWED_EXT).not.toContain(".bat");
    expect(downloads.ALLOWED_EXT).not.toContain(".cmd");
    expect(downloads.ALLOWED_EXT).not.toContain(".ps1");
  });

  it("runInstaller отклоняет недопустимый тип файла", () => {
    expect(() => downloads.runInstaller(path.join(storage, "evil.bat"))).toThrow(
      /Неподдерживаемый тип файла/,
    );
  });

  it("download отклоняет не-http схемы (в т.ч. file://)", async () => {
    await expect(downloads.download("file:///C:/Windows/system32/cmd.exe")).rejects.toThrow(
      /http\/https/,
    );
  });
});
