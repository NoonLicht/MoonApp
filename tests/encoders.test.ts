import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Реестр энкодеров и детекция железа (server/ts/encoders.ts → server/encoders.js).
 *
 * Тест обязан быть детерминированным на любой машине: реальное GPU не проверяем,
 * а «фальшивые» бинари кладём в storage/bin — они находятся по имени, но не
 * запускаются, поэтому метод должен честно выпасть из списка доступных
 * (ветка «найден файлом, но не отвечает на --version»).
 */
const req = createRequire(import.meta.url);
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-encoders-"));
process.env.MOONAPP_STORAGE = storage;

/** Заголовок require-таблицы: имена, которые ждут compressor.js и роут. */
const EXPORTED = ["detectAll", "detectExternalBins", "gpuVendor", "classifyGpu", "recommend"];

beforeAll(() => {
  // Не-запускаемые «бинарники» во всех именах, которые ищет реестр.
  fs.mkdirSync(path.join(storage, "bin"), { recursive: true });
  for (const name of ["NVEncC64.exe", "QSVEncC64.exe", "VCEEncC64.exe", "av1an.exe", "rav1e.exe"]) {
    fs.writeFileSync(path.join(storage, "bin", name), "");
  }
  // Архивы часто кладут exe во вложенную папку — проверяем и эту ветку.
  fs.mkdirSync(path.join(storage, "nested", "NVEncC_7.2"), { recursive: true });
  fs.writeFileSync(path.join(storage, "nested", "NVEncC_7.2", "NVEncC64.exe"), "");
});

describe("encoders — форма модуля и классификация железа", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    const m = req("../server/encoders");
    expect(m.default).toBeUndefined();
    for (const fn of EXPORTED) expect(typeof m[fn], fn).toBe("function");
    // Таблицы для UI приходят данными, а внутренние функции наружу не торчат.
    expect(typeof m.OPTIMAL).toBe("object");
    expect(typeof m.SPEED_SCALES).toBe("object");
    expect(typeof m.METHOD_FFMPEG_ENC).toBe("object");
    expect(m.detectCpu).toBeUndefined();
  });

  it("gpuVendor: вендор определяется по имени адаптера", () => {
    const m = req("../server/encoders");
    expect(m.gpuVendor("NVIDIA GeForce RTX 4090")).toBe("nvidia");
    expect(m.gpuVendor("Intel(R) Arc(TM) A770 Graphics")).toBe("intel");
    expect(m.gpuVendor("Intel(R) UHD Graphics 630")).toBe("intel");
    expect(m.gpuVendor("AMD Radeon RX 6800 XT")).toBe("amd");
    expect(m.gpuVendor("Microsoft Basic Display Adapter")).toBe("unknown");
  });

  it("classifyGpu: тир кодека — Ada/Blackwell/Arc/RDNA и более старые", () => {
    const m = req("../server/encoders");
    expect(m.classifyGpu("NVIDIA GeForce RTX 4060")).toBe("av1");
    expect(m.classifyGpu("NVIDIA GeForce RTX 5080")).toBe("av1");
    expect(m.classifyGpu("Intel Arc A770")).toBe("av1");
    expect(m.classifyGpu("AMD Radeon RX 7600")).toBe("av1");
    expect(m.classifyGpu("NVIDIA GeForce RTX 3080")).toBe("hevc");
    expect(m.classifyGpu("NVIDIA Quadro P2000")).toBe("h264");
    expect(m.classifyGpu("Intel(R) UHD Graphics 630")).toBe("");
    // Квирк прежней .js-версии: шаблон /arc a\d/ не ловит WMI-имя
    // «Intel(R) Arc(TM) A770» (между «Arc» и моделью — «(TM)»). Поведение
    // сохранено как есть: тир остаётся пустым, метод сжатия уходит в CPU.
    expect(m.classifyGpu("Intel(R) Arc(TM) A770 Graphics")).toBe("");
  });

  it("detectExternalBins: найденный, но не запускаемый бинарь не считается доступным", async () => {
    const m = req("../server/encoders");
    const bins = await m.detectExternalBins();
    expect(Object.keys(bins).sort()).toEqual(["av1an", "nvencc", "qsvencc", "rav1e", "vceencc"]);
    for (const [id, exe] of Object.entries(bins)) {
      expect(exe, `${id}: фальшивый exe не должен считаться рабочим`).toBe(null);
    }
  });

  it("detectExternalBins: результат кэшируется (железо не меняется на лету)", async () => {
    const m = req("../server/encoders");
    const a = await m.detectExternalBins();
    const b = await m.detectExternalBins();
    expect(b).toBe(a);
  });
});
describe("encoders — сводка железа и рекомендация", () => {
  it("detectAll: полная сводка с булевыми методами и кэшем", async () => {
    const m = req("../server/encoders");
    const hw = await m.detectAll();
    expect(Object.keys(hw).sort()).toEqual([
      "cpu",
      "externals",
      "ffmpeg",
      "ffmpegEncoders",
      "gpus",
      "methods",
    ]);
    expect(hw.cpu.coresLogical).toBeGreaterThanOrEqual(1);
    expect(hw.cpu.coresPhysical).toBeGreaterThanOrEqual(1);
    expect(typeof hw.cpu.name).toBe("string");
    expect(Array.isArray(hw.gpus)).toBe(true);
    expect(Array.isArray(hw.ffmpegEncoders)).toBe(true);
    for (const enc of hw.ffmpegEncoders) expect(typeof enc).toBe("string");
    for (const [id, on] of Object.entries(hw.methods)) {
      expect(typeof on, `methods.${id}`).toBe("boolean");
    }
    // Форма ffmpeg-поля совпадает с detectFfmpeg (её ждёт роут /api/compressor).
    expect(typeof hw.ffmpeg.found).toBe("boolean");
    // force:true перезагружает сводку, без force — тот же объект из кэша.
    expect(await m.detectAll()).toBe(hw);
    const forced = await m.detectAll({ force: true });
    expect(forced.methods).not.toBeUndefined();
    expect(await m.detectAll()).toBe(forced);
  });

  it("recommend: метод, кодек и CRF согласованы с правилами приоритета", async () => {
    const m = req("../server/encoders");
    const hw = await m.detectAll();
    const rec = await m.recommend();
    expect([
      "nvenc",
      "qsv",
      "amf",
      "svtav1",
      "av1an",
      "rav1e",
      "x265",
      "x264",
      "nvencc",
      "qsvencc",
      "vceencc",
    ]).toContain(rec.engine);
    expect(rec.qualityMode).toBe("crf");
    expect(rec.crf).toBeGreaterThan(0);
    expect(typeof rec.speed).toBe("string");
    expect(typeof rec.hwName).toBe("string");
    expect(["gpuAv1", "cpuMulti", "gpuHevc", "compat"]).toContain(rec.reason);

    // Ветка «нет GPU и нет аппаратного энкодера» — всегда совместимость x264/h264.
    if (!hw.gpus.length && !hw.methods.nvenc && !hw.methods.svtav1) {
      expect(rec).toMatchObject({ engine: "x264", codec: "h264", reason: "compat" });
    }
    // gpuAv1/cpuMulti всегда выдают AV1, compat — H.264.
    if (rec.reason === "gpuAv1" || rec.reason === "cpuMulti") expect(rec.codec).toBe("av1");
    if (rec.reason === "compat") {
      expect(rec.engine).toBe("x264");
      expect(rec.codec).toBe("h264");
    }
    // svtav1 в рекомендации подразумевает многоядерный CPU (>8 логических потоков).
    if (rec.reason === "cpuMulti") expect(hw.cpu.coresLogical).toBeGreaterThanOrEqual(8);
    // av1an выбирается только когда бинарь реально найден.
    if (rec.engine === "av1an") expect(hw.externals.av1an).toBeTruthy();
  });
});

