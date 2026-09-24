/**
 * Простой редактор изображений: кроп/ресайз/водяной знак — всё через уже
 * используемый ffmpeg (server/ts/convertEngine.ts → detectFfmpeg), без
 * новой зависимости (sharp/jimp и т.п. требуют нативных биндингов, которые
 * рискованно тащить ночью без возможности проверить сборку под все таргеты).
 */
import { execFile } from "child_process";
import fs from "fs";
import { detectFfmpeg } from "./convertEngine";
import logger from "./logger";

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-hide_banner", "-y", ...args],
      { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || stdout)
            .split(/[\r\n]/)
            .filter(Boolean)
            .slice(-5)
            .join("\n");
          return reject(new Error(tail || err.message));
        }
        resolve();
      },
    );
  });
}

async function getFfmpegPath(): Promise<string> {
  const ff = await detectFfmpeg();
  if (!ff.found || !ff.path) throw new Error("ffmpeg not found");
  return ff.path;
}

export async function crop(
  inputPath: string,
  outPath: string,
  box: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const bin = await getFfmpegPath();
  const { x, y, w, h } = box;
  if (w <= 0 || h <= 0) throw new Error("invalid_box");
  await runFfmpeg(bin, ["-i", inputPath, "-vf", `crop=${w}:${h}:${x}:${y}`, outPath]);
  if (!fs.existsSync(outPath)) throw new Error("no_output_produced");
  logger.info("imageEditor.crop", { box });
}

export async function resize(
  inputPath: string,
  outPath: string,
  size: { w: number; h: number },
): Promise<void> {
  const bin = await getFfmpegPath();
  const { w, h } = size;
  if (w <= 0 || h <= 0) throw new Error("invalid_size");
  await runFfmpeg(bin, ["-i", inputPath, "-vf", `scale=${w}:${h}`, outPath]);
  if (!fs.existsSync(outPath)) throw new Error("no_output_produced");
  logger.info("imageEditor.resize", { size });
}

const POSITIONS: Record<string, string> = {
  "top-left": "10:10",
  "top-right": "main_w-overlay_w-10:10",
  "bottom-left": "10:main_h-overlay_h-10",
  "bottom-right": "main_w-overlay_w-10:main_h-overlay_h-10",
  center: "(main_w-overlay_w)/2:(main_h-overlay_h)/2",
};

export async function watermark(
  inputPath: string,
  watermarkPath: string,
  outPath: string,
  position: string,
  opacity: number,
): Promise<void> {
  const bin = await getFfmpegPath();
  const pos = POSITIONS[position] || POSITIONS["bottom-right"];
  const alpha = Math.min(1, Math.max(0.05, opacity));
  const filter = `[1:v]format=rgba,colorchannelmixer=aa=${alpha}[wm];[0:v][wm]overlay=${pos}`;
  await runFfmpeg(bin, ["-i", inputPath, "-i", watermarkPath, "-filter_complex", filter, outPath]);
  if (!fs.existsSync(outPath)) throw new Error("no_output_produced");
  logger.info("imageEditor.watermark", { position, opacity: alpha });
}
