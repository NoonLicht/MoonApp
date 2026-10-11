/**
 * Шумоподавление записи (ffmpeg, без нейросетей): срез низкого гула, спектральный
 * шумодав afftdn и при желании выравнивание громкости. Подходит для лекций и
 * голосовых заметок: речь становится разборчивее, а Whisper реже «слышит» шум.
 */
import { execFile } from "child_process";
import path from "path";

export type CleanLevel = "light" | "medium" | "strong";

export interface CleanOptions {
  level?: CleanLevel;
  normalize?: boolean;
}

const NR: Record<CleanLevel, number> = { light: 8, medium: 14, strong: 22 };
const HIGHPASS: Record<CleanLevel, number> = { light: 60, medium: 80, strong: 110 };

/** Цепочка фильтров ffmpeg (-af) для выбранной силы очистки. */
export function cleanFilter(opts: CleanOptions = {}): string {
  const level: CleanLevel = opts.level && opts.level in NR ? opts.level : "medium";
  const chain = [
    `highpass=f=${HIGHPASS[level]}`,
    "lowpass=f=12000",
    `afftdn=nr=${NR[level]}:nf=-30:tn=1`,
  ];
  if (opts.normalize !== false) chain.push("dynaudnorm=f=150:g=15");
  return chain.join(",");
}

/** Аргументы ffmpeg: вход → моно/стерео как есть, выход WAV 16 бит (формат выбирается расширением). */
export function cleanArgs(input: string, output: string, opts: CleanOptions = {}): string[] {
  const args = ["-hide_banner", "-y", "-i", input, "-vn", "-af", cleanFilter(opts)];
  if (/\.wav$/i.test(output)) args.push("-c:a", "pcm_s16le");
  else if (/\.mp3$/i.test(output)) args.push("-c:a", "libmp3lame", "-q:a", "2");
  args.push(output);
  return args;
}

/** Имя результата рядом с исходным: «запись.m4a» → «запись.clean.wav». */
export function outputName(original: string): string {
  const base = path.basename(original, path.extname(original)).replace(/[^\p{L}\p{N}._ -]/gu, "_") || "audio";
  return `${base}.clean.wav`;
}

export function cleanAudio(ffmpeg: string, input: string, output: string, opts: CleanOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      cleanArgs(input, output, opts),
      { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve();
        const tail = String(stderr || stdout)
          .split(/[\r\n]/)
          .filter(Boolean)
          .slice(-4)
          .join("\n");
        reject(new Error(tail || err.message));
      },
    );
  });
}
