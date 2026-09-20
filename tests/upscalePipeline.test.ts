import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Кадровый план видео-конвейера апскейла без ffmpeg.
 *
 * planInterp — чистая функция: по пробе видео и параметрам задания она решает,
 * где считается minterpolate («до» или «после» апскейла), какие фильтры уйдут
 * декодеру и энкодеру, с какой частотой пойдут кадры по pipe и сколько их
 * ожидать (это число показывает прогресс). Ошибка здесь стоит дорого: неверная
 * частота = рассинхрон звука на всю длительность, а не «поехавший бейдж».
 */
const req = createRequire(import.meta.url);

let pipe: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-plan-"));
  pipe = req("../server/upscalePipeline");
});

const probe = {
  width: 1920,
  height: 1080,
  fps: 30000 / 1001,
  fpsNum: 30000,
  fpsDen: 1001,
  duration: 10,
  hasAudio: true,
  hasSubs: false,
  codec: "h264",
};

const base = {
  probe,
  mode: "off",
  mult: 1,
  minterpolateMode: "mci",
  side: "decode",
  scdThreshold: 12,
  filters: ["scale=3840:2160:flags=lanczos"],
};

describe("planInterp: режим v1 (без интерполяции)", () => {
  it("фильтры декодера пусты, у энкодера только базовые, частота — исходная", () => {
    const p = pipe.planInterp(base);
    expect(p.on).toBe(false);
    expect(p.decodeFilters).toEqual([]);
    expect(p.encodeFilters).toEqual(base.filters);
    expect(p.pipeRate).toEqual({ num: 30000, den: 1001 });
    expect(p.outRate).toEqual({ num: 30000, den: 1001 });
    expect(p.framesTotal).toBe(300); // 10 c × 29.97 → округление
    expect(p.outFps).toBeCloseTo(29.97, 2);
  });

  it("mult=1 и mode=ffmpeg — всё ещё v1 (нет вставок, нет фильтра)", () => {
    const p = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 1 });
    expect(p.on).toBe(false);
    expect(p.decodeFilters).toEqual([]);
    expect(p.encodeFilters).toEqual(base.filters);
  });

  it("неизвестная частота исходника (0/0) не включает интерполяцию", () => {
    const p = pipe.planInterp({
      ...base,
      mode: "ffmpeg",
      mult: 2,
      probe: { ...probe, fps: 0, fpsNum: 0, fpsDen: 0 },
    });
    expect(p.on).toBe(false);
    expect(p.decodeFilters).toEqual([]);
  });
});

describe("planInterp: minterpolate до апскейла (decode, по умолчанию)", () => {
  it("×2: фильтр у декодера, pipe и выход — 59.94, тотал — по выходной частоте", () => {
    const p = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2 });
    expect(p.on).toBe(true);
    expect(p.decodeFilters[0]).toBe("fps=30000/1001");
    expect(p.decodeFilters[1]).toContain("minterpolate=fps=60000/1001");
    // Интерполяция до апскейла: декодер отдаёт уже 59.94, у энкодера фильтров
    // интерполяции нет — там остаются только масштаб/резкость.
    expect(p.encodeFilters).toEqual(base.filters);
    expect(p.pipeRate).toEqual({ num: 60000, den: 1001 });
    expect(p.outRate).toEqual({ num: 60000, den: 1001 });
    expect(p.outFps).toBeCloseTo(59.94, 2);
    expect(p.framesTotal).toBe(599);
  });

  it("×3 при 25 fps: 75 кадров в секунду и ×3 к кадровому тоталу", () => {
    const p = pipe.planInterp({
      ...base,
      mode: "ffmpeg",
      mult: 3,
      probe: { ...probe, fps: 25, fpsNum: 25, fpsDen: 1 },
    });
    expect(p.outRate).toEqual({ num: 75, den: 1 });
    expect(p.pipeRate).toEqual({ num: 75, den: 1 });
    expect(p.framesTotal).toBe(750); // 10 c × 75
  });
});

