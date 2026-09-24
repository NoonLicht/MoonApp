import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/games");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-games-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/games");
});

describe("server/games — CRUD библиотеки", () => {
  it("create/list/update/remove работают", () => {
    const created = engine.create({ name: "Test Game", exePath: "C:\\games\\test\\test.exe" });
    expect(created.id).toBeTruthy();
    expect(created.source).toBe("manual");

    const list1 = engine.list();
    expect(list1).toHaveLength(1);

    const updated = engine.update(created.id, { description: "cool game" });
    expect(updated?.description).toBe("cool game");

    expect(engine.remove(created.id)).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it("launch несуществующей записи/файла честно сообщает об ошибке", () => {
    expect(engine.launch("no-such-id").ok).toBe(false);
    const created = engine.create({ name: "Ghost", exePath: "C:\\nowhere\\ghost.exe" });
    const r = engine.launch(created.id);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("exe_not_found");
  });
});

describe("server/games — версионный бэкап сохранений", () => {
  it("backupSave/listSaveVersions/restoreSave делают полный цикл на реальных файлах", () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-games-save-"));
    fs.writeFileSync(path.join(saveDir, "slot1.dat"), "hello");

    const game = engine.create({ name: "SaveTest", exePath: "C:\\x\\x.exe", savePath: saveDir });
    const backup = engine.backupSave(game.id);
    expect(backup.ok).toBe(true);
    expect(backup.file).toBeTruthy();

    const versions = engine.listSaveVersions(game.id);
    expect(versions.length).toBe(1);

    // Меняем файл в "текущем" сохранении, затем восстанавливаем из бэкапа.
    fs.writeFileSync(path.join(saveDir, "slot1.dat"), "changed");
    const restore = engine.restoreSave(game.id, versions[0].file);
    expect(restore.ok).toBe(true);
    expect(fs.readFileSync(path.join(saveDir, "slot1.dat"), "utf8")).toBe("hello");
  });

  it("backupSave без savePath у записи честно отдаёт ошибку", () => {
    const game = engine.create({ name: "NoSave", exePath: "C:\\x\\x.exe" });
    const r = engine.backupSave(game.id);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_save_path");
  });
});
