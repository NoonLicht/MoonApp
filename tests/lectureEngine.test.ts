import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Тесты менеджера движка whisper.cpp (server/whisperEngine.js).
 *
 * Зачем: модуль появился вместе с выбором модели и счётом на видеокарте, а
 * ошибиться тут легко и незаметно:
 *   • выбор модели/сборки — это настройки, и «пустая» модель не должна тихо
 *     подставляться вместо выбранной;
 *   • флаги устройства (-ng / -dev N) уходят прямо в whisper-cli, и лишний
 *     -ng на CPU-сборке или потерянный deviceId ломают ускорение;
 *   • blackwell/CUDA-предупреждения зависят от детекта GPU, а не от железа
 *     машины с тестами — поэтому проверяем форму данных, а не факт наличия GPU.
 *
 * Сеть не трогаем: скачивание моделей и сборок проверяется только на отказе
 * (неизвестный id) — иначе тест тянул бы гигабайты с HuggingFace.
 */

beforeAll(() => {
  // Изолируем storage: config читает MOONAPP_STORAGE при require, поэтому
  // подменяем путь ДО импорта модуля (как в tests/server.test.ts).
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-whisper-"));
});

/** Импорт после подмены storage (внутри каждого теста — vitest изолирует модули). */
function engine(): Promise<any> {
  return import("../server/whisperEngine");
}

describe("whisperEngine — каталог моделей", () => {
  it("содержит весь диапазон: tiny … large-v3 и q5-кванты", async () => {
    const e = await engine();
    const ids: string[] = e.MODEL_CATALOG.map((m: any) => m.id);
    for (const id of ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]) {
      expect(ids, `нет модели ${id}`).toContain(id);
    }
    // Квантованные варианты — способ влезть в VRAM обычной видеокарты.
    expect(ids.some((id) => id.includes("q5_0"))).toBe(true);
  });

  it("у моделей уникальные id и корректные ссылки на HuggingFace", async () => {
    const e = await engine();
    const ids = e.MODEL_CATALOG.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of e.MODEL_CATALOG) {
      expect(m.url).toContain("huggingface.co");
      expect(m.url.endsWith(`/${m.file}`)).toBe(true);
      expect(m.sizeMb).toBeGreaterThan(0);
      expect(m.file.startsWith("ggml-")).toBe(true);
    }
  });

  it("до установки ничего не скачано и активной модели нет", async () => {
    const e = await engine();
    const list = e.modelsList();
    expect(list).toHaveLength(e.MODEL_CATALOG.length);
    expect(list.every((m: any) => m.downloaded === false)).toBe(true);
    expect(list.every((m: any) => m.active === false)).toBe(true);
    expect(e.setupInfo().engine.ready).toBe(false);
  });

  it("находит модель в storage и помечает её активной", async () => {
    const e = await engine();
    // Кладём «скачанный» ggml-small.bin прямо в каталог моделей.
    fs.mkdirSync(e.MODELS_DIR, { recursive: true });
    const file = path.join(e.MODELS_DIR, "ggml-small.bin");
    fs.writeFileSync(file, Buffer.alloc(4096));
    expect(e.findModel()).toBe(file);
    const small = e.modelsList().find((m: any) => m.id === "small");
    expect(small.downloaded).toBe(true);
    expect(small.active).toBe(true);
    expect(e.setupInfo().engine.model).toBe(file);
    expect(e.setupInfo().engine.modelId).toBe("small");
    fs.rmSync(file, { force: true });
  });
});

describe("whisperEngine — выбор модели", () => {
  it("не даёт выбрать нескачанную модель (и не подставляет её молча)", async () => {
    const e = await engine();
    expect(() => e.selectModel("large-v3")).toThrowError(/model_not_downloaded/);
  });

  it("отвергает неизвестный id и при выборе, и при удалении", async () => {
    const e = await engine();
    expect(() => e.selectModel("gpt-5")).toThrowError(/unknown_model/);
    expect(() => e.removeModel("gpt-5")).toThrowError(/unknown_model/);
  });

  it("пустой id = авто-режим (small → base → tiny)", async () => {
    const e = await engine();
    e.selectModel("");
    const settings = require("../server/settings");
    expect(settings.get("lecture").modelId).toBe("");
    expect(settings.get("lecture").model).toBe("");
  });
});

