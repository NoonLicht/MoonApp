import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/** Дубликаты, забытые файлы и группировка похожих картинок (server/ts/fileInsights.ts). */
const req = createRequire(import.meta.url);
let fi: any;
let dir: string;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fi-"));
  fi = req("../server/fileInsights");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fi-data-"));
  fs.mkdirSync(path.join(dir, "sub"));
  const big = Buffer.alloc(200 * 1024, 7);
  fs.writeFileSync(path.join(dir, "a.bin"), big);
  fs.writeFileSync(path.join(dir, "sub", "copy-of-a.bin"), big);
  // тот же размер и та же «голова», но разный хвост — не дубликат
  const tail = Buffer.from(big);
  tail[tail.length - 1] = 9;
  fs.writeFileSync(path.join(dir, "almost.bin"), tail);
  fs.writeFileSync(path.join(dir, "small1.txt"), "привет");
  fs.writeFileSync(path.join(dir, "sub", "small2.txt"), "привет");
  fs.writeFileSync(path.join(dir, "unique.txt"), "другое!");
});

describe("дубликаты", () => {
  it("находит полные копии и не путает файлы с разным хвостом", async () => {
    const files = await fi.walkFiles([dir]);
    const groups = await fi.findDuplicateGroups(files);
    const names = groups.map((g: any) => g.files.map((f: string) => path.basename(f)).sort());
    expect(names).toContainEqual(["a.bin", "copy-of-a.bin"]);
    expect(names).toContainEqual(["small1.txt", "small2.txt"]);
    expect(names.flat()).not.toContain("almost.bin");
    expect(names.flat()).not.toContain("unique.txt");
    expect(groups[0].wasted).toBe(200 * 1024);
  });

  it("minSize отсекает мелкие файлы при обходе", async () => {
    const files = await fi.walkFiles([dir], { minSize: 100 * 1024 });
    expect(files.every((f: any) => f.size >= 100 * 1024)).toBe(true);
  });
});

describe("забытые файлы", () => {
  it("берёт крупные и давно не тронутые, сортирует по размеру", () => {
    const now = Date.UTC(2026, 0, 1);
    const day = 86_400_000;
    const list = fi.forgottenFiles(
      [
        { path: "old-big", size: 900, atimeMs: now - 400 * day, mtimeMs: now - 500 * day },
        { path: "old-small", size: 10, atimeMs: now - 400 * day, mtimeMs: now - 400 * day },
        { path: "fresh-big", size: 1000, atimeMs: now - 2 * day, mtimeMs: now - 300 * day },
        { path: "old-bigger", size: 950, atimeMs: now - 200 * day, mtimeMs: now - 200 * day },
      ],
      { minSize: 100, olderThanDays: 180, now },
    );
    expect(list.map((f: any) => f.path)).toEqual(["old-bigger", "old-big"]);
    expect(list[0].idleDays).toBe(200);
  });
});

describe("похожие изображения", () => {
  it("hamming считает различающиеся биты", () => {
    expect(fi.hamming("ff", "ff")).toBe(0);
    expect(fi.hamming("f0", "0f")).toBe(8);
    expect(fi.hamming("ff", "fff")).toBe(Infinity);
    expect(fi.hamming("zz", "ff")).toBe(Infinity);
  });

  it("объединяет близкие хэши транзитивно, далёкие оставляет отдельно", () => {
    const g = fi.groupSimilar(
      [
        { path: "a", hash: "ffff0000ffff0000" },
        { path: "b", hash: "ffff0000ffff0001" }, // 1 бит от a
        { path: "c", hash: "ffff0000ffff0003" }, // 1 бит от b, 2 от a
        { path: "z", hash: "0000ffff0000ffff" }, // совсем другая
      ],
      4,
    );
    expect(g).toHaveLength(1);
    expect(g[0].files).toEqual(["a", "b", "c"]);
    expect(g[0].maxDistance).toBe(2);
  });

  it("isImage различает по расширению без учёта регистра", () => {
    expect(fi.isImage("C:\\x\\Photo.JPG")).toBe(true);
    expect(fi.isImage("notes.md")).toBe(false);
  });
});

describe("фоновая задача", () => {
  it("доходит до done и отдаёт группы дубликатов", async () => {
    const id = fi.startInsight("duplicates", [dir], { minSize: 1 });
    let j = fi.getInsight(id);
    for (let i = 0; i < 100 && j.stage !== "done" && j.stage !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      j = fi.getInsight(id);
    }
    expect(j.stage).toBe("done");
    expect(j.duplicates.length).toBeGreaterThanOrEqual(2);
  });
});
