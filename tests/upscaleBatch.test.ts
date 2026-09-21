import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Пачки апскейла и интерполятора: кто их принимает, сколько кадров копится и как
 * распределяются тайлы.
 *
 * Зачем: очередь пачек в пайплайне — главная причина «лестницы» на графике GPU
 * (залп инференса → пауза, период равен размеру пачки). Модели Real-ESRGAN в
 * ONNX-графе ждут ровно один кадр, поэтому для них пачка не просто бесполезна —
 * она держала десятки полных кадров в RAM. Здесь проверяются:
 *   • факт из каталога (`batch: 1`) и функции его интерпретации;
 *   • пределы пачки в расчётах «авто» и ручных значений;
 *   • группировка тайлов одного размера для интерполятора (в один тензор нельзя
 *     складывать тайлы разной ширины) и раскладка батча по кадрам;
 *   • контракт UI: настройки пачки нет у моделей, которые её не принимают.
 */
const req = createRequire(import.meta.url);

let up: any;
let pipe: any;
const root = path.resolve(__dirname, "..");

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-batch-"));
  up = req("../server/upscale");
  pipe = req("../server/upscalePipeline");
});

describe("каталог: факт о пачке", () => {
  it("realesrgan-модели помечены batch: 1 (пачка невозможна)", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "server", "models.manifest.json"), "utf8"),
    ) as { models: Array<{ id: string; batch?: number }>; _note?: string };
    for (const id of ["realesrgan-x2", "realesrgan-x4plus"]) {
      const m = manifest.models.find((x) => x.id === id);
      expect(m, id).toBeTruthy();
      expect(m?.batch, id).toBe(1);
    }
    // Поле описано в шапке каталога — иначе его снимут при следующей правке.
    expect(String(manifest._note || "")).toContain("batch");
  });

  it("modelBatchLimit: 1 — один вход, 0 — неизвестно, N — предел", () => {
    expect(up.modelBatchLimit({ id: "m", batch: 1 })).toBe(1);
    expect(up.modelBatchLimit({ id: "m", batch: 8 })).toBe(8);
    expect(up.modelBatchLimit({ id: "m" })).toBe(0);
    expect(up.modelBatchLimit(null)).toBe(0);
  });

  it("modelCanBatch выключен для batch=1, batchCeiling уважает предел модели", () => {
    expect(up.modelCanBatch({ id: "fixed", batch: 1 })).toBe(false);
    expect(up.modelCanBatch({ id: "dyn" })).toBe(true);
    expect(up.modelCanBatch(null)).toBe(false);
    expect(up.batchCeiling({ id: "fixed", batch: 1 })).toBe(up.BATCH_MAX);
    expect(up.batchCeiling({ id: "m", batch: 4 })).toBe(4);
    // Предел больше общего потолка не поднимает планку.
    expect(up.batchCeiling({ id: "m", batch: 9999 })).toBe(up.BATCH_MAX);
  });
});

describe("размер пачки", () => {
  it("«авто» не превышает предел модели и учитывает очередь в RAM", () => {
    const base = { w: 1920, h: 1080, scale: 4, tile: 192, freeMb: 6000, modelMb: 64 };
    const free = up.autoBatchFrames({ ...base, ramBudgetMb: 1_000_000 });
    expect(free).toBeGreaterThan(1);
    // Предел модели важнее: граф с batch=4 пачки из 64 не примет.
    expect(up.autoBatchFrames({ ...base, ramBudgetMb: 1_000_000, maxBatch: 4 })).toBe(4);
    // Двойная буферизация (две пачки в памяти) урезает авто-пачку сильнее.
    const single = up.autoBatchFrames({
      ...base,
      ramBudgetMb: 1000,
      queueBatches: 1,
    });
    const many = up.autoBatchFrames({ ...base, ramBudgetMb: 1000, queueBatches: 8 });
    expect(many).toBeLessThan(single);
  });

  it("ручное значение урезается пределом модели", () => {
    const opts = { ramBudgetMb: 1_000_000, freeMb: 6000, modelMb: 64 };
    expect(up.batchFramesFor(64, 1920, 1080, 4, opts)).toBe(64);
    expect(up.batchFramesFor(64, 1920, 1080, 4, { ...opts, maxBatch: 8 })).toBe(8);
    expect(up.batchFramesFor(64, 1920, 1080, 4, { ...opts, maxBatch: 1 })).toBe(1);
  });
});