describe("encoders — таблицы для UI", () => {
  it("OPTIMAL: диапазоны CRF/CQP по кодекам и битрейты по разрешениям", () => {
    const m = req("../server/encoders");
    // Диапазоны — всегда пары [нижняя, верхняя] граница.
    for (const group of ["crf", "cqp", "bitrate"]) {
      for (const [codec, range] of Object.entries(m.OPTIMAL[group])) {
        expect(range.length, `${group}.${codec}`).toBe(2);
        expect(range[1], `${group}.${codec}`).toBeGreaterThanOrEqual(range[0]);
      }
    }
    // Скорость хранится шкалой энкодера (у AMF-обёртки оптимальный режим один).
    for (const [id, scale] of Object.entries(m.OPTIMAL.speed)) {
      expect(scale.length, `speed.${id}`).toBeGreaterThan(0);
    }
    expect(m.OPTIMAL.speed.amf).toEqual(["balanced"]);
    expect(m.OPTIMAL.crf.av1).toEqual([22, 28]);
    expect(m.OPTIMAL.cqp.h264).toEqual([22, 26]);
    expect(m.OPTIMAL.bitrate[1080]).toEqual([2.5, 4]);
    expect(m.OPTIMAL.bitrate[2160][1]).toBeGreaterThan(m.OPTIMAL.bitrate[1080][1]);
  });

  it("SPEED_SCALES: шкалы по энкодерам от архивного к черновому", () => {
    const m = req("../server/encoders");
    expect(m.SPEED_SCALES.x264[0]).toBe("ultrafast");
    expect(m.SPEED_SCALES.x265).toHaveLength(9);
    expect(m.SPEED_SCALES.nvenc).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
    expect(m.SPEED_SCALES.svtav1[0]).toBe("0");
    expect(m.SPEED_SCALES.amf).toEqual(["speed", "balanced", "quality"]);
    for (const [id, scale] of Object.entries(m.SPEED_SCALES)) {
      expect(scale.length, id).toBeGreaterThan(0);
      for (const v of scale) expect(typeof v, id).toBe("string");
    }
  });

  it("METHOD_FFMPEG_ENC: энкодеры ffmpeg в порядке предпочтения", () => {
    const m = req("../server/encoders");
    expect(m.METHOD_FFMPEG_ENC.x264.h264[0]).toBe("libx264");
    expect(m.METHOD_FFMPEG_ENC.svtav1.av1).toEqual(["libsvtav1"]);
    // Аппаратный AV1 умеет откатываться к HEVC/H.264 в пределах своего вендора.
    expect(m.METHOD_FFMPEG_ENC.nvenc.av1).toEqual(["av1_nvenc", "hevc_nvenc", "h264_nvenc"]);
    expect(m.METHOD_FFMPEG_ENC.qsv.hevc[0]).toBe("hevc_qsv");
    expect(m.METHOD_FFMPEG_ENC.amf.h264).toEqual(["h264_amf"]);
    // Для rav1e метод есть только на CPU-бинаре — в таблице один кодек.
    expect(Object.keys(m.METHOD_FFMPEG_ENC.rav1e)).toEqual(["av1"]);
  });
});
