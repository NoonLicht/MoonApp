/**
 * Замена лица: Deep-Live-Cam (AGPL-3.0) в режиме командной строки.
 * Фото/видео — `run.py -s лицо -t цель -o результат`; живая камера — окно самого Deep-Live-Cam.
 */
import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import * as py from "./pyTool";
import * as jobs from "./jobs";
import { PHOTO_DIR } from "./modelStore";

export interface SwapOptions {
  source: string;
  target: string;
  device?: "cuda" | "cpu";
  enhance?: boolean;
  manyFaces?: boolean;
  mouthMask?: boolean;
  /** CRF видео 0–51 (меньше — лучше). */
  quality?: number;
}

export const isVideo = (f: string): boolean => /\.(mp4|mkv|mov|avi|webm)$/i.test(f);

export function buildArgs(o: SwapOptions, out: string): string[] {
  const args = [
    "run.py",
    "-s",
    o.source,
    "-t",
    o.target,
    "-o",
    out,
    "--frame-processor",
    "face_swapper",
    ...(o.enhance ? ["face_enhancer"] : []),
    "--execution-provider",
    o.device === "cpu" ? "cpu" : "cuda",
    "--keep-fps",
    "--keep-audio",
  ];
  if (o.manyFaces) args.push("--many-faces");
  if (o.mouthMask) args.push("--mouth-mask");
  if (isVideo(o.target)) {
    const q = Math.max(0, Math.min(51, Math.round(Number(o.quality) || 18)));
    args.push("--video-quality", String(q));
  }
  return args;
}

export function start(o: SwapOptions): jobs.PhotoJob {
  const video = isVideo(o.target);
  const tmpDir = path.join(PHOTO_DIR, "tmp", `swap_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext = video ? ".mp4" : path.extname(o.target).toLowerCase() === ".jpg" ? ".jpg" : ".png";
  const out = path.join(tmpDir, `result${ext}`);
  return jobs.start({
    tool: "faceswap",
    args: buildArgs(o, out),
    outName: `swap_${Date.now()}${ext}`,
    stages: [
      [/download/i, "download"],
      [/Processing|processing|frame/i, "infer"],
      [/Creating video|ffmpeg|Restoring audio/i, "encode"],
    ],
    result: () => (fs.existsSync(out) ? out : null),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  });
}

let live: ChildProcess | null = null;

export const liveRunning = (): boolean => !!live && live.exitCode == null;

/** Окно Deep-Live-Cam с камерой (интерфейс самого проекта). */
export function startLive(device: "cuda" | "cpu" = "cuda"): void {
  if (liveRunning()) return;
  const proc = spawn(
    py.pythonExe("faceswap"),
    ["run.py", "--execution-provider", device === "cpu" ? "cpu" : "cuda"],
    { cwd: py.repoDir("faceswap"), windowsHide: false, stdio: "ignore" },
  );
  proc.on("exit", () => {
    if (live === proc) live = null;
  });
  live = proc;
}

export function stopLive(): void {
  if (live) py.killTree(live);
  live = null;
}

export const ready = (): Promise<{ ready: boolean; missing: string[] }> => py.check("faceswap");
