import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/** Плагины-наборы данных (server/ts/plugins.ts). */
const req = createRequire(import.meta.url);
let pl: any;
beforeAll(() => {
  pl = req("../server/plugins");
});

const good = {
  id: "my-pack",
  name: "Мой набор",
  version: "1.2.0",
  skills: [{ name: "Редактор", description: "правит текст", prompt: "Ты редактор." }],
  templates: [{ id: "daily", title: "День", body: "# {{date}}" }],
};

describe("validateManifest", () => {
  it("принимает корректный манифест", () => {
    const p = pl.validateManifest(good);
    expect(p.id).toBe("my-pack");
    expect(p.skills[0].name).toBe("Редактор");
    expect(p.templates[0].id).toBe("daily");
  });

  it("отвергает плохие идентификаторы, пустые и неверные записи", () => {
    expect(() => pl.validateManifest(null)).toThrow("manifest_not_object");
    expect(() => pl.validateManifest({ ...good, id: "../x" })).toThrow("bad_id");
    expect(() => pl.validateManifest({ ...good, name: "" })).toThrow("name_required");
    expect(() => pl.validateManifest({ ...good, skills: [{ name: "x" }] })).toThrow("bad_skill");
    expect(() => pl.validateManifest({ ...good, skills: [], templates: [] })).toThrow("empty_plugin");
    expect(() =>
      pl.validateManifest({ ...good, templates: [good.templates[0], good.templates[0]] }),
    ).toThrow("bad_template");
  });

  it("лишние поля (в том числе код) отбрасываются", () => {
    const p = pl.validateManifest({ ...good, run: "require('child_process')", skills: [{ ...good.skills[0], exec: "x" }] });
    expect(p.run).toBeUndefined();
    expect(p.skills[0].exec).toBeUndefined();
  });
});

describe("хранение", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plg-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("установка, список, сбор и удаление", () => {
    pl.installPlugin(dir, good);
    pl.installPlugin(dir, { ...good, id: "other", name: "Другой" });
    const list = pl.listPlugins(dir);
    expect(list.map((p: any) => p.name)).toEqual(["Другой", "Мой набор"]);
    const c = pl.collect(list);
    expect(c.skills.length).toBe(2);
    expect(c.templates[0].id).toMatch(/^plugin:/);
    expect(pl.removePlugin(dir, "my-pack")).toBe(true);
    expect(pl.removePlugin(dir, "my-pack")).toBe(false);
    expect(pl.removePlugin(dir, "../x")).toBe(false);
  });

  it("повреждённый файл не ломает список", () => {
    fs.writeFileSync(path.join(dir, "bad.json"), "{не json");
    pl.installPlugin(dir, good);
    expect(pl.listPlugins(dir).length).toBe(1);
  });
});
