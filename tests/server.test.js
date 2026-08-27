import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

beforeAll(() => {
  // Изолируем storage для тестов во временной папке.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-test-"));
  process.env.PERSONAL_APP_STORAGE = tmp;
});

describe("security (шифрование ключей)", () => {
  it("шифрует ключ в файле и обратно расшифровывает", async () => {
    const sec = await import("../server/security");
    const plain = "sk-test-12345-abracadabra";
    sec.setSecret("test-provider", plain);
    expect(sec.getSecret("test-provider")).toBe(plain);
    expect(sec.hasSecret("test-provider")).toBe(true);
    expect(sec.getSecret("missing")).toBeNull();

    // На диске должен лежать зашифрованный токен (не открытый ключ).
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.PERSONAL_APP_STORAGE, "secrets.json"), "utf8"))["test-provider"];
    expect(stored).toBeTruthy();
    expect(stored.startsWith("__aes__") || stored.startsWith("__ss__")).toBe(true);
    expect(stored).not.toContain(plain);
  });
});

describe("db (SQLite)", () => {
  it("создаёт задачи и делает CRUD", async () => {
    const dbm = await import("../server/db");
    const { stmts } = dbm;
    const { lastInsertRowid } = stmts.taskInsert.run("hello task", 0, "Med", "General");
    const rows = stmts.taskAll.all();
    expect(rows.length).toBeGreaterThan(0);
    const added = rows.find((r) => r.id === lastInsertRowid);
    expect(added.text).toBe("hello task");
    stmts.taskDelete.run(lastInsertRowid);
  });
});

describe("backup", () => {
  it("создаёт бэкап и записывает файлы", async () => {
    const bk = await import("../server/backup");
    const dir = bk.createBackup("test");
    expect(dir).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "data.json"))).toBe(true);
  });
});