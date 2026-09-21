import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Каталог моделей: выравнивание входа (Real-CUGAN), рекомендованный провайдер
 * (Anime4K не идёт на DirectML), fp16-графы и TensorRT.
 *
 * Проверки идут против собранного движка (server/upscale.js): `pretest` делает
 * `compile:server`, поэтому тест видит тот же код, что и приложение.
 */
const req = createRequire(import.meta.url);
let engine: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-models-"));
  engine = req("../server/upscale");
});

const manifest = (): any => JSON.parse(fs.readFileSync("server/models.manifest.json", "utf8"));

/**
 * Рантайм с заданным набором провайдеров: тесты не должны зависеть от того,
 * установлен ли на машине GPU-пак (иначе список провайдеров фильтруется по-разному).
 */
const fakeRuntime = (names: string[]): any => ({
  Tensor: class {},
  InferenceSession: { create: async () => ({}) },
  env: { versions: { common: "test" } },
  listSupportedBackends: () => names.map((name) => ({ name })),
});

describe("выравнивание входа модели (align)", () => {
  it("alignUp округляет вверх до кратного, modelAlign чистит мусор", () => {
    expect(engine.alignUp(91, 2)).toBe(92);
    expect(engine.alignUp(64, 4)).toBe(64);
    expect(engine.alignUp(65, 4)).toBe(68);
    // «Нет требования» — размер не меняется.
    expect(engine.alignUp(91, 1)).toBe(91);
    expect(engine.modelAlign({ id: "m", align: 4 })).toBe(4);
    expect(engine.modelAlign({ id: "m", align: 1 })).toBe(1);
    expect(engine.modelAlign({ id: "m", align: 999 })).toBe(1);
    expect(engine.modelAlign({ id: "m" })).toBe(1);
    expect(engine.modelAlign(null)).toBe(1);
  });

  it("нечётный кадр уходит в граф выравненным, а вклеивается реальный размер", async () => {
    const calls: number[][] = [];
    const scale = 2;
    const session = {
      inputNames: ["input"],
      outputNames: ["output"],
      async run(feeds: Record<string, { dims: readonly number[] }>) {
        const t = feeds.input;
        calls.push([...t.dims]);
        // Модель возвращает плоскость по факту входа (после выравнивания).
        const data = new Float32Array(scale * scale * t.dims[2] * t.dims[3] * 3).fill(0.5);
        return {
          output: { dims: [1, 3, t.dims[2] * scale, t.dims[3] * scale], data, dispose() {} },
        };
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
    const w = 91;
    const h = 63;
    const out = await engine.upscaleRgb({
      src: Buffer.alloc(w * h * 3, 120),
      w,
      h,
      p: { model: "cugan-test", tile: 0, overlap: 0, threads: 0, provider: "cpu" },
      deps: {
        ort,
        ready: { session, provider: "cpu", bgr: false, scale },
        model: { id: "cugan-test", file: "x.onnx", scale, align: 2 },
      },
    });
    // В граф ушёл размер, кратный двум...
    expect(calls).toEqual([[1, 3, 64, 92]]);
    // ...а результат — ровно ×2 к исходному кадру.
    expect([out.width, out.height]).toEqual([w * scale, h * scale]);
    expect(out.data.length).toBe(w * scale * h * scale * 3);
  });
});

describe("фиксированный профиль TensorRT", () => {
  /** Сессия-заглушка: запоминает размеры входа, отдаёт увеличенную в scale плоскость. */
  const fakeSession = (calls: number[][], scale: number, provider: string) => ({
    inputNames: ["input"],
    outputNames: ["output"],
    async run(feeds: Record<string, { dims: readonly number[] }>) {
      const t = feeds.input;
      calls.push([...t.dims]);
      const data = new Float32Array(scale * scale * t.dims[2] * t.dims[3] * 3).fill(0.5);
      return {
        output: { dims: [1, 3, t.dims[2] * scale, t.dims[3] * scale], data, dispose() {} },
      };
    },
    provider,
  });

  it("опции провайдера TensorRT названы так, как ждёт ORT", () => {
    const o = engine.trtOptions({ id: "m", tile: 512 }, 0, "C:/tmp/trt", 4);
    const ep = o.executionProviders[0];
    expect(ep.name).toBe("tensorrt");
    // Имена ключей — контракт с ORT: опечатка рушит сессию целиком
    // («Unknown provider option»). Именно так и было с trt_opt_profile_shapes.
    for (const k of [
      "trt_fp16_enable",
      "trt_engine_cache_enable",
      "trt_engine_cache_path",
      "trt_timing_cache_enable",
      "trt_timing_cache_path",
      "trt_builder_optimization_level",
      "trt_max_workspace_size",
      "trt_profile_min_shapes",
      "trt_profile_opt_shapes",
      "trt_profile_max_shapes",
    ]) {
      expect(ep[k], k).toBeDefined();
    }
    expect(ep["trt_opt_profile_shapes"]).toBeUndefined();
    // Профиль: тайл фиксирован (512 от модели), пачка — от 1 до 4.
    expect(ep.trt_profile_min_shapes).toBe("input:1x3x512x512");
    expect(ep.trt_profile_opt_shapes).toBe("input:4x3x512x512");
    expect(ep.trt_profile_max_shapes).toBe("input:4x3x512x512");
    // В опциях сессии этих ключей быть не должно: там их никто не читает.
    expect(o.trt_fp16_enable).toBeUndefined();
  });

  it("модель без движка не отдаёт ONNX: ручное удаление запрещено", () => {
    // «Освободить ONNX» имеет смысл только когда движок собран: иначе модель
    // станет недоступной (ORT читает граф при создании сессии).
    const anyModel = engine.listModels().find((m) => m.kind === "upscale");
    expect(anyModel).toBeTruthy();
    const reg = engine.trtRegistry();
    const hasEngine =
      !!reg[`${anyModel!.id}|${engine.trtProfileSize({ id: anyModel!.id, tile: 512 }, 512)}`];
    if (!hasEngine) {
      expect(() => engine.removeOnnx(anyModel!.id)).toThrow(/trt_engine_missing/);
    } else {
      // Движок есть — удаление разрешено, но проверяем только контракт (файл
      // в тестах трогать нельзя: он нужен остальным прогонам).
      expect(typeof engine.removeOnnx).toBe("function");
    }
    // Каталог сообщает, лежит ли граф на диске: панель по этому полю показывает
    // «ONNX убран · движок на месте» вместо «не скачана».
    expect(typeof anyModel!.onnxOnDisk).toBe("boolean");
  });

  it("реестр движков связывает модель с файлом и помнит профиль", () => {
    const reg = engine.trtRegistry();
    expect(typeof reg).toBe("object");
    // Ключ — «модель|профиль», значение — «512/<модель>/…engine»: из имени файла
    // движка (хеш графа) ни модель, ни размер тайла не вычитать.
    for (const [key, file] of Object.entries(reg)) {
      expect(key).toContain("|");
      expect(String(file)).toMatch(/^\d+\/[^/]+\/.+/);
    }
    expect(typeof engine.trtEngineFor("realesr-compact-x4")).toBe("string");
    // Собранные движки лежат в подпапках профиля и модели: общая папка ломала TRT
    // при смене тайла и привязывала к модели чужой движок.
    for (const e of engine.trtEngines()) expect(e.file).toMatch(/^\d+\/[^/]+\/.+/);
  });

  it("размер профиля берётся от тайла, но не меньше 64; пачка ограничена сверху", () => {
    expect(engine.trtProfileSize({ id: "m", tile: 512 }, 0)).toBe(512);
    expect(engine.trtProfileSize({ id: "m" }, 256)).toBe(256);
    // Слишком мелкий тайл TRT не любит: движок собираем от 64.
    expect(engine.trtProfileSize({ id: "m" }, 16)).toBe(64);
    expect(engine.TRT_BATCH_MAX).toBe(8);
  });

  it("с TensorRT тайлы добиваются до профиля, а в результат идёт реальный кадр", async () => {
    const calls: number[][] = [];
    const scale = 2;
    const session = fakeSession(calls, scale, "tensorrt");
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
    const w = 91;
    const h = 63;
    const out = await engine.upscaleRgb({
      src: Buffer.alloc(w * h * 3, 120),
      w,
      h,
      p: { model: "trt-tile", tile: 0, overlap: 0, threads: 0, provider: "tensorrt" },
      deps: {
        ort,
        ready: { session, provider: "tensorrt", bgr: false, scale },
        // Профиль считается от тайла модели: 64 — значит, каждый тайл уйдёт 64×64.
        model: { id: "trt-tile", file: "x.onnx", scale, tile: 64, align: 2 },
      },
    });
    // Кадр шире тайла → тайлов несколько, и все одного размера (никаких «не тех» форм).
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c).toEqual([1, 3, 64, 64]);
    // А на выходе — ровно ×2 от исходного кадра, без «запаса» от добивки.
    expect([out.width, out.height]).toEqual([w * scale, h * scale]);
  });
});

describe("провайдер модели", () => {
  it("рекомендация каталога идёт первой, но явный выбор настроек не отменяется", () => {
    // Провайдеры как в обычной сборке: без подмены результат зависел бы от
    // установленного на машине GPU-пака.
    engine.setOrtForTests(fakeRuntime(["cpu", "dml", "cuda", "tensorrt"]));
    try {
      const m = { id: "anime4k-x3-l", provider: "cpu" };
      // «auto» — сначала рекомендация модели (DML его роняет).
      expect(engine.providerOrder("auto", m)[0]).toBe("cpu");
      expect(engine.providerOrder("dml", m)).toEqual(["cpu", "dml"]);
      // Явный CPU остаётся единственным: других попыток не делаем.
      expect(engine.providerOrder("cpu", m)).toEqual(["cpu"]);
      // Модель без рекомендации — обычный список.
      expect(engine.providerOrder("auto", { id: "m" })).toEqual(["cuda", "dml", "cpu"]);
      // TensorRT идёт со своими падениями на CUDA/CPU.
      expect(engine.providerOrder("tensorrt", { id: "m" })).toEqual(["tensorrt", "cuda", "cpu"]);
    } finally {
      engine.setOrtForTests(null);
    }
  });

  it("в список провайдеров не попадает то, чего нет в рантайме", () => {
    // Стоковый npm-модуль: cuda/tensorrt не пробуем — они сразу упали бы.
    engine.setOrtForTests(fakeRuntime(["cpu", "dml", "webgpu"]));
    try {
      expect(engine.providerOrder("auto", { id: "m" })).toEqual(["dml", "cpu"]);
      expect(engine.providerOrder("cuda", { id: "m" })).toEqual(["cpu"]);
    } finally {
      engine.setOrtForTests(null);
    }
    // GPU-пак: есть CUDA/TensorRT, но нет DirectML — лишнего в списке нет.
    engine.setOrtForTests(fakeRuntime(["cpu", "cuda", "tensorrt"]));
    try {
      expect(engine.providerOrder("auto", { id: "m" })).toEqual(["cuda", "cpu"]);
      expect(engine.providerOrder("dml", { id: "m" })).toEqual(["cpu"]);
      expect(engine.providerOrder("tensorrt", { id: "m" })).toEqual(["tensorrt", "cuda", "cpu"]);
    } finally {
      engine.setOrtForTests(null);
    }
  });

  it("tensorType понимает и массив метаданных, и словарь", () => {
    expect(engine.tensorType([{ name: "input", type: "float16" }], "input")).toBe("float16");
    expect(engine.tensorType({ input: { type: "float32" } }, "input")).toBe("float32");
    expect(engine.tensorType([], "input")).toBe("");
    expect(engine.tensorType(undefined, "input")).toBe("");
  });
});

describe("каталог: новые модели, пресеты, TensorRT", () => {
  it("в манифесте есть новые модели с проверенными ссылками", () => {
    const models = manifest().models as any[];
    const byId = new Map(models.map((m) => [m.id, m]));
    const ids = [
      "anime4k-x3-l",
      "realesr-compact-x4",
      "real-cugan-2x-anime",
      "real-cugan-3x",
      "real-cugan-4x",
    ];
    for (const id of ids) {
      const m = byId.get(id);
      expect(m, id).toBeTruthy();
      expect(m.url, id).toMatch(/^https:\/\//);
      expect(m.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeMb, id).toBeGreaterThan(0);
      expect(m.file, id).toMatch(/\.onnx$/);
    }
    // Real-CUGAN требует кратных четырёх сторон, Anime4K не идёт на DML.
    for (const id of ["real-cugan-2x-anime", "real-cugan-3x", "real-cugan-4x"]) {
      expect(byId.get(id).align, id).toBe(4);
    }
    expect(byId.get("anime4k-x3-l").provider).toBe("cpu");
    expect(byId.get("anime4k-x3-l").scale).toBe(3);
    expect(byId.get("realesr-compact-x4").scale).toBe(4);
  });

  it("align и provider переживают обновление каталога из сети", () => {
    const doc = {
      models: [
        {
          id: "cugan-net",
          file: "cugan-net.onnx",
          label: "CUGAN",
          scale: 2,
          align: 4,
          provider: "cpu",
          url: "https://example.com/cugan-net.onnx",
          sha256: "a".repeat(64),
        },
        // Мусор: чужой провайдер и отрицательное выравнивание отбрасываются.
        { id: "junk", file: "junk.onnx", scale: 1, align: -5, provider: "hack", url: "" },
      ],
    };
    const list = engine.sanitizeManifest(doc);
    const cugan = list.find((m: any) => m.id === "cugan-net");
    expect(cugan.align).toBe(4);
    expect(cugan.provider).toBe("cpu");
    const junk = list.find((m: any) => m.id === "junk");
    // Мусор не проходит: провайдер отброшен, выравнивание зажато в допустимое.
    expect(junk.provider).toBeUndefined();
    expect(junk.align).toBe(2);
  });

  it("каждый пресет ссылается на существующую модель, а моделей хватает задачам", () => {
    const ids = new Set((manifest().models as any[]).map((m) => m.id));
    for (const p of engine.SYSTEM_PRESETS) {
      expect(ids.has(p.model), `${p.id} → ${p.model}`).toBe(true);
    }
    const presetIds = new Set(engine.SYSTEM_PRESETS.map((p: any) => p.id));
    for (const id of [
      "video-anime-cugan",
      "video-anime-anime4k",
      "video-compact",
      "photo-anime-cugan",
    ]) {
      expect(presetIds.has(id), id).toBe(true);
    }
  });

  it("TensorRT: статус честный, сборка без провайдера даёт понятную ошибку", async () => {
    const st = engine.trtStatus();
    expect(Array.isArray(st.backends)).toBe(true);
    await expect(engine.buildTrtEngine("no-such-model")).rejects.toThrow("model_unknown");

    // Движок проверяет файл модели раньше провайдера: подкладываем заглушку,
    // чтобы на машине без TensorRT получить именно «провайдера нет».
    const storage = process.env.MOONAPP_STORAGE as string;
    const dir = path.join(storage, "models", "upscale");
    const userManifest = path.join(storage, "models", "models.manifest.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "trt-probe.onnx"), "заглушка");
    fs.writeFileSync(
      userManifest,
      JSON.stringify({
        models: [{ id: "trt-probe", file: "trt-probe.onnx", label: "Probe", scale: 2, url: "" }],
      }),
    );
    try {
      if (!st.backends.includes("tensorrt")) {
        expect(st.available).toBe(false);
        await expect(engine.buildTrtEngine("trt-probe")).rejects.toThrow("trt_unavailable");
      } else {
        // Есть провайдер — движок обязан попытаться и либо собрать, либо честно
        // упасть на битой заглушке (это уже не «нет TensorRT»).
        expect(st.available).toBe(true);
        await expect(engine.buildTrtEngine("trt-probe")).rejects.not.toThrow("trt_unavailable");
      }
    } finally {
      fs.rmSync(userManifest, { force: true });
      fs.rmSync(path.join(dir, "trt-probe.onnx"), { force: true });
    }
  });
});

describe("GPU-пак (CUDA/TensorRT)", () => {
  it("в чистом storage пака нет — движок работает на стоковом модуле", () => {
    const st = engine.packStatus();
    expect(st.installed).toBe(false);
    expect(st.binding).toBe("");
    // Каталог пака привязан к платформе: сборка под win32-x64 не годится другим.
    expect(st.dir).toContain(path.join("ort-gpu", `${process.platform}-${process.arch}`));
  });

  it("пак виден по своему биндингу и pack.json", () => {
    const storage = process.env.MOONAPP_STORAGE as string;
    const dir = path.join(storage, "ort-gpu", `${process.platform}-${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "onnxruntime_binding.node"), "заглушка");
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({ provider: "cuda+tensorrt", version: "1.30.0" }),
    );
    try {
      const st = engine.packStatus();
      expect(st.installed).toBe(true);
      expect(st.binding.endsWith("onnxruntime_binding.node")).toBe(true);
      expect(st.provider).toBe("cuda+tensorrt");
      expect(st.version).toBe("1.30.0");
    } finally {
      fs.rmSync(path.join(storage, "ort-gpu"), { recursive: true, force: true });
    }
  });
});

describe("интерфейс: подписи новых пресетов и TensorRT в 6 локалях", () => {
  const KEYS = [
    "preset_video-anime-cugan",
    "preset_video-anime-anime4k",
    "preset_video-compact",
    "preset_photo-anime-cugan",
    "mdlProvider",
    "mdlProviderCpu",
    "mdlAlign",
    "mdlAlignHint",
    "mdlTrtBuild",
    "mdlTrtHint",
    "mdlTrtMissing",
    "mdlTrtDone",
    "mdlTrtBusy",
    "precision",
    "precisionHint",
    "precisionOnnx",
    "precisionTrt",
  ];

  it("все ключи есть во всех локалях", () => {
    for (const loc of ["ru", "en", "es", "fr", "zh", "ar"]) {
      const up = JSON.parse(fs.readFileSync(`src/i18n/${loc}.json`, "utf8")).up;
      for (const key of KEYS) {
        expect(typeof up[key], `${loc}.${key}`).toBe("string");
        expect(up[key].length, `${loc}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("панель моделей предлагает сборку движка только при наличии провайдера", () => {
    const panel = fs.readFileSync("src/pages/upscale/parts/UpscaleModelsPanel.tsx", "utf8");
    expect(panel).toContain("mdlTrtBuild");
    expect(panel).toContain("trtAvailable && m.kind");
    // Провайдер и выравнивание модели видны пользователю.
    expect(panel).toContain("mdlProviderCpu");
    expect(panel).toContain("mdlAlignHint");
    const pro = fs.readFileSync("src/pages/upscale/parts/UpscaleProSettings.tsx", "utf8");
    // TensorRT появляется в списке провайдеров только когда он есть в рантайме.
    expect(pro).toContain('hw?.trt?.available ? ["tensorrt"] : []');
    expect(pro).toContain('t("up.precision")');
  });
});