describe("интерполятор: пачка тайлов", () => {
  it("tileGroups собирает только тайлы одного размера", () => {
    const rects = [
      { x: 0, y: 0, w: 512, h: 512 },
      { x: 480, y: 0, w: 512, h: 512 },
      { x: 900, y: 0, w: 124, h: 512 },
      { x: 0, y: 480, w: 512, h: 512 },
    ];
    const groups = up.tileGroups(rects, 2);
    expect(groups.map((g: any[]) => g.length)).toEqual([2, 1, 1]);
    // Ни в одной группе не смешаны разные размеры.
    for (const g of groups) {
      for (const r of g) expect([r.w, r.h]).toEqual([g[0].w, g[0].h]);
    }
    // Предел 1 не склеивает ничего.
    expect(up.tileGroups(rects, 1).every((g: any[]) => g.length === 1)).toBe(true);
  });

  it("пачка тайлов идёт одним run на группу и раскладывается по кадрам", async () => {
    const runs: number[] = [];
    // Заглушка сессии: запоминаем размер пачки и отдаём «кадр» по тайлам.
    const session = {
      inputNames: ["img0", "img1", "timestep"],
      outputNames: ["frame"],
      async run(feeds: Record<string, { dims: readonly number[]; data: Float32Array }>) {
        const t = feeds.img0;
        runs.push(t.dims[0]);
        const data = new Float32Array(t.dims[0] * 3 * t.dims[2] * t.dims[3]).fill(0.5);
        return { frame: { dims: [t.dims[0], 3, t.dims[2], t.dims[3]], data, dispose() {} } };
      },
    };
    const ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[],
        ) {}
      },
      InferenceSession: { create: async () => session },
    };
    const w = 128;
    const h = 128;
    // Тайл 96 с перекрытием 32 при 128×128 даёт ровно 4 квадратных тайла:
    // шаг 64 → смещения 0 и 32, размеры одинаковые (иначе их нельзя сложить в один тензор).
    const frames = await up.interpolatePair({
      prev: Buffer.alloc(w * h * 3, 10),
      cur: Buffer.alloc(w * h * 3, 20),
      w,
      h,
      p: { tile: 96, overlap: 32, provider: "cpu", threads: 0 },
      model: { id: "rife-v49", file: "x.onnx", scale: 1, tile: 96, overlap: 32 },
      sig: "rife-pair-timestep",
      ts: [0.5],
      tileBatch: 4,
      deps: { ort, ready: { session, provider: "cpu", bgr: false, scale: 1 } },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(w * h * 3);
    // Один run на всю пачку из четырёх тайлов.
    expect(runs).toEqual([4]);
  });

  it("tileBatch=1 считает тайлы по одному (модели с фиксированным batch)", async () => {
    const runs: number[] = [];
    const session = {
      inputNames: ["img0", "img1", "timestep"],
      outputNames: ["frame"],
      async run(feeds: Record<string, { dims: readonly number[] }>) {
        const t = feeds.img0;
        runs.push(t.dims[0]);
        const data = new Float32Array(3 * t.dims[2] * t.dims[3]).fill(0.25);
        return { frame: { dims: [1, 3, t.dims[2], t.dims[3]], data, dispose() {} } };
      },
    };
    const ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[],
        ) {}
      },
      InferenceSession: { create: async () => session },
    };
    await up.interpolatePair({
      prev: Buffer.alloc(128 * 128 * 3, 0),
      cur: Buffer.alloc(128 * 128 * 3, 255),
      w: 128,
      h: 128,
      p: { tile: 96, overlap: 32, provider: "cpu", threads: 0 },
      model: { id: "rife-v49", file: "x.onnx", scale: 1, tile: 96, overlap: 32 },
      sig: "rife-pair-timestep",
      ts: [0.5],
      deps: { ort, ready: { session, provider: "cpu", bgr: false, scale: 1 } },
    });
    // Четыре тайла → четыре одиночных вызова.
    expect(runs).toEqual([1, 1, 1, 1]);
  });

  it("пачка отвалилась → движок запоминает факт и доводит тайлы по одному", async () => {
    const runs: number[] = [];
    // Граф с фиксированным batch=1: пачка падает так же, как у наших экспортов.
    const session = {
      inputNames: ["img0", "img1", "timestep"],
      outputNames: ["frame"],
      async run(feeds: Record<string, { dims: readonly number[] }>) {
        const t = feeds.img0;
        runs.push(t.dims[0]);
        if (t.dims[0] > 1) {
          throw new Error(
            "Got invalid dimensions for input: img0 for the following indices index: 0 Got: 4 Expected: 1",
          );
        }
        const data = new Float32Array(3 * t.dims[2] * t.dims[3]).fill(0.25);
        return { frame: { dims: [1, 3, t.dims[2], t.dims[3]], data, dispose() {} } };
      },
    };
    const ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[],
        ) {}
      },
      InferenceSession: { create: async () => session },
    };
    const model = { id: "fallback-model", file: "x.onnx", scale: 1, tile: 96, overlap: 32 };
    expect(up.modelCanBatch(model)).toBe(true);
    const frames = await up.interpolatePair({
      prev: Buffer.alloc(128 * 128 * 3, 0),
      cur: Buffer.alloc(128 * 128 * 3, 255),
      w: 128,
      h: 128,
      p: { tile: 96, overlap: 32, provider: "cpu", threads: 0 },
      model,
      sig: "rife-pair-timestep",
      ts: [0.5],
      tileBatch: 4,
      deps: { ort, ready: { session, provider: "cpu", bgr: false, scale: 1 } },
    });
    // Первый заход — пачкой (упал), дальше все тайлы по одному: кадр всё равно готов.
    expect(runs).toEqual([4, 1, 1, 1, 1]);
    expect(frames[0].length).toBe(128 * 128 * 3);
    // Факт запомнен: следующие задания про эту модель пачку даже не попробуют.
    expect(up.modelCanBatch(model)).toBe(false);
  });
});

