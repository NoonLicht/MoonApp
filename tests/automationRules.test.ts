import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Правила «если → то» (server/ts/automationRules.ts): цепочки над файлами. */
const req = createRequire(import.meta.url);
let ar: any;
let root: string;

const NOW = new Date(2026, 2, 14, 10, 0, 0); // 14 марта 2026

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ar-"));
  ar = req("../server/automationRules");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ar-data-"));
});

function mk(name: string, content = "данные"): string {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const step = (type: string, params: Record<string, string>) => ({ id: type, type, params });

describe("expand", () => {
  it("подставляет имя, расширение и дату; неизвестное оставляет как есть", () => {
    expect(ar.expand("{date}_{name}{ext}", "C:\\x\\Отчёт.PDF", NOW)).toBe("2026-03-14_Отчёт.PDF");
    expect(ar.expand("D:/Архив/{year}/{month}/{extnodot}", "a.PNG", NOW)).toBe("D:/Архив/2026/03/png");
    expect(ar.expand("{что}", "a.txt", NOW)).toBe("{что}");
  });
});

describe("checkCondition", () => {
  it("расширение, регулярное выражение и размер", () => {
    expect(ar.checkCondition({ ext: "jpg, .PNG" }, "a.png", 10)).toBe(true);
    expect(ar.checkCondition({ ext: "jpg" }, "a.png", 10)).toBe(false);
    expect(ar.checkCondition({ nameRegex: "^скрин" }, "Скриншот 1.png", 10)).toBe(true);
    expect(ar.checkCondition({ nameRegex: "(" }, "a.png", 10)).toBe(false);
    expect(ar.checkCondition({ minSizeMb: "1" }, "a.bin", 500_000)).toBe(false);
    expect(ar.checkCondition({ maxSizeMb: "1" }, "a.bin", 500_000)).toBe(true);
    expect(ar.checkCondition({}, "a.bin", 1)).toBe(true);
  });
});

describe("runChain", () => {
  it("если → переименовать → переместить", () => {
    const f = mk("in/photo.jpg");
    const dest = path.join(root, "out", "{year}");
    const r = ar.runChain(
      f,
      [
        step("if", { ext: "jpg,png" }),
        step("rename", { template: "{date}_{name}{ext}" }),
        step("move", { dest }),
      ],
      NOW,
    );
    expect(r.completed).toBe(true);
    expect(r.path).toBe(path.join(root, "out", "2026", "2026-03-14_photo.jpg"));
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("условие не прошло — файл остаётся на месте", () => {
    const f = mk("in/note.txt");
    const r = ar.runChain(f, [step("if", { ext: "jpg" }), step("move", { dest: path.join(root, "x") })], NOW);
    expect(r.completed).toBe(false);
    expect(r.path).toBe(f);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("копирование не затирает существующий файл, а добавляет номер", () => {
    const a = mk("src/doc.txt", "один");
    const dest = path.join(root, "copies");
    ar.runChain(a, [step("copy", { dest })], NOW);
    const second = mk("src2/doc.txt", "два");
    const r = ar.runChain(second, [step("copy", { dest })], NOW);
    expect(path.basename(r.path)).toBe("doc (2).txt");
    expect(fs.readFileSync(path.join(dest, "doc.txt"), "utf8")).toBe("один");
  });

  it("zip упаковывает файл", () => {
    const f = mk("zipme/report.txt", "x".repeat(500));
    const r = ar.runChain(f, [step("zip", { dest: path.join(root, "zips") })], NOW);
    expect(r.path).toBe(path.join(root, "zips", "report.zip"));
    expect(fs.statSync(r.path).size).toBeGreaterThan(0);
  });

  it("относительный путь назначения — ошибка, файл не тронут", () => {
    const f = mk("rel/a.txt");
    expect(() => ar.runChain(f, [step("move", { dest: "relative/dir" })], NOW)).toThrow();
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe("хранение правил", () => {
  it("saveRule чистит шаги, отклоняет относительную папку; deleteRule удаляет", () => {
    expect(() => ar.saveRule({ name: "x", folder: "rel" })).toThrow("folder_not_absolute");
    const saved = ar.saveRule({
      name: "Фото",
      folder: root,
      enabled: false,
      steps: [
        { id: "a", type: "move", params: { dest: root } },
        { id: "b", type: "rm -rf", params: {} },
      ],
    });
    expect(saved.steps.map((s: any) => s.type)).toEqual(["move"]);
    expect(ar.listRules().map((r: any) => r.id)).toContain(saved.id);
    expect(ar.deleteRule(saved.id)).toBe(true);
    expect(ar.deleteRule(saved.id)).toBe(false);
  });

  it("processFile пишет результат в журнал, ошибку — как неуспех", async () => {
    const f = mk("log/a.txt");
    const ok = await ar.processFile(
      { id: "r1", name: "Тест", enabled: true, folder: root, createdAt: 0, steps: [step("rename", { template: "b.txt" })] },
      f,
    );
    expect(ok).toMatchObject({ ok: true, completed: true });
    const bad = await ar.processFile(
      { id: "r1", name: "Тест", enabled: true, folder: root, createdAt: 0, steps: [step("move", { dest: "rel" })] },
      path.join(root, "log", "b.txt"),
    );
    expect(bad.ok).toBe(false);
    expect(ar.getRunLog()[0].ok).toBe(false);
  });
});
