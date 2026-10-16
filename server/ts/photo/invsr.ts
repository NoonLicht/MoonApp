/** InvSR: диффузионный апскейл ×4 (SD-Turbo) — запуск inference_invsr.py из изолированного окружения. */
import fs from "fs";
import path from "path";
import * as py from "./pyTool";
import * as jobs from "./jobs";
import { PHOTO_DIR } from "./modelStore";

export interface InvsrOptions {
  input: string;
  /** Шаги семплирования 1–5: 1 — быстро, 3–5 — детальнее. */
  steps?: number;
  /** Размер тайла для больших картинок (меньше — меньше памяти). */
  tile?: number;
  colorFix?: "" | "wavelet" | "ycbcr";
}

export const WEIGHTS_DIR = path.join(PHOTO_DIR, "invsr-weights");

export function buildArgs(o: InvsrOptions, outDir: string): string[] {
  const steps = Math.max(1, Math.min(5, Math.round(Number(o.steps) || 1)));
  const tile = [128, 192, 256, 384, 512].includes(Number(o.tile)) ? Number(o.tile) : 256;
  const args = [
    "inference_invsr.py",
    "-i",
    o.input,
    "-o",
    outDir,
    "--num_steps",
    String(steps),
    "--chopping_size",
    String(tile),
    "--chopping_bs",
    "1",
    "--tiled_vae",
    "true",
    "--sd_path",
    WEIGHTS_DIR,
  ];
  if (o.colorFix === "wavelet" || o.colorFix === "ycbcr") args.push("--color_fix", o.colorFix);
  return args;
}

export function start(o: InvsrOptions): jobs.PhotoJob {
  fs.mkdirSync(WEIGHTS_DIR, { recursive: true });
  const outDir = path.join(PHOTO_DIR, "tmp", `invsr_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  return jobs.start({
    tool: "invsr",
    args: buildArgs(o, outDir),
    outName: `invsr_${Date.now()}.png`,
    stages: [
      [/Downloading|download/i, "download"],
      [/Loading|loading/i, "load"],
      [/Processing|Inference|inference/i, "infer"],
    ],
    result: () => {
      const f = fs.readdirSync(outDir).find((n) => /\.(png|jpg|jpeg|webp)$/i.test(n));
      return f ? path.join(outDir, f) : null;
    },
    cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }),
  });
}

export const ready = (): Promise<{ ready: boolean; missing: string[] }> => py.check("invsr");
