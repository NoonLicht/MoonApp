import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/diskScan (аналог WinDirStat): реальный обход временной
 * директории — без моков fs, чтобы проверить фактическую агрегацию размеров
 * снизу вверх и работу сворачивания большого числа детей в "… ещё N".
 */

let tmpRoot: string;
let engine: typeof import("../server/diskScan");

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-diskscan-"));
  fs.mkdirSync(path.join(tmpRoot, "sub"));
  fs.writeFileSync(path.join(tmpRoot, "a.txt"), "12345"); // 5 байт
  fs.writeFileSync(path.join(tmpRoot, "sub", "b.txt"), "1234567890"); // 10 байт

  const require = createRequire(import.meta.url);
  engine = require("../server/diskScan");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function waitDone(id: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const job = engine.getJob(id);
      if (!job) return reject(new Error("job vanished"));
      if (job.stage === "done" || job.stage === "error" || job.stage === "cancelled") {
        return resolve();
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("server/diskScan — обход и агрегация размеров", () => {
  it("суммирует размеры вложенных файлов снизу вверх", async () => {
    const { id } = engine.startScan(tmpRoot);
    await waitDone(id);
    const job = engine.getJob(id)!;
    expect(job.stage).toBe("done");
    expect(job.result).toBeTruthy();
    expect(job.result!.size).toBe(15); // 5 + 10
    expect(job.result!.fileCount).toBe(2);

    const sub = job.result!.children!.find((c) => c.name === "sub");
    expect(sub?.size).toBe(10);
    expect(sub?.isDir).toBe(true);
  });

  it("несуществующий путь не роняет job, просто даёт пустой узел", async () => {
    const { id } = engine.startScan(path.join(tmpRoot, "no-such-dir"));
    await waitDone(id);
    const job = engine.getJob(id)!;
    expect(job.stage).toBe("done");
    expect(job.result!.size).toBe(0);
  });

  it("cancelJob останавливает активное сканирование", async () => {
    const { id } = engine.startScan(tmpRoot);
    const ok = engine.cancelJob(id);
    expect(ok).toBe(true);
    await waitDone(id);
    expect(engine.getJob(id)!.stage).toBe("cancelled");
  });

  it("listRoots на Windows возвращает только реально существующие буквы дисков", async () => {
    if (process.platform !== "win32") return;
    const roots = await engine.listRoots();
    expect(Array.isArray(roots)).toBe(true);
    expect(roots.every((r) => /^[A-Z]:\\$/.test(r))).toBe(true);
  });
});
