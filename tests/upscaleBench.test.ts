import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Замеры скорости моделей: считаются на этой машине и лежат в storage, поэтому
 * у каждого пользователя свои. Здесь проверяем арифметику замера (время тайла →
 * оценка кадра и fps), устойчивость чтения файла замеров и сам прогон с
 * поддельной ONNX-сессией — реальный прогон занимал бы минуты и требовал GPU.
 */
const req = createRequire(import.meta.url);
let engine: any;
let storage = "";

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bench-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/upscale");
});

/** Модель для замера: сессию подставляем сами, каталог не нужен. */
const fakeModel = (scale = 2, tile = 64) => ({
  id: "bench-test",
  label: "Bench test",
  scale,
  tile,
  align: 2,
  rec: { tile },
});

/**
 * Поддельный рантайм: одна «сессия» считает тайл и возвращает увеличенную
 * плоскость. `ms` — искусственная задержка, чтобы проверить, что в замер идёт
 * минимум из прогонов, а не первый (прогрев) результат.
 */
function fakeDeps(
  o: {
    scale?: number;
    tile?: number;
    provider?: string;
    delay?: number;
    fixedBatch?: boolean;
  } = {},
) {
  const scale = o.scale ?? 2;
  // Небольшая задержка по умолчанию: у мига быстрого прогона время вышло бы 0 мс,
  // а замер обязан быть положительным (в проде это реальный инференс).
  const delay = o.delay ?? 2;
  const calls: number[][] = [];
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    async run(feeds: Record<string, { dims: readonly number[] }>) {
      const t = feeds.input;
      calls.push([...t.dims]);
      // Граф с фиксированным batch: второй кадр в пачке — ошибка, как у ONNX.
      if (o.fixedBatch && t.dims[0] > 1) throw new Error("Got: 2 Expected: 1");
      if (delay) await new Promise((r) => setTimeout(r, delay));
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
  };
  return {
    calls,
    deps: {
      ort,
      ready: { session, provider: o.provider || "cuda", bgr: false, scale },
      model: fakeModel(scale, o.tile ?? 64),
    },
  };
}

describe("замер: арифметика кадра и fps", () => {
  it("время тайла превращается в оценку кадра по числу тайлов", () => {
    const e = engine.benchEntry({
      model: "m1",
      provider: "cuda",
      tile: 256,
      ms: 12.34,
      tiles: 6,
      runs: 3,
      when: 1700000000000,
    });
    expect(e.ms).toBe(12.3);
    expect(e.frameMs).toBe(74);
    expect(e.fps).toBe(13.5);
    expect(e.runs).toBe(3);
    expect(e.when).toBe(1700000000000);
    // Пачка в замере всегда одиночная: сравниваем модели, а не режимы.
    expect(e.batch).toBe(1);
  });

  it("без тайлов кадр равен самому тайлу, мусор в полях чистится", () => {
    const e = engine.benchEntry({
      model: "m1",
      provider: "",
      tile: -5,
      ms: 0.04,
      tiles: 0,
    });
    expect(e.tile).toBe(0);
    expect(e.frameMs).toBe(0);
    // fps считаем от ms один тайл: 1000 / 0.04 → 25000, но без тайлов он не нужен.
    expect(e.fps).toBe(0);
    expect(e.runs).toBe(1);
    expect(e.batch).toBe(1);
  });

  it("число тайлов считается по тайлу модели (0 — не считаем)", () => {
    expect(engine.benchTiles(0)).toBe(0);
    const tiles = engine.benchTiles(128, null, "cuda");
    expect(tiles).toBe(engine.tileRects(848, 480, 128, 16).length);
    expect(tiles).toBeGreaterThan(1);
  });
});

describe("замер: чтение файла замеров", () => {
  it("испорченный файл и мусор в записях не роняют панель", () => {
    expect(engine.sanitizeBench(null)).toEqual({});
    expect(engine.sanitizeBench("мусор")).toEqual({});
    expect(engine.sanitizeBench({ results: { a: "не список" } })).toEqual({});
    // Без времени тайла запись бессмысленна — отбрасываем.
    expect(engine.sanitizeBench({ results: { a: [{ ms: 0, provider: "cuda" }] } })).toEqual({});
    const ok = engine.sanitizeBench({
      version: 1,
      results: {
        m1: [
          { provider: "tensorrt", tile: -10, ms: "8.5", frameMs: "51", fps: "19.6", tiles: "6" },
          { provider: "cuda", ms: 20, tile: 256 },
        ],
      },
    });
    expect(Object.keys(ok)).toEqual(["m1"]);
    expect(ok.m1.length).toBe(2);
    expect(ok.m1[0]).toMatchObject({ provider: "tensorrt", tile: 0, ms: 8.5, tiles: 6 });
    // Провайдер по умолчанию — пустой, но запись остаётся (модель замера известна).
    expect(ok.m1[1].provider).toBe("cuda");
  });

  it("записи ограничены восемью на модель (файл не растёт бесконечно)", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ms: 5 + i,
      provider: `p${i}`,
      tile: 128,
    }));
    const ok = engine.sanitizeBench({ results: { m1: rows } });
    expect(ok.m1.length).toBe(8);
  });
});

