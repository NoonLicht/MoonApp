import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Маршрутизатор локальных моделей: каталог, выбор модели под задачу, лимиты. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-llama-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let models: any;
let router: any;
let engine: any;

function fake(name: string, mb: number): void {
  const dir = path.join(STORAGE, "models", "llama");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, "");
  fs.truncateSync(f, mb * 1048576);
}

beforeAll(() => {
  engine = req("../server/llamacpp/engine");
  models = req("../server/llamacpp/models");
  router = req("../server/llamacpp/router");
  fake("Qwen3.5-0.8B-Q4_K_M.gguf", 500);
  fake("Qwen3.5-4B-Q4_K_M.gguf", 2600);
  fake("Qwen3.5-4B.mmproj-F16.gguf", 640);
  fake("embeddinggemma-2-Q8_0.gguf", 300);
  fake("translategemma-4b-it-Q4_K_M.gguf", 2400);
  fake("Qwen3.5-2B-Q4_K_M.gguf", 1200);
});

describe("каталог моделей", () => {
  it("id уникальны, у каждой строки есть группа, название и размер", () => {
    const ids = models.CATALOG.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of models.CATALOG) {
      expect(m.group && m.title && m.sizeMb > 0).toBeTruthy();
    }
  });

  it("проекторы разных семейств не делят одно имя на диске", () => {
    const byName = new Map<string, string>();
    for (const m of models.CATALOG)
      for (const e of m.extra ?? []) {
        const local = e.as ?? e.file;
        const owner = byName.get(local);
        expect(owner === undefined || owner === m.group).toBe(true);
        byName.set(local, m.group);
      }
    expect(byName.has("mmproj-F16.gguf")).toBe(false);
  });

  it("добавлены Qwen3.5 0.8B/2B/4B, Gemma 4 E2B и Qwen3-VL 2B без Q6/Q8", () => {
    const groups = new Set(models.CATALOG.map((m: any) => m.group));
    for (const g of ["qwen35-08b", "qwen35-2b", "qwen35-4b", "gemma4-e2b", "qwen3vl-2b-instruct"])
      expect(groups.has(g)).toBe(true);
    const q = models.CATALOG.filter((m: any) => m.group === "qwen35-4b").map((m: any) => m.note);
    expect(q).toEqual(["q3km", "q4km", "q5km"]);
    const emb = models.CATALOG.filter((m: any) => m.group === "embeddinggemma2").map(
      (m: any) => m.note,
    );
    expect(emb).toEqual(["q4", "q5", "q6", "q8"]);
  });

  it("проектор рядом с моделью находится по имени семейства", () => {
    expect(models.siblingMmproj("Qwen3.5-4B-Q4_K_M.gguf")).toBe("Qwen3.5-4B.mmproj-F16.gguf");
    expect(models.siblingMmproj("Qwen3.5-2B-Q4_K_M.gguf")).toBeNull();
  });
});

