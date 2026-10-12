import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Шумоподавление записи (server/ts/audioClean.ts). */
const req = createRequire(import.meta.url);
let ac: any;
beforeAll(() => {
  ac = req("../server/audioClean");
});

describe("audioClean", () => {
  it("сила очистки меняет параметры фильтра", () => {
    expect(ac.cleanFilter({ level: "light" })).toContain("highpass=f=60");
    expect(ac.cleanFilter({ level: "light" })).toContain("afftdn=nr=8");
    expect(ac.cleanFilter({ level: "strong" })).toContain("afftdn=nr=22");
  });

  it("по умолчанию — средняя сила с выравниванием громкости", () => {
    const f = ac.cleanFilter();
    expect(f).toContain("afftdn=nr=14");
    expect(f).toContain("dynaudnorm");
    expect(ac.cleanFilter({ normalize: false })).not.toContain("dynaudnorm");
  });

  it("неизвестный уровень заменяется средним", () => {
    expect(ac.cleanFilter({ level: "x" })).toContain("afftdn=nr=14");
  });

  it("аргументы ffmpeg: кодек по расширению, результат последним", () => {
    const wav = ac.cleanArgs("in.m4a", "out.wav");
    expect(wav).toContain("pcm_s16le");
    expect(wav[wav.length - 1]).toBe("out.wav");
    expect(wav).toContain("-vn");
    expect(ac.cleanArgs("in.m4a", "out.mp3")).toContain("libmp3lame");
  });

  it("имя результата безопасно", () => {
    expect(ac.outputName("C:/x/лекция 1.m4a")).toBe("лекция 1.clean.wav");
    expect(ac.outputName("a<b>.mp3")).toBe("a_b_.clean.wav");
  });
});
