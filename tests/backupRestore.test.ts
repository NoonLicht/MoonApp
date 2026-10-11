import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Манифест, проверка и восстановление бэкапов (server/ts/backupManifest.ts, backup.ts).
 * Главное, что фиксируем: бэкап ловит порчу, восстановление возвращает файлы,
 * перед ним снимается страховочная копия, а «..» в идентификаторе не проходит.
 */
const req = createRequire(import.meta.url);

let storage: string;
let backup: any;
let manifest: any;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-restore-"));
  process.env.MOONAPP_STORAGE = storage;
  fs.mkdirSync(path.join(storage, "vault", "notes"), { recursive: true });
  fs.mkdirSync(path.join(storage, "diary"), { recursive: true });
  fs.writeFileSync(path.join(storage, "vault", "notes", "заметка.md"), "первая версия");
  fs.writeFileSync(path.join(storage, "diary", "2026-01-01.md"), "день");
  backup = req("../server/backup");
  manifest = req("../server/backupManifest");
});

const nameOf = (dir: string) => path.basename(dir);

describe("бэкап: манифест и проверка", () => {
  it("кладёт файловые хранилища и манифест с хэшами", () => {
    const dir = backup.createBackup("t1");
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const paths = m.files.map((f: any) => f.path);
    expect(paths).toContain("files/vault/notes/заметка.md");
    expect(paths).toContain("files/diary/2026-01-01.md");
    expect(paths).toContain("data.db");
    expect(manifest.verifyBackup(dir).ok).toBe(true);
  });

  it("обнаруживает испорченный и пропавший файл", () => {
    const dir = backup.createBackup("t2");
    fs.writeFileSync(path.join(dir, "files", "diary", "2026-01-01.md"), "подмена");
    fs.unlinkSync(path.join(dir, "files", "vault", "notes", "заметка.md"));
    const v = manifest.verifyBackup(dir);
    expect(v.ok).toBe(false);
    expect(v.corrupted).toContain("files/diary/2026-01-01.md");
    expect(v.missing).toContain("files/vault/notes/заметка.md");
  });

  it("бэкап без манифеста (старый формат) помечается, а не считается целым", () => {
    const dir = backup.createBackup("t3");
    fs.rmSync(path.join(dir, "manifest.json"));
    const v = manifest.verifyBackup(dir);
    expect(v.hasManifest).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("list отдаёт id каталога", () => {
    backup.createBackup("t4");
    expect(backup.list().every((b: any) => typeof b.id === "string")).toBe(true);
  });
});

describe("бэкап: восстановление", () => {
  it("возвращает изменённый файл и снимает страховочный бэкап", () => {
    const dir = backup.createBackup("before-change");
    const id = nameOf(dir);
    const note = path.join(storage, "vault", "notes", "заметка.md");
    fs.writeFileSync(note, "испорчено");

    const res = backup.restore(id);
    expect(fs.readFileSync(note, "utf8")).toBe("первая версия");
    expect(res.restoredFiles).toBeGreaterThan(0);
    expect(res.dbPending).toBe(true);
    // страховочная копия содержит «испорченное» состояние
    const safety = backup.list().find((b: any) => b.trigger === "pre-restore");
    expect(safety).toBeTruthy();
    expect(fs.existsSync(path.join(storage, "data.db.restore"))).toBe(true);
  });

  it("не восстанавливает из повреждённого бэкапа", () => {
    const dir = backup.createBackup("bad");
    fs.writeFileSync(path.join(dir, "files", "diary", "2026-01-01.md"), "подмена");
    expect(() => backup.restore(nameOf(dir))).toThrow(/corrupted/);
  });

  it("отвергает идентификаторы с «..» и несуществующие", () => {
    expect(() => backup.verify("..")).toThrow(/bad_id/);
    expect(() => backup.verify("../x")).toThrow(/bad_id/);
    expect(() => backup.verify("nope-123")).toThrow(/not_found/);
  });

  it("applyPendingDbRestore подменяет БД и оставляет старую копию", () => {
    const db = path.join(storage, "x.db");
    fs.writeFileSync(db, "старая");
    fs.writeFileSync(`${db}.restore`, "новая");
    expect(manifest.applyPendingDbRestore(db)).toBe(true);
    expect(fs.readFileSync(db, "utf8")).toBe("новая");
    expect(fs.readFileSync(`${db}.before-restore`, "utf8")).toBe("старая");
    expect(manifest.applyPendingDbRestore(db)).toBe(false);
  });
});
