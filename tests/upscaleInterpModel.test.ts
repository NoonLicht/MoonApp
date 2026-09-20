import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * ONNX-интерполяторы (RIFE / CAIN / IFRNet) без реального инференса.
 *
 * Проверяем то, что ломается незаметно: определение схемы входов, раскладку
 * тензоров (NCHW / concat / timestep), тайлинг пары кадров и число вставок,
 * сцен-кат по разнице кадров и разделение каталога моделей на апскейлеры и
 * интерполяторы (иначе интерполятор можно выбрать как модель апскейла).
 */
const req = createRequire(import.meta.url);

let engine: any;
let pipe: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-model-"));
  engine = req("../server/upscale");
  pipe = req("../server/upscalePipeline");
});

/** Минимальный ort-подобный модуль: Tensor запоминает данные и размерности. */
const fakeOrt = {
  Tensor: class {
    dims: number[];
    constructor(
      public type: string,
      public data: Float32Array,
      dims: number[],
    ) {
      this.dims = dims;
    }
  },
};

/** rgb24-кадр одного цвета. */
const solid = (w: number, h: number, r: number, g: number, b: number) => {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
};

describe("интерполяторы: схема входов", () => {
  it("detectInterpSig узнаёт три поддерживаемые схемы", () => {
    expect(engine.detectInterpSig(["img0", "img1", "timestep"])).toBe("rife-pair-timestep");
    expect(engine.detectInterpSig(["frame0", "frame1"])).toBe("ifrnet-pair");
    expect(engine.detectInterpSig(["input"])).toBe("cain-concat");
  });

  it("понимает имена с префиксами экспортёра", () => {
    expect(engine.detectInterpSig(["img0_1", "img1_1", "timestep_1"])).toBe("rife-pair-timestep");
    expect(engine.detectInterpSig(["frame0_1", "frame1_1"])).toBe("ifrnet-pair");
  });

  it("незнакомая схема — пустая строка, а не исключение", () => {
    expect(engine.detectInterpSig(["foo", "bar"])).toBe("");
    expect(engine.detectInterpSig([])).toBe("");
    expect(engine.detectInterpSig(undefined as unknown as string[])).toBe("");
  });

  it("тайминги вставок: ×2 → 0.5; ×3 → 1/3 и 2/3; ×4 → 0.25/0.5/0.75", () => {
    expect(engine.interpTimesteps(2)).toEqual([0.5]);
    expect(engine.interpTimesteps(3)).toEqual([1 / 3, 2 / 3]);
    expect(engine.interpTimesteps(4)).toEqual([0.25, 0.5, 0.75]);
    // Мусор и единица не должны давать пустой набор молча.
    expect(engine.interpTimesteps(1)).toEqual([0.5]);
  });

  it("resolveInterpSig предпочитает явное поле манифеста", () => {
    const names = ["img0", "img1", "timestep"];
    expect(engine.resolveInterpSig({ inputSig: "cain-concat" }, names)).toBe("cain-concat");
    expect(engine.resolveInterpSig({}, names)).toBe("rife-pair-timestep");
    expect(engine.resolveInterpSig({}, ["foo"])).toBe("");
  });
});

