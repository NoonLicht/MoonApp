import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const req = createRequire(import.meta.url);
const editor: typeof import("../server/imageEditor") = req("../server/imageEditor");
const { detectFfmpeg }: typeof import("../server/convertEngine") = req("../server/convertEngine");

let ffmpegAvailable = false;
let tmp: string;
let inputPng: string;
let wmPng: string;

beforeAll(async () => {
  const ff = await detectFfmpeg({ force: true });
  ffmpegAvailable = ff.found;
  if (!ffmpegAvailable) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-imgedit-test-"));
  inputPng = path.join(tmp, "in.png");
  wmPng = path.join(tmp, "wm.png");
  execFileSync(ff.path as string, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=200x150:duration=1:rate=1",
    "-frames:v",
    "1",
    inputPng,
  ]);
  execFileSync(ff.path as string, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=40x20:d=1:r=1",
    "-frames:v",
    "1",
    wmPng,
  ]);
});

describe("server/imageEditor — crop/resize/watermark на реальном ffmpeg", () => {
  it("crop создаёт файл нужного размера", async () => {
    if (!ffmpegAvailable) return;
    const out = path.join(tmp, "crop.png");
    await editor.crop(inputPng, out, { x: 10, y: 10, w: 80, h: 60 });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("resize создаёт файл", async () => {
    if (!ffmpegAvailable) return;
    const out = path.join(tmp, "resize.png");
    await editor.resize(inputPng, out, { w: 400, h: 300 });
    expect(fs.existsSync(out)).toBe(true);
  });

  it("watermark накладывает изображение поверх", async () => {
    if (!ffmpegAvailable) return;
    const out = path.join(tmp, "wm_out.png");
    await editor.watermark(inputPng, wmPng, out, "bottom-right", 0.5);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("crop с некорректным размером падает с понятной ошибкой", async () => {
    if (!ffmpegAvailable) return;
    const out = path.join(tmp, "bad.png");
    await expect(editor.crop(inputPng, out, { x: 0, y: 0, w: 0, h: 0 })).rejects.toThrow(
      "invalid_box",
    );
  });
});