describe("planInterp: minterpolate после апскейла (encode)", () => {
  it("×2: декодер отдаёт исходные кадры, фильтр уходит в цепочку энкодера", () => {
    const p = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2, side: "encode" });
    expect(p.on).toBe(true);
    expect(p.decodeFilters).toEqual([]);
    expect(p.pipeRate).toEqual({ num: 30000, den: 1001 });
    // Порядок важен: сначала приведение размера, затем интерполяция.
    expect(p.encodeFilters[0]).toBe("scale=3840:2160:flags=lanczos");
    expect(p.encodeFilters[1]).toBe("fps=30000/1001");
    expect(p.encodeFilters[2]).toContain("minterpolate=fps=60000/1001");
    // Тотал считается по кадрам, реально идущим по pipe (кадр за кадром).
    expect(p.framesTotal).toBe(300);
    expect(p.outRate).toEqual({ num: 60000, den: 1001 });
  });

  it("сцен-кат: порог и режим попадают в фильтр как есть", () => {
    const p = pipe.planInterp({
      ...base,
      mode: "ffmpeg",
      mult: 2,
      side: "encode",
      minterpolateMode: "blend",
      scdThreshold: 40,
    });
    expect(p.encodeFilters[2]).toBe("minterpolate=fps=60000/1001:mi_mode=blend");
  });
});

describe("частота в аргументах энкодера", () => {
  it("по pipe идёт pipeRate, а выходную частоту задаёт фильтр minterpolate", () => {
    // Регресс: в `-r` (частота входного rawvideo) однажды попала выходная
    // частота, и ffmpeg «сплющил» длительность вдвое — интерполированные кадры
    // существовали, но контейнер считал их по удвоенному fps.
    const plan = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2, side: "encode" });
    const args = pipe.buildEncodeArgs({
      fps: plan.pipeRate.num,
      fpsNum: plan.pipeRate.num,
      fpsDen: plan.pipeRate.den,
      outWidth: 3840,
      outHeight: 2160,
      inputPath: "in.mp4",
      outFile: "out.mp4",
      encoder: "libx264",
      qualityArgs: ["-crf", "18"],
      audioAction: "copy",
      hasSubs: false,
      filters: plan.encodeFilters,
      metadata: true,
    });
    const s = args.join(" ");
    expect(s).toContain("-r 30000/1001");
    expect(s).toContain("minterpolate=fps=60000/1001");
  });

  it("при интерполяции до апскейла по pipe идёт уже удвоенная частота", () => {
    const plan = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2 });
    expect(plan.pipeRate).toEqual({ num: 60000, den: 1001 });
    expect(plan.encodeFilters.join(",")).not.toContain("minterpolate");
  });
});

describe("прогресс интерполяции", () => {
  it("framesTotal плана согласован с чистой арифметикой кадров", () => {
    const fps = 30;
    const duration = 20;
    const p = pipe.planInterp({
      ...base,
      mode: "ffmpeg",
      mult: 2,
      side: "encode",
      probe: { ...probe, fps, fpsNum: 30, fpsDen: 1, duration },
    });
    // Энкодер получит ровно столько кадров, сколько обещает minterpolate.
    expect(p.framesTotal).toBe(pipe.planFrames(duration, fps));
    expect(p.outRate).toEqual({ num: 60, den: 1 });
  });
});