describe("замер: прогон модели и хранение", () => {
  it("прогон сохраняет замер и перечитывается с диска", async () => {
    engine.clearBench();
    const { deps, calls } = fakeDeps({ scale: 2, tile: 64, provider: "cuda" });
    const r = await engine.benchModel("bench-test", { tile: 64, runs: 2, deps });
    // Прогрев + два прогона: в зачёт идут только измеренные. Проба пачки считает
    // те же кадры пачкой, поэтому одиночных прогонов ровно три.
    expect(calls.filter((d) => d[0] === 1).length).toBe(3);
    expect(r.entry.model).toBe("bench-test");
    expect(r.entry.provider).toBe("cuda");
    expect(r.entry.tile).toBe(64);
    expect(r.entry.runs).toBe(2);
    expect(r.entry.ms).toBeGreaterThan(0);
    expect(r.entry.tiles).toBe(engine.tileRects(848, 480, 64, 16).length);
    // Файл замеров — локальные данные пользователя, а не каталог.
    const file = path.join(storage, "upscale-bench.json");
    expect(fs.existsSync(file)).toBe(true);
    const back = engine.benchResults();
    expect(back["bench-test"].length).toBe(1);
    expect(back["bench-test"][0].ms).toBe(r.entry.ms);
  });

  it("повторный замер того же провайдера и тайла заменяет старую запись", async () => {
    const { deps } = fakeDeps({ provider: "cuda" });
    await engine.benchModel("bench-test", { tile: 64, runs: 1, deps });
    let list = engine.benchResults()["bench-test"];
    expect(list.length).toBe(1);
    // Другой провайдер — отдельная строка: на этой машине может быть и CUDA, и DML.
    const other = fakeDeps({ provider: "dml" });
    await engine.benchModel("bench-test", { tile: 64, runs: 1, deps: other.deps });
    list = engine.benchResults()["bench-test"];
    expect(list.length).toBe(2);
    expect(list.map((e: any) => e.provider).sort()).toEqual(["cuda", "dml"]);
  });

  it("второй замер во время первого не запускается (GPU один)", async () => {
    const slow = fakeDeps({ delay: 30 });
    const first = engine.benchModel("bench-test", { tile: 64, runs: 1, deps: slow.deps });
    await expect(
      engine.benchModel("bench-test", { tile: 64, runs: 1, deps: fakeDeps().deps }),
    ).rejects.toThrow("bench_busy");
    await first;
    // После прогона флаг снят — следующий замер проходит.
    expect(engine.benchBusy()).toBe(false);
    const again = await engine.benchModel("bench-test", {
      tile: 64,
      runs: 1,
      deps: fakeDeps().deps,
    });
    expect(again.entry.ms).toBeGreaterThan(0);
  });

  it("незнакомая модель — ошибка, «забыть замеры» чистит файл", async () => {
    // Депсы не подставляем: так проверяется и поиск модели по каталогу.
    await expect(engine.benchModel("нет-такой", { runs: 1 })).rejects.toThrow("model_unknown");
    expect(Object.keys(engine.benchResults()).length).toBeGreaterThan(0);
    expect(engine.clearBench().ok).toBe(true);
    expect(engine.benchResults()).toEqual({});
  });
});

describe("замер: предел пачки", () => {
  it("оценка памяти пробы считается по кадрам и масштабу", () => {
    // 128 px, ×2: вход 196 КБ + выход 786 КБ на кадр.
    expect(engine.batchProbeMb(1, 128, 2)).toBe(1);
    expect(engine.batchProbeMb(16, 128, 2)).toBe(16);
    // Тяжёлый случай (тайл 512, ×4) при 16 кадрах в потолок не лезет.
    expect(engine.batchProbeMb(16, 512, 4)).toBeGreaterThan(engine.BENCH_BATCH_MB);
  });

  it("проба находит предел: граф принимает пачку", async () => {
    const { deps } = fakeDeps({ provider: "cuda" });
    const n = await engine.probeBatchMax({
      src: engine.benchFrameSrc(128, 128),
      p: { model: "bench-test", tile: 128, overlap: 16, threads: 0, provider: "cuda" },
      size: 128,
      side: 128,
      provider: "cuda",
      scale: 2,
      deps,
    });
    // Обычная сессия принимает пачку: доходим до последней ступени.
    expect(n).toBe(engine.BENCH_BATCH_STEPS[engine.BENCH_BATCH_STEPS.length - 1]);
  });

  it("TensorRT не пробует больше своего профиля", async () => {
    const { deps } = fakeDeps({ provider: "tensorrt" });
    const n = await engine.probeBatchMax({
      src: engine.benchFrameSrc(128, 128),
      p: { model: "bench-test", tile: 128, overlap: 16, threads: 0, provider: "tensorrt" },
      size: 128,
      side: 128,
      provider: "tensorrt",
      scale: 2,
      deps,
    });
    expect(n).toBe(engine.TRT_BATCH_MAX);
  });

  it("граф с фиксированным batch: предел 1, и это запоминается на процесс", async () => {
    const strict = fakeDeps({ provider: "cuda", fixedBatch: true });
    const n = await engine.probeBatchMax({
      src: engine.benchFrameSrc(128, 128),
      p: { model: "bench-strict", tile: 128, overlap: 16, threads: 0, provider: "cuda" },
      size: 128,
      side: 128,
      provider: "cuda",
      scale: 2,
      model: "bench-strict",
      deps: strict.deps,
    });
    expect(n).toBe(1);
    // Замер по такой модели не только покажет «1 за проход», но и избавит движок
    // от повторных попыток пачки до конца процесса.
    expect(engine.batchAllowed("bench-strict")).toBe(false);
  });

  it("замер модели сохраняет предел пачки в записи", async () => {
    engine.clearBench();
    const { deps } = fakeDeps({ provider: "cuda" });
    const r = await engine.benchModel("bench-batch", { tile: 64, runs: 1, deps });
    expect(r.entry.batchMax).toBe(engine.BENCH_BATCH_STEPS[3]);
    expect(engine.benchResults()["bench-batch"][0].batchMax).toBe(r.entry.batchMax);
  });
});

