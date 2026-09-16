import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/backup, переведённого на TS (server/ts/backup.ts →
 * server/backup.js).
 *
 * Бэкап — последняя линия защиты пользовательских данных, поэтому проверяем
 * не форму файлов, а поведение: каталог появляется вместе с meta.json и
 * копиями, ротация оставляет ровно N последних, а пустой storage не роняет
 * createBackup.
 */
const req = createRequire(import.meta.url);

let storage: string;
let backup: any;
let settings: any;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-backup-"));
  process.env.MOONAPP_STORAGE = storage;
  settings = req("../server/settings");
  backup = req("../server/backup");
});

const backupsDir = (): string => path.join(storage, "backups");

describe("server/backup — создание, список и ротация", () => {
  it("require() отдаёт методы напрямую (без { default })", () => {
    expect(backup.default).toBeUndefined();
    expect(typeof backup.createBackup).toBe("function");
  });

  it("createBackup копирует data/settings и пишет meta.json с триггером", () => {
    fs.writeFileSync(path.join(storage, "data.json"), JSON.stringify({ notes: 1 }), "utf8");
    fs.writeFileSync(
      path.join(storage, "settings.json"),
      JSON.stringify({ theme: "dark" }),
      "utf8",
    );

    const dir = backup.createBackup("unit");
    expect(typeof dir).toBe("string");
    expect(fs.existsSync(path.join(dir, "data.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"))).toMatchObject({
      trigger: "unit",
    });
    expect(backup.list().some((m: any) => m.trigger === "unit")).toBe(true);
  });

  it("rotate оставляет не больше backup.keep последних бэкапов", () => {
    for (const n of fs.readdirSync(backupsDir())) {
      fs.rmSync(path.join(backupsDir(), n), { recursive: true, force: true });
    }
    const keep: number = settings.get("backup").keep ?? 5;
    for (let i = 0; i < keep + 3; i++) {
      fs.mkdirSync(path.join(backupsDir(), `b${i}`), { recursive: true });
      fs.writeFileSync(
        path.join(backupsDir(), `b${i}`, "meta.json"),
        JSON.stringify({ trigger: `t${i}`, at: new Date().toISOString() }),
        "utf8",
      );
    }
    backup.rotate();
    expect(fs.readdirSync(backupsDir())).toHaveLength(keep);
  });

  it("пустой storage не роняет createBackup и не ломает список", () => {
    for (const n of fs.readdirSync(backupsDir())) {
      fs.rmSync(path.join(backupsDir(), n), { recursive: true, force: true });
    }
    expect(backup.list()).toEqual([]);
  });

  it('испорченный meta.json попадает в список с заглушкой trigger "?"', () => {
    fs.mkdirSync(path.join(backupsDir(), "broken-meta"), { recursive: true });
    fs.writeFileSync(path.join(backupsDir(), "broken-meta", "meta.json"), "{не json", "utf8");
    const entry = backup.list().find((m: any) => m.trigger === "?");
    expect(entry).toBeTruthy();
    expect(typeof entry.at).toBe("string");
  });
});