describe("основной видеопоток и кодировщик", () => {
  it("обложка (attached_pic) не считается основным видео", () => {
    // Реальный случай: mp4 с видео AV1 360×640 и PNG-обложкой 1280×720.
    // Раньше проба брала «самый крупный» поток — UI показывал «png 1280×720».
    const streams = [
      {
        index: 0,
        codec_type: "video",
        codec_name: "av1",
        width: 360,
        height: 640,
        disposition: { default: 1 },
      },
      { index: 1, codec_type: "audio", codec_name: "opus" },
      {
        index: 2,
        codec_type: "video",
        codec_name: "png",
        width: 1280,
        height: 720,
        disposition: { attached_pic: 1 },
      },
    ];
    const main = pipe.pickMainVideoStream(streams);
    expect(main.codec_name).toBe("av1");
    expect(main.width).toBe(360);
    expect(main.height).toBe(640);
  });

  it("без флага default берётся первый настоящий видеопоток", () => {
    const main = pipe.pickMainVideoStream([
      {
        index: 0,
        codec_type: "video",
        codec_name: "png",
        width: 600,
        height: 600,
        disposition: { attached_pic: 1 },
      },
      { index: 1, codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
    ]);
    expect(main.codec_name).toBe("hevc");
  });

  it("энкодер выбирается по возможностям сборки: AV1 без SVT-AV1 берёт NVENC/aom", () => {
    // gyan «essentials»: libsvtav1 нет, зато есть av1_nvenc и libaom-av1 —
    // именно на этом падал AV1 («ничего не работает»).
    const caps = {
      encoders: new Set(["libx264", "libx265", "libaom-av1", "av1_nvenc", "hevc_nvenc"]),
      hwaccels: new Set(["cuda", "dxva2"]),
    };
    const hw = pipe.pickVideoEncoder({ codec: "av1", crf: 30, caps, hw: true });
    expect(hw.encoder).toBe("av1_nvenc");
    expect(hw.hardware).toBe(true);
    expect(hw.label).toBe("NVENC");
    // Качество у NVENC — своя ручка, а не -crf.
    expect(hw.qualityArgs).toContain("-cq");
    expect(hw.qualityArgs).toContain("30");

    // С выключенной видеокартой остаётся программный кодировщик сборки.
    const soft = pipe.pickVideoEncoder({ codec: "av1", crf: 30, caps, hw: false });
    expect(soft.encoder).toBe("libaom-av1");
    expect(soft.encoder).not.toContain("nvenc");
    expect(soft.qualityArgs).toEqual(["-crf", "30", "-b:v", "0"]);
  });

  it("SVT-AV1 берётся, когда он есть; AV1 без кодировщиков — честная пустота", () => {
    const withSvt = pipe.pickVideoEncoder({
      codec: "av1",
      crf: 20,
      caps: { encoders: new Set(["libsvtav1"]), hwaccels: new Set() },
      hw: true,
    });
    expect(withSvt.encoder).toBe("libsvtav1");
    expect(withSvt.label).toBe("SVT-AV1");

    const none = pipe.pickVideoEncoder({
      codec: "av1",
      crf: 20,
      caps: { encoders: new Set(["libx264"]), hwaccels: new Set() },
      hw: true,
    });
    expect(none.encoder).toBe("");
    expect(none.qualityArgs).toEqual([]);
  });

  it("CRF у AV1 длиннее: 63 вместо 51", () => {
    expect(pipe.crfMax("av1")).toBe(63);
    expect(pipe.crfMax("x264")).toBe(51);
    const caps = { encoders: new Set(["libsvtav1"]), hwaccels: new Set() };
    const enc = pipe.pickVideoEncoder({ codec: "av1", crf: 99, caps, hw: false });
    expect(enc.qualityArgs).toEqual(["-crf", "63", "-preset", "8"]);
  });

  it("аппаратный декодер берётся по приоритету CUDA → D3D11 → DXVA2", () => {
    expect(pipe.pickHwaccel({ encoders: new Set(), hwaccels: new Set(["dxva2", "cuda"]) })).toBe(
      "cuda",
    );
    expect(pipe.pickHwaccel({ encoders: new Set(), hwaccels: new Set(["d3d11va"]) })).toBe(
      "d3d11va",
    );
    // Метода нет — считаем на CPU, а не падаем.
    expect(pipe.pickHwaccel({ encoders: new Set(), hwaccels: new Set() })).toBe("");
  });

  it("разбор -encoders/-hwaccels не зависит от локали сборки", () => {
    const enc = pipe.parseEncoders(
      [
        "Encoders:",
        " V..... = Video",
        " V....D libsvtav1           SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)",
        " V....D h264_nvenc          NVIDIA NVENC H.264 encoder (codec h264)",
      ].join("\n"),
    );
    expect(enc.has("libsvtav1")).toBe(true);
    expect(enc.has("h264_nvenc")).toBe(true);
    expect(enc.has("Video")).toBe(false);
    const hw = pipe.parseHwaccels("Hardware acceleration methods:\ncuda\ndxva2\n");
    expect(hw.has("cuda")).toBe(true);
    expect(hw.has("dxva2")).toBe(true);
  });
});

describe("сторона интерполяции", () => {
  it("ONNX-модель: по pipe идёт выходная частота в обеих сторонах", () => {
    // Кадров в энкодере N×mult, поэтому частота rawvideo-потока — выходная.
    // С исходной частотой ffmpeg растягивал видео вдвое, а `-shortest` резал его
    // по звуковой дорожке.
    const before = pipe.planInterp({ ...base, mode: "model", mult: 2, side: "decode" });
    expect(before.kind).toBe("model");
    expect(before.interpSide).toBe("decode");
    expect(before.outPerIn).toBe(2);
    expect(before.pipeRate).toEqual({ num: 60000, den: 1001 });
    expect(before.outRate).toEqual(before.pipeRate);

    const after = pipe.planInterp({ ...base, mode: "model", mult: 2, side: "encode" });
    expect(after.interpSide).toBe("encode");
    expect(after.pipeRate).toEqual(after.outRate);
    // Вставки считает движок: у ffmpeg фильтров интерполяции нет ни там, ни там.
    expect(after.decodeFilters.join(",")).not.toContain("minterpolate");
    expect(after.encodeFilters.join(",")).not.toContain("minterpolate");
    expect(after.framesTotal).toBe(before.framesTotal);
  });

  it("ffmpeg-режим: сторона переключает, у кого стоит фильтр", () => {
    const dec = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2, side: "decode" });
    expect(dec.interpSide).toBe("decode");
    expect(dec.decodeFilters.join(",")).toContain("minterpolate");
    expect(dec.encodeFilters.join(",")).not.toContain("minterpolate");

    const enc = pipe.planInterp({ ...base, mode: "ffmpeg", mult: 2, side: "encode" });
    expect(enc.interpSide).toBe("encode");
    expect(enc.decodeFilters).toEqual([]);
    expect(enc.encodeFilters.join(",")).toContain("minterpolate");

    // Выключенная интерполяция сторону не изобретает.
    expect(pipe.planInterp({ ...base, mode: "off", mult: 2 }).interpSide).toBe("decode");
  });

  it("вставки до апскейла есть в конвейере, а лимит превью — по исходным кадрам", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "server", "ts", "upscalePipeline.ts"),
      "utf8",
    );
    expect(/const interpBefore = !!interpolate && opts\.interpSide === "decode";/.test(src)).toBe(
      true,
    );
    // Вставки до апскейла считаются от исходных кадров и сразу идут в обработку.
    expect(src).toContain("const between = await interpolate(prevIn, cur, inSeen);");
    expect(src).toContain("if (between.length !== insertsBefore(inSeen, outPerIn)) {");
    // …и не считаются второй раз после апскейла.
    expect(src).toContain("if (prevOut && interpolate && !interpBefore) {");
    // Превью-лимит: по исходным кадрам, иначе от ролика осталась бы половина.
    expect(src).toContain("if (limit && inSeen >= limit) return;");
    // Лимит учитывает и кадры в работе: с двойной буферизацией очередь живёт
    // раньше, чем пачка доедет до энкодера.
    expect(src).toContain(
      "if (!interpBefore && limit && queueStart + queue.length + inFlight >= limit) return;",
    );
  });
});