describe("маршрутизатор", () => {
  it("MoE-модели распознаются по имени", () => {
    expect(engine.isMoeFile("gemma-4-26B-A4B-it-UD-Q4_K_M.gguf")).toBe(true);
    expect(engine.isMoeFile("Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf")).toBe(true);
    expect(engine.isMoeFile("Qwen3.5-4B-Q4_K_M.gguf")).toBe(false);
    for (const f of [
      "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
      "SmallThinker-21BA3B-Instruct.Q4_K_M.gguf",
      "ERNIE-4.5-21B-A3B-PT-Q4_K_M.gguf",
      "GLM-4.7-Flash-Q4_K_M.gguf",
      "gpt-oss-20b-Q4_K_M.gguf",
    ])
      expect(engine.isMoeFile(f)).toBe(true);
    for (const f of [
      "gemma-4-E4B-it-Q4_K_M.gguf",
      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
      "translategemma-4b-it-Q4_K_M.gguf",
    ])
      expect(engine.isMoeFile(f)).toBe(false);
  });

  it("для команд берётся самая крупная чат-модель, без эмбеддингов и переводчика", () => {
    expect(router.pickModel("command")).toBe("Qwen3.5-4B-Q4_K_M.gguf");
    expect(router.pickModel("summary")).toBe("Qwen3.5-4B-Q4_K_M.gguf");
  });

  it("перевод идёт через TranslateGemma, явный выбор и модель по умолчанию главнее", () => {
    expect(router.pickModel("translate")).toBe("translategemma-4b-it-Q4_K_M.gguf");
    expect(router.pickModel("command", "Qwen3.5-0.8B-Q4_K_M.gguf")).toBe(
      "Qwen3.5-0.8B-Q4_K_M.gguf",
    );
    expect(router.pickModel("command", "auto")).toBe("Qwen3.5-4B-Q4_K_M.gguf");
    router.setRouterSettings({ defaultModel: "Qwen3.5-2B-Q4_K_M.gguf" });
    expect(router.pickModel("command")).toBe("Qwen3.5-2B-Q4_K_M.gguf");
    router.setRouterSettings({ defaultModel: "" });
  });

  it("для картинок выбирается модель, у которой скачан проектор", () => {
    const r = router.resolve("command", "", true);
    expect(r.file).toBe("Qwen3.5-4B-Q4_K_M.gguf");
    expect(r.mmproj).toMatch(/Qwen3\.5-4B\.mmproj-F16\.gguf$/);
  });

  it("лимит моделей: свой из настроек или автоматический", () => {
    router.setRouterSettings({ maxLoaded: 3 });
    expect(router.effectiveLimit()).toBe(3);
    router.setRouterSettings({ maxLoaded: 0 });
    expect(router.effectiveLimit()).toBeGreaterThanOrEqual(1);
  });

  it("удаление последней модели семейства убирает и проектор", () => {
    models.removeModel("Qwen3.5-4B-Q4_K_M.gguf");
    expect(models.installed().some((m: any) => /mmproj/i.test(m.file))).toBe(false);
  });
});

describe("размещение модели по логу llama.cpp", () => {
  const log = [
    "0.01.147 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 5060 Ti) (0000:05:00.0) - 7120 MiB free",
    "0.01.632 I load_tensors: offloaded 36/36 layers to GPU",
    "0.01.632 I load_tensors:   CPU_Mapped model buffer size =  1756.00 MiB",
    "0.01.632 I load_tensors:      Vulkan0 model buffer size =  1407.73 MiB",
    "0.02.370 I llama_kv_cache:    Vulkan0 KV buffer size =    48.00 MiB",
    "0.00.869 I common_params_fit_impl: will leave 5540 >= 768 MiB of free device memory, no changes needed",
  ].join("\n");

  it("слои, видеопамять и RAM разбираются из лога", () => {
    const p = engine.parsePlacement(log, { gpu: true, file: "gemma-4-E2B-it-Q4_K_M.gguf" });
    expect(p).toMatchObject({ layersGpu: 36, layersTotal: 36, gpuMb: 1408, cpuMb: 1756, kvGpuMb: 48 });
    expect(p.device).toBe("NVIDIA GeForce RTX 5060 Ti");
    expect(p.mode).toBe("gpu-full");
    expect(p.fit).toMatch(/will leave/);
  });

  it("MoE с экспертами в RAM и частичная выгрузка слоёв — «частично»; CPU-сборка — процессор", () => {
    const moe = engine.parsePlacement(
      "offloaded 49/49 layers to GPU\nCPU model buffer size = 14000.00 MiB\nCUDA0 model buffer size = 2500.00 MiB",
      { gpu: true, file: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf" },
    );
    expect(moe.mode).toBe("gpu-partial");
    expect(moe.moe).toBe(true);
    const part = engine.parsePlacement("offloaded 20/36 layers to GPU\nCUDA0 model buffer size = 3000.00 MiB", {
      gpu: true,
      file: "Qwen3.5-9B-Q4_K_M.gguf",
    });
    expect(part.mode).toBe("gpu-partial");
    expect(engine.parsePlacement("CPU_Mapped model buffer size = 900 MiB", { gpu: false, file: "x.gguf" }).mode).toBe("cpu");
  });

  it("Gemma 4 E4B есть в каталоге с проектором", () => {
    const e4 = models.CATALOG.filter((m: any) => m.group === "gemma4-e4b");
    expect(e4.map((m: any) => m.note)).toEqual(["q3km", "q4km", "q5km"]);
    expect(e4[0].extra[0].as).toBe("gemma-4-E4B-it.mmproj-F16.gguf");
  });
});
