import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Интерполяция кадров (плавность) на странице апскейла.
 *
 * Проверяем всё, что можно проверить без моделей, GPU и ffmpeg: точные дроби
 * частоты кадров (на 29.97 округление до 30 копит дрейф звука), сборку фильтра
 * minterpolate, кадровый план интерполяции и нормализацию новых параметров.
 */
const req = createRequire(import.meta.url);

let engine: any;
let pipe: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-interp-"));
  engine = req("../server/upscale");
  pipe = req("../server/upscalePipeline");
});

describe("частота кадров дробью", () => {
  it("parseRate понимает дробь, десятичную запись и мусор", () => {
    expect(pipe.parseRate("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(pipe.parseRate("25")).toEqual({ num: 25, den: 1 });
    expect(pipe.parseRate("23.976")).toEqual({ num: 2997, den: 125 });
    expect(pipe.parseRate("60000/1001")).toEqual({ num: 60000, den: 1001 });
    expect(pipe.parseRate("")).toEqual({ num: 0, den: 0 });
    expect(pipe.parseRate("0/0")).toEqual({ num: 0, den: 0 });
    expect(pipe.parseRate("abc")).toEqual({ num: 0, den: 0 });
    expect(pipe.parseRate(undefined)).toEqual({ num: 0, den: 0 });
  });

  it("parseFps остался прежним (регресс v1)", () => {
    expect(pipe.parseFps("30000/1001")).toBeCloseTo(29.97, 2);
    expect(pipe.parseFps("25")).toBe(25);
    expect(pipe.parseFps("")).toBe(0);
    expect(pipe.parseFps({} as unknown as string)).toBe(0);
  });

  it("outRate умножает дробь, а не округлённое число", () => {
    expect(pipe.outRate(30000, 1001, 2)).toEqual({ num: 60000, den: 1001 });
    expect(pipe.outRate(24000, 1001, 3)).toEqual({ num: 72000, den: 1001 });
    expect(pipe.outRate(25, 1, 2)).toEqual({ num: 50, den: 1 });
    expect(pipe.outRate(25, 1, 1)).toEqual({ num: 25, den: 1 });
    expect(pipe.outRate(25, 1, 0)).toEqual({ num: 25, den: 1 });
  });

  it("fpsFilterArgs даёт -vf fps=num/den и молчит на нулях", () => {
    expect(pipe.fpsFilterArgs(30000, 1001)).toEqual(["-vf", "fps=30000/1001"]);
    expect(pipe.fpsFilterArgs(25, 1)).toEqual(["-vf", "fps=25/1"]);
    expect(pipe.fpsFilterArgs(0, 0)).toEqual([]);
  });

  it("effectiveRate берёт точную пару, иначе считает из округлённой", () => {
    expect(pipe.effectiveRate(30000, 1001, 29.97)).toEqual({ num: 30000, den: 1001 });
    expect(pipe.effectiveRate(0, 0, 25)).toEqual({ num: 25, den: 1 });
    expect(pipe.effectiveRate(undefined, undefined, 23.976)).toEqual({ num: 2997, den: 125 });
    expect(pipe.effectiveRate(0, 0, 0)).toEqual({ num: 0, den: 0 });
  });
});

describe("кадровый план интерполяции", () => {
  it("planOutFrames: ×2 из 100 → 199, ×3 → 298", () => {
    expect(pipe.planOutFrames(100, 2)).toBe(199);
    expect(pipe.planOutFrames(100, 3)).toBe(298);
    expect(pipe.planOutFrames(100, 1)).toBe(100);
    expect(pipe.planOutFrames(100, 0)).toBe(100);
  });

  it("planOutFrames не падает на 0 и 1 кадре", () => {
    expect(pipe.planOutFrames(0, 2)).toBe(0);
    expect(pipe.planOutFrames(1, 2)).toBe(1);
    expect(pipe.planOutFrames(2, 4)).toBe(5);
  });

  it("insertsBefore: у первого кадра вставок нет, дальше по mult−1", () => {
    expect(pipe.insertsBefore(0, 2)).toBe(0);
    expect(pipe.insertsBefore(1, 2)).toBe(1);
    expect(pipe.insertsBefore(7, 3)).toBe(2);
    expect(pipe.insertsBefore(5, 1)).toBe(0);
  });

  it("сумма вставок совпадает с planOutFrames (иначе плывёт звук)", () => {
    for (const mult of [2, 3, 4]) {
      const perFrame = Array.from({ length: 100 }, (_, i) => 1 + pipe.insertsBefore(i, mult));
      expect(perFrame.reduce((a, b) => a + b, 0)).toBe(pipe.planOutFrames(100, mult));
    }
  });
});

describe("фильтр minterpolate", () => {
  it("mci: fps входа, оценка движения и порог смены сцены", () => {
    const f = pipe.buildMinterpolateFilter({
      mode: "mci",
      inNum: 30000,
      inDen: 1001,
      outNum: 60000,
      outDen: 1001,
      scdThreshold: 12,
    });
    expect(f).toEqual([
      "fps=30000/1001",
      "minterpolate=fps=60000/1001:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=12",
    ]);
  });

  it("blend и dup не тянут за собой оценку движения и scd", () => {
    const blend = pipe.buildMinterpolateFilter({
      mode: "blend",
      inNum: 25,
      inDen: 1,
      outNum: 50,
      outDen: 1,
      scdThreshold: 12,
    });
    expect(blend).toEqual(["fps=25/1", "minterpolate=fps=50/1:mi_mode=blend"]);
    const dup = pipe.buildMinterpolateFilter({
      mode: "dup",
      inNum: 25,
      inDen: 1,
      outNum: 50,
      outDen: 1,
      scdThreshold: 12,
    });
    expect(dup[1]).toBe("minterpolate=fps=50/1:mi_mode=dup");
  });

  it("порог сцены и search_param зажимаются в допустимый диапазон", () => {
    const f = pipe.buildMinterpolateFilter({
      mode: "mci",
      inNum: 25,
      inDen: 1,
      outNum: 100,
      outDen: 1,
      scdThreshold: 500,
      searchParam: 4,
      vsbmc: false,
    });
    expect(f[1]).toContain("scd_threshold=100");
    expect(f[1]).toContain("search_param=4");
    expect(f[1]).toContain("vsbmc=0");
    const low = pipe.buildMinterpolateFilter({
      mode: "mci",
      inNum: 25,
      inDen: 1,
      outNum: 100,
      outDen: 1,
      scdThreshold: -5,
    });
    expect(low[1]).toContain("scd_threshold=0");
    expect(low[1]).not.toContain("search_param");
  });

  it("нулевые частоты не превращаются в битый фильтр", () => {
    expect(
      pipe.buildMinterpolateFilter({
        mode: "mci",
        inNum: 0,
        inDen: 0,
        outNum: 50,
        outDen: 1,
        scdThreshold: 12,
      }),
    ).toEqual([]);
    expect(
      pipe.buildMinterpolateFilter({
        mode: "mci",
        inNum: 25,
        inDen: 1,
        outNum: 0,
        outDen: 0,
        scdThreshold: 12,
      }),
    ).toEqual([]);
  });
});

describe("аргументы ffmpeg: дробный fps и метаданные", () => {
  it("buildDecodeArgs принимает фильтры декодера", () => {
    expect(pipe.buildDecodeArgs("in.mp4")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "in.mp4",
      // -map 0:V:0 — именно видеопоток: `V` отсекает обложки (attached_pic),
      // из-за которых в пайплайн мог уйти один кадр PNG-обложки.
      "-map",
      "0:V:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    // Аппаратный декодер — отдельным аргументом перед входом (-i).
    expect(pipe.buildDecodeArgs("in.mp4", [], 0, "cuda")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-hwaccel",
      "cuda",
      "-i",
      "in.mp4",
      "-map",
      "0:V:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    expect(pipe.buildDecodeArgs("in.mp4", ["fps=25/1", "minterpolate=fps=50/1"])).toContain(
      "fps=25/1,minterpolate=fps=50/1",
    );
  });

  it("энкодер получает -r num/den и копию метаданных оригинала", () => {
    const args = pipe.buildEncodeArgs({
      fps: 60,
      fpsNum: 60000,
      fpsDen: 1001,
      outWidth: 3840,
      outHeight: 2160,
      inputPath: "in.mkv",
      outFile: "out.mkv",
      encoder: "libx265",
      qualityArgs: ["-crf", "20"],
      audioAction: "copy",
      hasSubs: true,
      metadata: true,
    });
    const s = args.join(" ");
    expect(s).toContain("-r 60000/1001");
    // Оригинал — вход №1 (вход №0 — rawvideo-поток без метаданных).
    expect(s).toContain("-map_metadata 1");
    expect(s).toContain("-map_chapters 1");
    expect(s).toContain("-c:a copy");
    expect(s).toContain("-c:s copy");
  });

  it("без дробной пары остаётся целый -r, как в v1", () => {
    const s = pipe
      .buildEncodeArgs({
        fps: 25,
        outWidth: 1920,
        outHeight: 1080,
        inputPath: "in.mp4",
        outFile: "out.mp4",
        encoder: "libx264",
        qualityArgs: ["-crf", "18"],
        audioAction: "aac",
        hasSubs: false,
      })
      .join(" ");
    expect(s).toContain("-r 25");
    expect(s).not.toContain("-map_metadata");
  });

  it("фильтры энкодера попадают в -vf (масштаб/резкость v1 тоже)", () => {
    const s = pipe
      .buildEncodeArgs({
        fps: 25,
        outWidth: 3840,
        outHeight: 2160,
        inputPath: "in.mp4",
        outFile: "out.mp4",
        encoder: "libx264",
        qualityArgs: ["-crf", "18"],
        audioAction: "copy",
        hasSubs: false,
        filters: ["scale=3840:2160:flags=lanczos", "unsharp=5:5:1.00:5:5:0"],
      })
      .join(" ");
    expect(s).toContain("-vf scale=3840:2160:flags=lanczos,unsharp=5:5:1.00:5:5:0");
  });
});

describe("параметры интерполяции в задании", () => {
  it("normalizeParams задаёт дефолты плавности", () => {
    const p = engine.normalizeParams({});
    expect(p.interpMode).toBe("off");
    expect(p.interpMult).toBe(2);
    expect(p.minterpolateMode).toBe("mci");
    expect(p.minterpolateSide).toBe("decode");
    expect(p.sceneCutThreshold).toBe(12);
  });

  it("normalizeParams чинит неизвестные значения и клампует диапазоны", () => {
    const p = engine.normalizeParams({
      interpMode: "magic",
      interpMult: 99,
      minterpolateMode: "warp",
      minterpolateSide: "middle",
      sceneCutThreshold: 1000,
    });
    expect(p.interpMode).toBe("off");
    expect(p.interpMult).toBe(engine.MAX_INTERP_MULT);
    expect(p.minterpolateMode).toBe("mci");
    expect(p.minterpolateSide).toBe("decode");
    expect(p.sceneCutThreshold).toBe(100);

    const q = engine.normalizeParams({
      interpMode: "ffmpeg",
      interpMult: 1,
      minterpolateMode: "blend",
      minterpolateSide: "encode",
      sceneCutThreshold: -3,
    });
    expect(q.interpMode).toBe("ffmpeg");
    expect(q.interpMult).toBe(2); // ниже ×2 смысла нет — это просто исходный fps
    expect(q.minterpolateMode).toBe("blend");
    expect(q.minterpolateSide).toBe("encode");
    expect(q.sceneCutThreshold).toBe(0);
  });

  it("пресет плавности собран и указывает корректные поля", () => {
    const smooth = engine.SYSTEM_PRESETS.find((p: any) => p.id === "video-smooth60");
    expect(smooth).toBeTruthy();
    expect(smooth.kind).toBe("video");
    expect(smooth.interpMode).toBe("ffmpeg");
    expect(smooth.interpMult).toBe(2);
    expect(smooth.minterpolateSide).toBe("decode");
    // Пресет должен проходить через ту же нормализацию, что и запрос из UI.
    const p = engine.normalizeParams({ ...smooth, presetId: smooth.id });
    expect(p.interpMode).toBe("ffmpeg");
    expect(p.interpMult).toBe(2);
  });

  it("MAX_INTERP_MULT экспортируется и совпадает с клампом", () => {
    expect(pipe.MAX_INTERP_MULT).toBe(4);
    expect(engine.MAX_INTERP_MULT).toBe(pipe.MAX_INTERP_MULT);
  });
});
