import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ocr-"));
process.env.MOONAPP_STORAGE = storage;

const engine: typeof import("../server/ocr") = req("../server/ocr");

const { detectFfmpeg } = req("../server/convertEngine") as {
  detectFfmpeg(): Promise<{ found: boolean; ffmpeg: string | null }>;
};
const ffDetected = await detectFfmpeg();
const ffmpegBin: string | null = ffDetected.found ? ffDetected.ffmpeg : null;

function makeTextImage(text: string): string {
  if (!ffmpegBin) throw new Error("ffmpeg not found for test setup");
  const out = path.join(storage, "text.png");
  const fontfile = "C\\:/Windows/Fonts/arial.ttf";
  execFileSync(
    ffmpegBin,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=500x120",
      "-vf",
      `drawtext=text='${text}':fontcolor=black:fontsize=36:x=20:y=40:fontfile='${fontfile}'`,
      "-frames:v",
      "1",
      out,
    ],
    { stdio: "ignore" },
  );
  return out;
}

afterAll(async () => {
  await engine.terminate();
});

describe("server/ocr — реальное распознавание текста (tesseract.js)", () => {
  it.runIf(!!ffmpegBin)(
    "распознаёт сгенерированную ffmpeg картинку с текстом (реальный движок, без мока)",
    async () => {
      const imgPath = makeTextImage("HELLO OCR TEST 123");
      const buf = fs.readFileSync(imgPath);
      const r = await engine.recognize(buf);
      expect(r.text.toUpperCase()).toContain("HELLO");
      expect(r.text.toUpperCase()).toContain("OCR");
      expect(r.confidence).toBeGreaterThan(50);
    },
    60000,
  );

  it.runIf(!!ffmpegBin)(
    "повторный вызов переиспользует уже созданный воркер (не падает, быстрее первого)",
    async () => {
      const imgPath = makeTextImage("SECOND RUN");
      const buf = fs.readFileSync(imgPath);
      const started = Date.now();
      const r = await engine.recognize(buf);
      expect(r.text.toUpperCase()).toContain("SECOND");
      expect(Date.now() - started).toBeLessThan(10000); // без повторной загрузки модели — быстро
    },
    30000,
  );
});