describe("пайплайн: двойная буферизация очереди", () => {
  it("опция queueBatches есть, очередь допускает пачку в работе + пачку в наборе", () => {
    const src: string = fs.readFileSync(
      path.join(root, "server", "ts", "upscalePipeline.ts"),
      "utf8",
    );
    expect(src).toContain("queueBatches?: number");
    expect(src).toContain("const queueMax = batch * queueBatches");
    // Кадры «в работе» учитываются при закрытии энкодера, иначе на конце файла
    // последняя пачка уходила бы в закрытый stdin («write after end»).
    expect(src).toContain("if (running || queue.length > 0 || inFlight > 0) return;");
  });

  it("runVideo не копит пачку, когда модель её не принимает", () => {
    const src: string = fs.readFileSync(path.join(root, "server", "ts", "upscale.ts"), "utf8");
    // prettier переносит длинные условия — проверяем по частям.
    expect(src).toContain("const canBatch =");
    expect(src).toContain("modelCanBatch(modelForBatch)");
    expect(src).toContain("const wantBatch = batchFrames > 1 && canBatch;");
    expect(src).toContain("queueBatches: QUEUE_BATCHES");
    expect(pipe).toBeTruthy();
  });
});

describe("контракт UI: настройки пачки у моделей без пачки", () => {
  it("движок отдаёт batch в каталоге и не теряет его при sync", () => {
    const src: string = fs.readFileSync(path.join(root, "server", "ts", "upscale.ts"), "utf8");
    expect(src).toMatch(/batch: modelBatchLimit\(m\),/);
    // Поле обязано переживать sync каталога с GitHub.
    expect(src).toMatch(/batch: numOpt\(m\.batch, 1, BATCH_MAX\),/);
  });

  it("в Pro-настройках поля пачки появляются только там, где пачка возможна", () => {
    const pro: string = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "UpscaleProSettings.tsx"),
      "utf8",
    );
    expect(pro).toContain(
      "const canBatchFrames = !noUpscale && (!upModel || upModel.batch !== 1);",
    );
    expect(pro).toContain("const canInterpBatch =");
    // Пачку скрываем и когда модель её не принимает, и когда движок поймал отказ
    // графа во время задания (batchReason = "unsupported").
    expect(pro).toContain('{canBatchFrames && batchReason !== "unsupported" ? (');
    expect(pro).toContain('t("up.batchSingle")');
    expect(pro).toContain("interpBatch: Number(e.target.value)");
    // Список моделей помечает «без пачки»/«по тайлу». Селектор модели — теперь
    // своя панель (UpscaleModelPicker): там же и пометка про пачку.
    const dash: string = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "UpscaleModelPicker.tsx"),
      "utf8",
    );
    expect(dash).toContain('t("up.batchNone")');
    expect(pro).toContain('t("up.batchTilesNone")');
  });

  it("каталог моделей показывает пометку о пачке, а локали её содержат", () => {
    const panel: string = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "UpscaleModelsPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain('t("up.mdlBatchFixed")');
    expect(panel).toContain('t("up.mdlBatchMax"');
    const keys = [
      "batchNone",
      "batchTilesNone",
      "batchSingle",
      "batchSingleHint",
      "interpBatch",
      "interpBatchHint",
      "interpBatchSingleHint",
      "interpBatchAutoUsed",
      "mdlBatchFixed",
      "mdlBatchMax",
      "mdlBatchUnknown",
    ];
    for (const lang of ["ru", "en", "es", "fr", "zh", "ar"]) {
      const json = JSON.parse(
        fs.readFileSync(path.join(root, "src", "i18n", `${lang}.json`), "utf8"),
      );
      for (const k of keys) expect(typeof json.up[k], `${lang}.up.${k}`).toBe("string");
    }
  });

  it("параметры задания: interpBatch доезжает от UI до движка", () => {
    const client: string = fs.readFileSync(path.join(root, "src", "api", "types.ts"), "utf8");
    expect(client).toMatch(/interpBatch: number;/);
    const page: string = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "UpscalePage.tsx"),
      "utf8",
    );
    expect(page).toMatch(/interpBatch: 0,/);
    const src: string = fs.readFileSync(path.join(root, "server", "ts", "upscale.ts"), "utf8");
    expect(src).toMatch(/interpBatch: batchChoiceOf\(raw\.interpBatch\),/);
    expect(src).toMatch(/tileBatch: job\.interpBatchUsed \|\| 1,/);
  });
});
