import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Выбор версии llama.cpp: теги и варианты CUDA проверяются строго, потому что
 * попадают в URL скачивания. Сеть не трогаем.
 */
const require = createRequire(import.meta.url);

describe("llama.cpp — версия сборки", () => {
  let engine: any;
  beforeAll(() => {
    process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-llver-"));
    engine = require("../server/llamacpp/engine");
  });

  it("isTag принимает только bNNNN", () => {
    expect(engine.isTag("b11476")).toBe(true);
    expect(engine.isTag("b999")).toBe(true);
    for (const bad of ["", "11476", "b", "b1", "b11476/../x", "latest", "b11476 ", null, 5]) {
      expect(engine.isTag(bad), String(bad)).toBe(false);
    }
  });

  it("isCudaVer — только 13.4 и 12.4", () => {
    expect(engine.isCudaVer("13.4")).toBe(true);
    expect(engine.isCudaVer("12.4")).toBe(true);
    expect(engine.isCudaVer("11.8")).toBe(false);
    expect(engine.isCudaVer("")).toBe(false);
  });

  it("installBuild отклоняет неверный тег без сетевых запросов", () => {
    const r = engine.installBuild("cpu", "../../evil");
    expect(r.ok).toBe(false);
    expect(r.error === "bad_tag" || r.error === "unsupported_platform").toBe(true);
  });

  it("installedInfo пуст для не установленной сборки", () => {
    expect(engine.installedInfo("vulkan")).toBe(null);
  });
});
