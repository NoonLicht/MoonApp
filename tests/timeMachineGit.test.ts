import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Реальный git: снимок vault → дерево коммита → текст файла из прошлого.
 * Хранилище временное (MOONAPP_STORAGE), как в других интеграционных тестах.
 */
const req = createRequire(import.meta.url);
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "tm-git-"));
let git: any;
let notesDir = "";

beforeAll(() => {
  process.env.MOONAPP_STORAGE = storage;
  git = req("../server/notesGit");
  notesDir = path.join(storage, "vault", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
});

describe("снимки заметок для Машины времени", () => {
  it("делает локальные коммиты без удалённого репозитория и читает прошлую версию", async () => {
    fs.writeFileSync(path.join(notesDir, "План.md"), "версия 1", "utf8");
    const a = await git.snapshot("первый");
    expect(a.committed).toBe(true);

    // без изменений — нового коммита нет
    expect((await git.snapshot("пустой")).committed).toBe(false);

    fs.writeFileSync(path.join(notesDir, "План.md"), "версия 2, дополнено", "utf8");
    fs.writeFileSync(path.join(notesDir, "Новая.md"), "позже", "utf8");
    const b = await git.snapshot("второй");
    expect(b.committed).toBe(true);

    const files1 = await git.listTreeFiles(a.oid);
    const files2 = await git.listTreeFiles(b.oid);
    expect([...files1].filter((f: string) => f.startsWith("notes/"))).toEqual(["notes/План.md"]);
    expect(files2.has("notes/Новая.md")).toBe(true);

    expect(await git.readTextAt(a.oid, "notes/План.md")).toBe("версия 1");
    expect(await git.readTextAt(b.oid, "notes/План.md")).toBe("версия 2, дополнено");
    expect(await git.readTextAt(a.oid, "notes/Новая.md")).toBeNull();
  });
});
