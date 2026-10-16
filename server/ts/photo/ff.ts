/** Маленькие помощники ffmpeg для страницы «Фото и видео». */
import { spawn } from "child_process";
import { detectFfmpeg } from "../convertEngine";

export async function ffmpegPath(): Promise<string> {
  const ff = await detectFfmpeg();
  if (!ff.found || !ff.ffmpeg) throw new Error("ffmpeg_missing");
  return ff.ffmpeg;
}

/** Запуск ffmpeg: stdout целиком в Buffer (для сырых кадров), stderr — хвост для ошибки. */
export async function runFfmpeg(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<Buffer> {
  const bin = await ffmpegPath();
  return new Promise<Buffer>((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("ffmpeg_timeout"));
    }, opts.timeoutMs ?? 120_000);
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => {
      err = (err + b.toString()).slice(-600);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg_failed: ${err.trim() || code}`));
    });
  });
}
