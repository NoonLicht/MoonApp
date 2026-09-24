import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/musicPlaylists");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-musicplaylists-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/musicPlaylists");
});

describe("server/musicPlaylists — сохранённые поисковые запросы", () => {
  it("create/list/remove работают", () => {
    const created = engine.create("Chill", "lofi hip hop");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Chill");

    const list1 = engine.list();
    expect(list1).toHaveLength(1);

    expect(engine.remove(created.id)).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it("без имени подставляется сам запрос", () => {
    const created = engine.create("", "synthwave mix");
    expect(created.name).toBe("synthwave mix");
    engine.remove(created.id);
  });
});