describe("остановка длинной пачки", () => {
  it("«Стоп» проверяется внутри пачки, а сама пачка режется на порции", () => {
    // Настоящая жалоба: на 4K с интерполяцией RIFE «Стоп» ждал конца пачки —
    // ONNX-заход прервать нельзя, поэтому длинную пачку обрабатываем порциями,
    // а остановку проверяем ещё и перед каждым готовым кадром (там интерполяция).
    const src = fs.readFileSync(
      path.join(__dirname, "..", "server", "ts", "upscalePipeline.ts"),
      "utf8",
    );
    const flush = /const flushQueueNow = async[\s\S]*?\n {4}\};/.exec(src)?.[0] || "";
    expect(flush).toContain("const take = Math.min(batch, queue.length)");
    expect(flush).toContain('if (opts.shouldStop?.()) throw new Error("stopped")');
    const handle = /const handleOut = async[\s\S]*?\n {4}\};/.exec(src)?.[0] || "";
    expect(handle).toContain('if (opts.shouldStop?.()) throw new Error("stopped")');
    // Пачка идёт целым заходом (32/64 не режутся на «порции»): за отзывчивость
    // «Стопа» отвечают проверки внутри тайловых циклов инференса.
    expect(src).not.toContain("STOP_PORTION");
  });

  it("остаток пачки добирается при закрытии декодера (иначе задача висит)", () => {
    // Настоящий клинч: файл кончился, в очереди осталось меньше batch кадров и
    // новых `data`-событий уже не будет — без добора остатка задача ждёт вечно
    // (видно было на прогоне 40 кадров при пачке 16: прогресс замирал на 32/40).
    const src = fs.readFileSync(
      path.join(__dirname, "..", "server", "ts", "upscalePipeline.ts"),
      "utf8",
    );
    expect(src).toContain("if (!running) void drainTail();");
    expect(src).toContain("if (!failed && decEnded) await drainTail();");
    // Вызовы пачки сериализованы: параллельный заход развалил бы раскладку кадров.
    expect(src).toContain("let flushing: Promise<void> = Promise.resolve();");
    expect(src).toContain("flushing = next.catch(() => undefined);");
    // stdin энкодера закрывается ровно один раз («write after end» иначе).
    expect(src).toContain("if (!encClosed && !encFinishing) {");
  });

  it("остановка видна и внутри ONNX: тайлы проверяют флаг задания", () => {
    // Пачка 16 кадров ×4K тоже считается секунды, поэтому флаг проверяется
    // между тайлами в самих функциях инференса — стоп почти мгновенный.
    const engine = fs.readFileSync(
      path.join(__dirname, "..", "server", "ts", "upscale.ts"),
      "utf8",
    );
    expect(/const stopped = \(\) => job\.stage === "stopped";/.test(engine)).toBe(true);
    expect(
      /upscaleRgbBatch\(\{[\s\S]{0,240}?shouldStop: stopped,/.test(engine),
      "пачка ONNX не получает флаг остановки",
    ).toBe(true);
    expect(
      /upscaleRgb\(\{ src: rgb, w, h, p: job, shouldStop: stopped \}\)/.test(engine),
      "поштучный путь ONNX не получает флаг остановки",
    ).toBe(true);
    expect(
      /for \(const r of rects\) \{\s+if \(o\.shouldStop\?\.\(\)\) throw new Error\("stopped"\);/.test(
        engine,
      ),
      "тайловые циклы инференса не проверяют остановку",
    ).toBe(true);
    // Остановка не должна выдаваться за «модель не умеет пачку»: и в пачечном
    // пути фото, и в тайлах интерполятора стоп пробрасывается как есть.
    expect(engine).toContain(
      'if (String((e as Error)?.message) === "stopped" || !isBatchMismatch(e)) throw e;',
    );
    expect(engine).toContain('if (stopped()) throw new Error("stopped", { cause: e });');
    // ORT не должен засорять консоль сервера своими INFO/WARNING.
    expect(engine).toContain("logSeverityLevel: 3");
  });
});