describe("интерполяторы: тензоры входов", () => {
  const mk = (sig: string, names: string[], t: number, size = 2) =>
    engine.buildInterpFeeds({
      ort: fakeOrt,
      sig,
      session: { inputNames: names },
      prev: solid(size, size, 255, 0, 0),
      cur: solid(size, size, 0, 0, 255),
      srcW: size,
      x: 0,
      y: 0,
      tw: size,
      th: size,
      t,
      bgr: false,
    });

  it("пара + timestep: две рамки NCHW [1,3,h,w] и момент времени [1]", () => {
    const feeds = mk("rife-pair-timestep", ["img0", "img1", "timestep"], 0.5);
    expect(Object.keys(feeds)).toEqual(["img0", "img1", "timestep"]);
    expect(feeds.img0.dims).toEqual([1, 3, 2, 2]);
    expect(feeds.img1.dims).toEqual([1, 3, 2, 2]);
    expect(feeds.timestep.dims).toEqual([1]);
    expect(Array.from(feeds.timestep.data)).toEqual([0.5]);
    // Плоская раскладка (NCHW): плоскости R, G, B идут подряд, поэтому
    // «красная» рамка — это R=1, G=0, B=0 в трёх плоскостях по 4 пикселя.
    const plane = 4;
    expect(feeds.img0.data[0]).toBeCloseTo(1, 5);
    expect(feeds.img0.data[plane]).toBeCloseTo(0, 5);
    expect(feeds.img0.data[plane * 2]).toBeCloseTo(0, 5);
    expect(feeds.img1.data[0]).toBeCloseTo(0, 5);
    expect(feeds.img1.data[plane * 2]).toBeCloseTo(1, 5);
  });

  it("concat: один вход [1,6,h,w] — рамки подряд по каналам", () => {
    const feeds = mk("cain-concat", ["input"], 0.5);
    expect(Object.keys(feeds)).toEqual(["input"]);
    expect(feeds.input.dims).toEqual([1, 6, 2, 2]);
    const plane = 4;
    // Первая рамка занимает плоскости 0–2 (красная), вторая — 3–5 (синяя).
    expect(feeds.input.data[0]).toBeCloseTo(1, 5);
    expect(feeds.input.data[plane * 3]).toBeCloseTo(0, 5);
    expect(feeds.input.data[plane * 5]).toBeCloseTo(1, 5);
  });

  it("ifrnet: frame0/frame1 без timestep", () => {
    const feeds = mk("ifrnet-pair", ["frame0", "frame1"], 0.5);
    expect(Object.keys(feeds)).toEqual(["frame0", "frame1"]);
    for (const f of Object.values(feeds) as any[]) expect(f.dims).toEqual([1, 3, 2, 2]);
  });

  it("тайл вырезается по координатам, а не из левого верхнего угла", () => {
    const w = 4;
    const h = 2;
    const prev = Buffer.alloc(w * h * 3);
    const off = (1 * w + 2) * 3; // пиксель (2,1)
    prev[off + 1] = 255;
    const feeds = engine.buildInterpFeeds({
      ort: fakeOrt,
      sig: "ifrnet-pair",
      session: { inputNames: ["frame0", "frame1"] },
      prev,
      cur: Buffer.alloc(w * h * 3),
      srcW: w,
      x: 2,
      y: 1,
      tw: 2,
      th: 1,
      t: 0.5,
      bgr: false,
    });
    const plane = 2; // tw*th для тайла 2×1
    // Пиксель (2,1) — локальный 0: R канала 0, G канала 1 (зелёный).
    expect(feeds.frame0.data[0]).toBeCloseTo(0, 5);
    expect(feeds.frame0.data[plane + 0]).toBeCloseTo(1, 5);
    expect(feeds.frame0.data[plane * 2 + 0]).toBeCloseTo(0, 5);
  });
});

/** Сессия-заглушка: возвращает среднее двух входов (кадр «посередине»). */
function mockSession(inputNames: string[]) {
  return {
    inputNames,
    outputNames: ["output"],
    runs: 0,
    async run(feeds: Record<string, any>) {
      (this as any).runs++;
      const a = feeds[inputNames[0]].data as Float32Array;
      const b = (feeds[inputNames[1]] || feeds[inputNames[0]]).data as Float32Array;
      const out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
      return { output: { data: out, dims: [1, 3, 1, 1] } };
    },
  };
}

