import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/bookmarks (CRUD) — изолированный storage (как в
 * tests/backup.test.ts), чтобы не писать в настоящий storage/bookmarks.json
 * разработчика. Сеть (fetch для read-later) здесь не трогаем — это отдельный
 * интеграционный путь; проверяем то, что обязано работать даже без сети.
 */
const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/bookmarks");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bookmarks-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/bookmarks");
});

describe("server/bookmarks — CRUD без read-later", () => {
  it("create/list/update/remove работают и без сети (saveForLater не указан)", async () => {
    const created = await engine.create({
      url: "https://example.com/",
      title: "Example",
      tags: ["a", "b"],
    });
    expect(created.id).toBeTruthy();
    expect(created.articleNotePath).toBeNull();

    const list1 = engine.list();
    expect(list1).toHaveLength(1);
    expect(list1[0].title).toBe("Example");

    const updated = engine.update(created.id, { title: "Renamed", tags: ["c"] });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.tags).toEqual(["c"]);

    const ok = engine.remove(created.id);
    expect(ok).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it("без title подставляется url", async () => {
    const created = await engine.create({ url: "https://example.org/page" });
    expect(created.title).toBe("https://example.org/page");
  });

  it("update/remove несуществующей записи возвращает null/false", () => {
    expect(engine.update("no-such-id", { title: "x" })).toBeNull();
    expect(engine.remove("no-such-id")).toBe(false);
  });
});