describe("whisperEngine — сборки движка (CPU / OpenBLAS / CUDA)", () => {
  /** «Устанавливает» сборку: exe + (опционально) DLL бэкенда, как после распаковки. */
  function fakeBuild(e: any, id: string, dll?: string) {
    const dir = path.join(e.BUILDS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "whisper-cli.exe"), Buffer.alloc(8));
    if (dll) fs.writeFileSync(path.join(dir, dll), Buffer.alloc(8));
    return dir;
  }

  function wipeBuilds(e: any) {
    fs.rmSync(e.BUILDS_DIR, { recursive: true, force: true });
  }

  it("каталог содержит CPU, OpenBLAS и обе CUDA-сборки", async () => {
    const e = await engine();
    const ids = e.BUILD_CATALOG.map((b: any) => b.id);
    expect(ids).toEqual(["cpu", "blas", "cuda118", "cuda124"]);
    const cuda = e.BUILD_CATALOG.filter((b: any) => b.gpu);
    expect(cuda.map((b: any) => b.id).sort()).toEqual(["cuda118", "cuda124"]);
    for (const b of e.BUILD_CATALOG) {
      expect(b.url).toContain(`/download/${e.WHISPER_TAG}/`);
      expect(b.zipName.endsWith(".zip")).toBe(true);
    }
  });

  it("в свежем storage ни одна сборка не установлена (кроме legacy-записи)", async () => {
    const e = await engine();
    wipeBuilds(e);
    const list = e.buildsList();
    expect(list[0].id).toBe("legacy");
    expect(list[0].legacy).toBe(true);
    expect(list.every((b: any) => b.installed === false)).toBe(true);
    expect(e.activeBuild()).toBe(null);
    expect(e.findBuild("cuda124").id).toBe("cuda124");
    expect(e.findBuild("nope")).toBe(null);
  });

  it("активная сборка: CUDA при GPU auto, CPU-сборка при gpu=off и авто-выборе", async () => {
    const e = await engine();
    fakeBuild(e, "cuda124", "ggml-cuda.dll");
    fakeBuild(e, "blas", "ggml-blas.dll");

    // Явный выбор сборки + авто-устройство → считаем на видеокарте.
    e.setGpuMode("auto");
    e.selectBuild("cuda124");
    expect(e.activeBuild().id).toBe("cuda124");
    expect(e.engineSummary().backend).toBe("cuda");

    // «Только процессор»: явно выбранную сборку НЕ подменяем — карта просто не
    // задействуется (deviceArgs → -ng). Иначе переключение тумблера молча
    // меняло бы выбор пользователя в списке сборок.
    e.setGpuMode("off");
    expect(e.activeBuild().id).toBe("cuda124");
    expect(e.deviceArgs()).toEqual(["-ng"]);

    // А вот авто-выбор при выключенном GPU уводит на CPU-сборку (OpenBLAS):
    // незачем тащить CUDA-бинарник с более медленным CPU-бэкендом.
    e.selectBuild("auto");
    expect(e.activeBuild().id).toBe("blas");
    e.setGpuMode("auto");
    expect(e.activeBuild().id).toBe("cuda124");
    wipeBuilds(e);
  });

  it("не даёт выбрать неизвестную и неустановленную сборку", async () => {
    const e = await engine();
    wipeBuilds(e);
    expect(() => e.selectBuild("vulkan")).toThrowError(/unknown_build/);
    expect(() => e.selectBuild("cuda124")).toThrowError(/build_not_installed/);
    expect(() => e.installBuild("vulkan")).toThrowError(/unknown_build/);
    e.selectBuild("auto");
    const settings = require("../server/settings");
    expect(settings.get("lecture").build).toBe("auto");
  });

  it("ручной путь к whisper-cli: проверяет существование файла", async () => {
    const e = await engine();
    expect(() => e.setCustomBin("C:\\nope\\whisper-cli.exe")).toThrowError(/bin_not_found/);
    const dir = path.join(e.BUILDS_DIR, "custom");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, "whisper-cli.exe");
    fs.writeFileSync(exe, Buffer.alloc(8));
    fs.writeFileSync(path.join(dir, "ggml-cuda.dll"), Buffer.alloc(8));
    e.setCustomBin(exe);
    const active = e.activeBuild();
    expect(active.custom).toBe(true);
    expect(active.backend).toBe("cuda");
    expect(e.findBin()).toBe(exe);
    e.setCustomBin(""); // назад к автопоиску сборок
    expect(e.engineSummary().buildCustom).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("whisperEngine — устройство счёта и флаги whisper-cli", () => {
  function fakeCuda(e: any) {
    const dir = path.join(e.BUILDS_DIR, "cuda124");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "whisper-cli.exe"), Buffer.alloc(8));
    fs.writeFileSync(path.join(dir, "ggml-cuda.dll"), Buffer.alloc(8));
  }

  it("CPU-сборка не получает ни -ng, ни -dev", async () => {
    const e = await engine();
    fs.rmSync(e.BUILDS_DIR, { recursive: true, force: true });
    const cpuDir = path.join(e.BUILDS_DIR, "cpu");
    fs.mkdirSync(cpuDir, { recursive: true });
    fs.writeFileSync(path.join(cpuDir, "whisper-cli.exe"), Buffer.alloc(8));
    e.setGpuMode("auto");
    e.selectBuild("cpu");
    expect(e.deviceArgs()).toEqual([]);
  });

  it("CUDA-сборка: -ng при «только процессор», -dev N для выбранной карты", async () => {
    const e = await engine();
    fakeCuda(e);
    const settings = require("../server/settings");
    e.selectBuild("cuda124");
    e.setGpuMode("auto", 0);
    expect(e.deviceArgs()).toEqual([]); // карта 0 — дефолт CUDA, флаг не нужен
    e.setGpuMode("auto", 1);
    expect(e.deviceArgs()).toEqual(["-dev", "1"]);
    e.setGpuMode("off");
    expect(e.deviceArgs()).toEqual(["-ng"]);
    // Номер карты не должен сбрасываться переключением «только процессор».
    expect(settings.get("lecture").deviceId).toBe(1);
    e.setGpuMode("auto");
    fs.rmSync(e.BUILDS_DIR, { recursive: true, force: true });
  });

  it("CUDA-сборка без карты NVIDIA считает на процессоре (-ng), а не падает", async () => {
    const e = await engine();
    const cuda = { id: "cuda124", backend: "cuda" };
    // Детект нашёл только AMD/Intel: раньше в этом случае whisper запускался с
    // CUDA-сборкой без карты и падал («no CUDA devices»), хотя на процессоре
    // та же сборка считает нормально.
    expect(e.deviceArgsFor(cuda, { cudaCapable: false }, false, 0)).toEqual(["-ng"]);
    // Карта есть — считаем на ней.
    expect(e.deviceArgsFor(cuda, { cudaCapable: true }, false, 0)).toEqual([]);
    expect(e.deviceArgsFor(cuda, { cudaCapable: true }, false, 2)).toEqual(["-dev", "2"]);
    // «Только процессор» — тоже -ng.
    expect(e.deviceArgsFor(cuda, { cudaCapable: true }, true, 0)).toEqual(["-ng"]);
    // Детект ещё не выполнялся — не вмешиваемся в выбор пользователя.
    expect(e.deviceArgsFor(cuda, null, false, 0)).toEqual([]);
    // CPU-сборка флагов не получает вообще.
    expect(e.deviceArgsFor({ id: "cpu", backend: "cpu" }, { cudaCapable: true }, false, 1)).toEqual(
      [],
    );
  });

  it("transcribeArgs: модель, язык, потоки, prompt и SRT-тайминги; без -nt", async () => {
    const e = await engine();
    const args: string[] = e.transcribeArgs("m.bin", "a.wav", "out");
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    expect(val("-m")).toBe("m.bin");
    expect(val("-f")).toBe("a.wav");
    expect(val("-l")).toBe("ru");
    expect(val("-of")).toBe("out");
    expect(args).toContain("-osrt");
    // -nt запрещён: он ломает тайминги -osrt (один фиктивный сегмент).
    expect(args).not.toContain("-nt");
    const threads = Number(val("-t"));
    expect(threads).toBeGreaterThanOrEqual(1);
    expect(threads).toBeLessThanOrEqual(16);
    expect(val("--prompt").length).toBeGreaterThan(10);
  });

  it("setupInfo отдаёт всё, что нужно панели настроек", async () => {
    const e = await engine();
    const info = e.setupInfo();
    expect(info.engine).toBeTruthy();
    expect(info.models).toHaveLength(e.MODEL_CATALOG.length);
    expect(info.builds[0].id).toBe("legacy");
    expect(info.dirs.whisper).toBeTruthy();
    expect(info.dirs.models).toBeTruthy();
    expect(info.tag).toBe(e.WHISPER_TAG);
    expect(info.task.state).toBe("idle");
    expect(["auto", "off"]).toContain(info.engine.gpu);
    // Детект GPU ещё не выполнялся — панель получает pending, а не пустой объект.
    expect(info.gpu.pending === true || typeof info.gpu.cudaCapable === "boolean").toBe(true);
  });

  it("self-test без движка не падает, а объясняет причину", async () => {
    const e = await engine();
    fs.rmSync(e.BUILDS_DIR, { recursive: true, force: true });
    e.setCustomBin("");
    const res = await e.verify();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("whisper_not_installed");
    expect(e.verifyResult()).toEqual(res);
  });
});

