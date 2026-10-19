import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Whisper GGUF (server/asrGguf.ts): каталог, выбор модели, потоки CPU.
 * Сеть не трогаем: скачивание проверяется только на отказе (неизвестный id).
 */
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-asr-"));
});

function asr(): Promise<any> {
  return import("../server/asrGguf");
}

describe("asrGguf — каталог моделей", () => {
  it("Base/Small/Medium/Large в четырёх квантах, по умолчанию Q4_K_M", async () => {
    const a = await asr();
    const info = a.info();
    expect(info.defaultQuant).toBe("Q4_K_M");
    const families = new Set(info.models.map((m: any) => m.family));
    for (const f of ["whisper-base", "whisper-small", "whisper-medium", "whisper-large-v3"]) {
      expect(families.has(f), f).toBe(true);
    }
    for (const f of families) {
      const quants = info.models.filter((m: any) => m.family === f).map((m: any) => m.quant);
      expect(quants).toEqual(["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"]);
    }
    // Q4 — самый лёгкий: размер растёт вместе с квантом.
    const small = info.models.filter((m: any) => m.family === "whisper-small");
    expect(small[0].sizeMb).toBeLessThan(small[3].sizeMb);
    expect(info.models.filter((m: any) => m.isDefault).every((m: any) => m.quant === "Q4_K_M")).toBe(
      true,
    );
  });

  it("в чистом storage ничего не скачано и задача пуста", async () => {
    const a = await asr();
    const info = a.info();
    expect(info.installed).toBe(false);
    expect(info.activeModel).toBe("");
    expect(info.task.state).toBe("idle");
    expect(info.models.every((m: any) => !m.downloaded && !m.active)).toBe(true);
    expect(info.dir.startsWith(process.env.MOONAPP_STORAGE as string)).toBe(true);
  });

  it("неизвестные и нескачанные модели отклоняются кодами", async () => {
    const a = await asr();
    expect(() => a.download("whisper-nope-Q4_K_M.gguf")).toThrow("unknown_model");
    expect(() => a.remove("../evil.gguf")).toThrow("unknown_model");
    expect(() => a.selectModel("nope")).toThrow("unknown_model");
    expect(() => a.selectModel("whisper-small-Q4_K_M.gguf")).toThrow("model_not_downloaded");
  });

  it("режим GPU сохраняется и читается обратно", async () => {
    const a = await asr();
    a.setGpuMode("off");
    expect(a.gpuMode()).toBe("off");
    a.setGpuMode("auto");
    expect(a.gpuMode()).toBe("auto");
    a.setGpuMode("что-то");
    expect(a.gpuMode()).toBe("auto");
  });
});

describe("потоки CPU (0 = все)", () => {
  const root = path.resolve(__dirname, "..");

  it("0 и пустое значение означают «все потоки процессора»", async () => {
    const e = await import("../server/cpuThreads");
    const all = e.cpuThreadCount();
    expect(all).toBeGreaterThanOrEqual(1);
    expect(e.resolveThreads(0)).toBe(all);
    expect(e.resolveThreads(undefined)).toBe(all);
    expect(e.resolveThreads("мусор")).toBe(all);
    expect(e.resolveThreads(8)).toBe(8);
    expect(e.resolveThreads(9999)).toBe(256);
  });

  it("диаризация берёт потоки из общего модуля, дефолт настроек — 0", () => {
    const diarize = fs.readFileSync(path.join(root, "server", "ts", "diarize.ts"), "utf8");
    expect(diarize).toContain('import { resolveThreads } from "./cpuThreads";');
    const settings = fs.readFileSync(path.join(root, "server", "ts", "settings.ts"), "utf8");
    expect(settings).toMatch(/language: "ru",[\s\S]{0,220}?threads: 0,/);
  });
});