describe("интерполяторы: тайлинг пары кадров", () => {
  it("кадр собирается из всех тайлов, число прогонов = число тайлов", async () => {
    const w = 64;
    const h = 48;
    const session = mockSession(["img0", "img1", "timestep"]);
    const frames = await engine.interpolatePair({
      prev: solid(w, h, 0, 0, 0),
      cur: solid(w, h, 255, 255, 255),
      w,
      h,
      p: { tile: 32, overlap: 8, provider: "cpu", threads: 0 },
      model: { id: "mock", tile: 32, overlap: 8, bgr: false },
      sig: "rife-pair-timestep",
      ts: [0.5],
      deps: { ort: fakeOrt, ready: { session, provider: "cpu", bgr: false, scale: 1 } },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(w * h * 3);
    // Середина между чёрным и белым — 127/128 в каждом канале.
    expect(frames[0][0]).toBeGreaterThanOrEqual(126);
    expect(frames[0][0]).toBeLessThanOrEqual(129);
    // Тайлы 32×32 с шагом 24 по сетке 64×48: 3 × 2 = 6 прогонов на вставку.
    expect(session.runs).toBe(6);
  });

  it("три тайминга дают три кадра одинакового размера", async () => {
    const session = mockSession(["frame0", "frame1"]);
    const frames = await engine.interpolatePair({
      prev: solid(16, 16, 0, 0, 0),
      cur: solid(16, 16, 255, 255, 255),
      w: 16,
      h: 16,
      p: { tile: 16, overlap: 0, provider: "cpu", threads: 0 },
      model: { id: "mock", tile: 16, overlap: 0, bgr: false },
      sig: "ifrnet-pair",
      ts: [0.25, 0.5, 0.75],
      deps: { ort: fakeOrt, ready: { session, provider: "cpu", bgr: false, scale: 1 } },
    });
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.length).toBe(16 * 16 * 3);
  });

  it("без рантайма и без готовой сессии интерполяция падает понятной ошибкой", async () => {
    await expect(
      engine.interpolatePair({
        prev: solid(8, 8, 0, 0, 0),
        cur: solid(8, 8, 255, 255, 255),
        w: 8,
        h: 8,
        p: { tile: 0, overlap: 0, provider: "cpu", threads: 0 },
        model: { id: "none", bgr: false },
        sig: "ifrnet-pair",
        ts: [0.5],
        deps: { ort: fakeOrt },
      }),
    ).rejects.toThrow();

    describe("сцен-кат: разница кадров и дубли", () => {
      it("одинаковые кадры → 0, чёрный и белый → 100", () => {
        const black = solid(32, 32, 0, 0, 0);
        const white = solid(32, 32, 255, 255, 255);
        expect(pipe.frameDiffScore(black, black, 32, 32)).toBe(0);
        expect(pipe.frameDiffScore(black, white, 32, 32)).toBeCloseTo(100, 1);
      });

      it("разница не зависит от порядка кадров и лежит между 0 и 100", () => {
        const a = solid(32, 32, 0, 0, 0);
        const b = solid(32, 32, 100, 100, 100);
        const s1 = pipe.frameDiffScore(a, b, 32, 32);
        expect(s1).toBeCloseTo(pipe.frameDiffScore(b, a, 32, 32), 6);
        expect(s1).toBeGreaterThan(0);
        expect(s1).toBeLessThan(100);
      });

      it("нулевые размеры и короткие буферы не ломают счёт", () => {
        expect(pipe.frameDiffScore(Buffer.alloc(0), Buffer.alloc(0), 0, 0)).toBe(0);
        expect(pipe.frameDiffScore(Buffer.alloc(3), Buffer.alloc(3), 2, 2)).toBe(0);
      });

      it("isSceneCut сравнивает с порогом в той же шкале 0–100", () => {
        const black = solid(32, 32, 0, 0, 0);
        const white = solid(32, 32, 255, 255, 255);
        expect(pipe.isSceneCut(black, white, 32, 32, 12)).toBe(true);
        expect(pipe.isSceneCut(black, white, 32, 32, 100)).toBe(false);
        // Порог 0 = «сцен-кат выключен»: интерполируем всегда.
        expect(pipe.isSceneCut(black, white, 32, 32, 0)).toBe(false);
        expect(pipe.isSceneCut(black, black, 32, 32, 12)).toBe(false);
      });

      it("staticDuplicates повторяет кадр без копирования буфера", () => {
        const f = Buffer.from([1, 2, 3]);
        const dups = pipe.staticDuplicates(f, 2);
        expect(dups).toHaveLength(2);
        expect(dups[0]).toBe(f);
        expect(dups[1]).toBe(f);
        expect(pipe.staticDuplicates(f, 0)).toEqual([]);
      });
    });

    describe("каталог моделей: апскейлеры и интерполяторы раздельно", () => {
      it("у каждой записи есть kind, а у интерполятора — mult и inputSig", () => {
        const models = engine.listModels();
        expect(models.some((m: any) => m.kind === "upscale")).toBe(true);
        expect(models.some((m: any) => m.kind === "interp")).toBe(true);
        for (const m of models) {
          expect(["upscale", "interp"], m.id).toContain(m.kind);
          expect(m.kind === "interp" ? m.mult : m.scale).toBeGreaterThan(1);
          if (m.kind === "interp") {
            expect(["rife-pair-timestep", "cain-concat", "ifrnet-pair"], m.id).toContain(
              m.inputSig,
            );
          }
        }
      });

      it("interpModels и upscaleModels не пересекаются", () => {
        const interp = engine.interpModels().map((m: any) => m.id);
        const up = engine.upscaleModels().map((m: any) => m.id);
        expect(interp.length).toBeGreaterThan(0);
        expect(up.length).toBeGreaterThan(0);
        expect(interp.filter((id: string) => up.includes(id))).toEqual([]);
      });

      it("pickInterpModel не отдаёт апскейлер и находит интерполятор по id", () => {
        const anyInterp = engine.interpModels()[0].id;
        expect(engine.pickInterpModel(anyInterp)?.id).toBe(anyInterp);
        expect(engine.pickInterpModel("realesr-general-x4v3")).toBe(null);
        // Пустой id — первый интерполятор из манифеста (даже если файла ещё нет).
        expect(engine.pickInterpModel("")?.kind).toBe("interp");
      });
    });
  });
});

describe("planInterp: режим ONNX-модели", () => {
  const probe = { duration: 10, fps: 25, fpsNum: 25, fpsDen: 1 };
  const base = {
    probe,
    mult: 2,
    minterpolateMode: "mci",
    side: "decode",
    scdThreshold: 12,
    filters: ["scale=3840:2160:flags=lanczos"],
  };

  it("вставки считает движок: по pipe идёт выходная частота", () => {
    const p = pipe.planInterp({ ...base, mode: "model", side: "encode" });
    expect(p.kind).toBe("model");
    expect(p.on).toBe(true);
    // Кадров в энкодере N×mult: частота rawvideo-потока должна быть выходной,
    // иначе ffmpeg растянет видео в mult раз и `-shortest` обрежет его по звуку.
    expect(p.pipeRate).toEqual({ num: 50, den: 1 });
    expect(p.outRate).toEqual({ num: 50, den: 1 });
    expect(p.outPerIn).toBe(2);
    // 250 входных кадров → 499 выходных: между каждым переходом одна вставка.
    expect(p.framesTotal).toBe(499);
    expect(p.encodeFilters).toEqual(base.filters);
    // VFR → CFR: без fps-фильтра шаг между кадрами «плавает» и модель мажет.
    expect(p.decodeFilters).toEqual(["fps=25/1"]);
    // Сторона по умолчанию (decode) — вставки до апскейла, частота та же.
    const dec = pipe.planInterp({ ...base, mode: "model" });
    expect(dec.interpSide).toBe("decode");
    expect(dec.pipeRate).toEqual(p.pipeRate);
  });

  it("×3 даёт две вставки на переход", () => {
    const p = pipe.planInterp({ ...base, mode: "model", mult: 3 });
    expect(p.outPerIn).toBe(3);
    expect(p.outRate).toEqual({ num: 75, den: 1 });
    expect(p.framesTotal).toBe(748); // (250 − 1) × 3 + 1
  });

  it("без множителя и с нулевой частотой режим модели не включается", () => {
    expect(pipe.planInterp({ ...base, mode: "model", mult: 1 }).kind).toBe("off");
    expect(
      pipe.planInterp({
        ...base,
        mode: "model",
        probe: { ...probe, fps: 0, fpsNum: 0, fpsDen: 0 },
      }).kind,
    ).toBe("off");
  });

  it("дробная частота: 30000/1001 → 60000/1001 и CFR-фильтр с той же дробью", () => {
    const p = pipe.planInterp({
      ...base,
      mode: "model",
      probe: { duration: 10, fps: 29.97, fpsNum: 30000, fpsDen: 1001 },
    });
    expect(p.outRate).toEqual({ num: 60000, den: 1001 });
    expect(p.decodeFilters).toEqual(["fps=30000/1001"]);
  });
});