/**
 * Подсказки «лучше для вашего ПК».
 *
 * Зачем: раньше список моделей был безликим, и на слабый ноутбук качали
 * large-v3, где расшифровка идёт медленнее реального времени. Проверяем
 * ПРАВИЛА, а не железо тестовой машины: объект системы подставляем сами.
 */
describe("whisperEngine — подсказки «ваш ПК»", () => {
  /** Слабый ноутбук: 6 ядер, 16 ГБ, без NVIDIA (реальный кейс пользователя). */
  const weak = {
    cpu: "AMD Ryzen 5 220",
    cores: 6,
    threads: 12,
    ramMb: 16384,
    gpuName: "",
    gpuMemoryMb: 0,
    gpuVendor: "",
    cuda: false,
    blackwell: false,
    detected: true,
  };
  const strong = { ...weak, cpu: "AMD Ryzen 9 7950X", cores: 16, threads: 32, ramMb: 65536 };
  const rtx = {
    ...weak,
    cuda: true,
    gpuName: "NVIDIA GeForce RTX 4060",
    gpuVendor: "nvidia",
    gpuMemoryMb: 8192,
  };

  it("best: слабый процессор → small, сильный → точнее, RTX → турбо", async () => {
    const e = await engine();
    expect(e.bestModelId(weak)).toBe("small");
    expect(e.bestModelId(strong)).toBe("large-v3-turbo-q5_0");
    expect(e.bestModelId(rtx)).toBe("large-v3-turbo");
  });

  it("модель, которой не хватает памяти, помечается unfit с причиной ram", async () => {
    const e = await engine();
    const large = { id: "large-v3", sizeMb: 2952 };
    const small = { ...weak, ramMb: 4096 };
    const rec = e.modelRecommend(large, small);
    expect(rec.level).toBe("unfit");
    expect(rec.reason).toBe("ram");
    expect(rec.gb).toBeGreaterThan(1);
  });

  it("на CUDA нехватку считаем по видеопамяти, а не по ОЗУ", async () => {
    const e = await engine();
    const large = { id: "large-v3", sizeMb: 2952 };
    // 4 ГБ VRAM хватает ОЗУ-бюджету, но не видеопамяти.
    const rec = e.modelRecommend(large, { ...rtx, gpuMemoryMb: 4096 });
    expect(rec.level).toBe("unfit");
    expect(rec.reason).toBe("vram");
  });

  it("рекомендованная модель помечена best, слишком тяжёлые — heavy", async () => {
    const e = await engine();
    const best = e.modelRecommend({ id: "small", sizeMb: 466 }, weak);
    expect(best.level).toBe("best");
    expect(best.best).toBe(true);
    // large-v3 на 16 ГБ ОЗУ влезает по памяти, но считать будет медленнее речи.
    const heavy = e.modelRecommend({ id: "large-v3", sizeMb: 2952 }, weak);
    expect(heavy.level).toBe("heavy");
    expect(heavy.reason).toBe("cpu_weak");
  });

  it("сборки: без NVIDIA — OpenBLAS, CUDA помечается как неподходящая", async () => {
    const e = await engine();
    expect(e.buildRecommend({ id: "blas" }, weak)).toMatchObject({ level: "best", best: true });
    expect(e.buildRecommend({ id: "cuda124" }, weak)).toMatchObject({
      level: "unfit",
      reason: "no_gpu",
    });
    // С NVIDIA картина обратная: CUDA — лучшая, OpenBLAS — запасной вариант.
    expect(e.buildRecommend({ id: "cuda124" }, rtx)).toMatchObject({ level: "best", best: true });
    expect(e.buildRecommend({ id: "blas" }, rtx)).toMatchObject({
      level: "good",
      reason: "cpu_fallback",
    });
    expect(e.buildRecommend({ id: "cpu" }, weak)).toMatchObject({
      level: "good",
      reason: "cpu_slow",
    });
  });

  it("detectSystem описывает реальную машину (ядра, ОЗУ, GPU)", async () => {
    const e = await engine();
    const sys = e.detectSystem();
    expect(sys.cores).toBeGreaterThan(0);
    expect(sys.cores).toBeLessThanOrEqual(sys.threads);
    expect(sys.ramMb).toBeGreaterThan(1024);
    expect(typeof sys.cuda).toBe("boolean");
  });

  it("setupInfo отдаёт и сводку «ваш ПК», и подсказку для каждого элемента", async () => {
    const e = await engine();
    const info = e.setupInfo();
    expect(info.system).toBeTruthy();
    expect(info.system.cores).toBeGreaterThan(0);
    expect(info.system.ramGb).toBeGreaterThan(0);
    // Подсказка есть у каждой модели и сборки — панель не считает её сама.
    for (const m of info.models) {
      expect(["best", "good", "heavy", "unfit"]).toContain(m.recommend.level);
    }
    for (const b of info.builds) {
      expect(["best", "good", "heavy", "unfit"]).toContain(b.recommend.level);
    }
    // Ровно одна модель и максимум одна сборка помечены «лучше для вашего ПК».
    expect(info.models.filter((m: any) => m.recommend.best)).toHaveLength(1);
    expect(info.builds.filter((b: any) => b.recommend.best).length).toBeLessThanOrEqual(1);
  });
});