describe("замер: где живёт в интерфейсе", () => {
  it("скорость показывается в окне каталога, а не в селекторе", () => {
    const panel = fs.readFileSync("src/pages/upscale/parts/UpscaleModelsPanel.tsx", "utf8");
    // Кнопка на всю серию и кнопка в карточке каждой модели.
    expect(panel).toContain('t("up.mdlBenchAll")');
    expect(panel).toContain("onBenchAll()");
    expect(panel).toContain("onBench(m.id)");
    expect(panel).toContain("up-mdl-bench");
    expect(panel).toContain('t("up.mdlBenchRow"');
    // Серию можно прервать: она занимает GPU.
    expect(panel).toContain('t("up.mdlBenchStop")');
    expect(panel).toContain("onBenchStop");
    // Селектор на странице — только названия, замеров там нет.
    const picker = fs.readFileSync("src/pages/upscale/parts/UpscaleModelPicker.tsx", "utf8");
    expect(picker).not.toContain("up-pick-meas");
    expect(picker).not.toContain("measured");
    // «Пачка ?» больше нет: каталог либо знает предел, либо говорит «авто», а замер
    // подставляет факт этой машины.
    expect(panel).toContain('t("up.mdlBatchAuto")');
    expect(panel).toContain('t("up.mdlBatchAutoHint")');
    expect(panel).toContain('t("up.mdlBatchMeasured"');
    expect(panel).not.toContain("mdlBatchUnknown");
  });

  it("страница считает замеры последовательно и умеет остановить серию", () => {
    const page = fs.readFileSync("src/pages/upscale/UpscalePage.tsx", "utf8");
    expect(page).toContain("api.upscaleBench()");
    expect(page).toContain("api.upscaleBenchModel(m.id, { tile: m.rec.tile })");
    expect(page).toContain("benchStop.current = true");
    expect(page).toContain("api.upscaleBenchClear()");
    // Серия идёт по одной модели: одна не замерилась — остальные продолжаются.
    expect(page).toMatch(/catch \(e\) \{[\s\S]{0,160}setDefect\(`\$\{m\.label\}: /);
  });

  it("маршруты и клиент знают про замеры", () => {
    const routes = fs.readFileSync("server/routes/upscale.js", "utf8");
    expect(routes).toContain('router.get("/bench"');
    expect(routes).toContain('router.post("/bench"');
    expect(routes).toContain('router.post("/bench/clear"');
    // 409 — «замер уже идёт»: панель показывает понятный текст, а не код.
    expect(routes).toContain('e.message === "bench_busy"');
    const client = fs.readFileSync("src/api/client.ts", "utf8");
    expect(client).toContain("upscaleBenchModel:");
    expect(client).toContain('"/upscale/bench/clear"');
  });

  it("все ключи замеров и сворачивания пресетов есть во всех локалях", () => {
    const keys = [
      "mdlBench",
      "mdlBenchHint",
      "mdlBenchBusy",
      "mdlBenchAll",
      "mdlBenchAllHint",
      "mdlBenchDone",
      "mdlBenchStop",
      "mdlBenchStopHint",
      "mdlBenchClear",
      "mdlBenchClearHint",
      "mdlBenchRow",
      "mdlBenchTip",
      "mdlErr_bench_busy",
      "presetsCollapse",
      "presetsExpand",
    ];
    for (const loc of ["ru", "en", "es", "fr", "zh", "ar"]) {
      const up = JSON.parse(fs.readFileSync(`src/i18n/${loc}.json`, "utf8")).up;
      for (const key of keys) {
        expect(typeof up[key], `${loc}.${key}`).toBe("string");
        expect(up[key].length, `${loc}.${key}`).toBeGreaterThan(0);
      }
      // В подписи строки замера подставляются все четыре значения.
      for (const v of ["provider", "tile", "ms", "fps"]) {
        expect(up.mdlBenchRow, `${loc}.mdlBenchRow`).toContain(`{${v}}`);
      }
    }
  });
});
