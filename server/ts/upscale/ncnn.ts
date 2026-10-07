/**
 * Дополнительный бэкенд апскейла: Real-ESRGAN ncnn-Vulkan (xinntao). Работает на любой видеокарте
 * с Vulkan (NVIDIA, AMD, Intel) без GPU-пака onnxruntime. В каталоге моделей он появляется как
 * виртуальные модели `ncnn-<имя>`; ставится одним бандлом (exe + 5 моделей, ~45 МБ). Пока
 * обрабатывает только фото: видео идёт по кадрам внутри ONNX-пайплайна.
 */
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import config from "../config";
import logger from "../logger";
import { downloadToFile } from "../download";
import { removePath } from "../fsUtil";
import type { UpModelInfo } from "./types";

const { DIRS } = config;

const TAG = "v0.2.5.0";
const ASSET_DATE = "20220424";
const UA = "MoonApp/1.0 (+realesrgan-ncnn-vulkan)";

export const NCNN_PREFIX = "ncnn-";
export const isNcnn = (id: string): boolean => String(id).startsWith(NCNN_PREFIX);
export const ncnnName = (id: string): string => String(id).slice(NCNN_PREFIX.length);

const MODELS = [
  { name: "realesrgan-x4plus", scale: 4, label: "Real-ESRGAN x4plus (фото)", tags: ["photo"] },
  { name: "realesrgan-x4plus-anime", scale: 4, label: "Real-ESRGAN x4plus Anime", tags: ["anime"] },
  {
    name: "realesr-animevideov3-x2",
    scale: 2,
    label: "Real-ESRGAN AnimeVideo v3 ×2",
    tags: ["anime", "fast"],
  },
  {
    name: "realesr-animevideov3-x3",
    scale: 3,
    label: "Real-ESRGAN AnimeVideo v3 ×3",
    tags: ["anime", "fast"],
  },
  {
    name: "realesr-animevideov3-x4",
    scale: 4,
    label: "Real-ESRGAN AnimeVideo v3 ×4",
    tags: ["anime", "fast"],
  },
];
const SIZE_MB = 46;

function assetUrl(): string | null {
  if (process.arch !== "x64") return null;
  const os =
    process.platform === "win32" ? "windows" : process.platform === "linux" ? "ubuntu" : "";
  if (!os) return null;
  return `https://github.com/xinntao/Real-ESRGAN/releases/download/${TAG}/realesrgan-ncnn-vulkan-${ASSET_DATE}-${os}.zip`;
}

const dir = (): string => path.join(DIRS.storage, "ncnn", "realesrgan");
const exeName = (): string =>
  process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan";

function findExe(root: string, depth = 0): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === exeName()) return path.join(root, e.name);
  if (depth >= 2) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findExe(path.join(root, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function exePath(): string | null {
  if (!fs.existsSync(path.join(dir(), "installed.json"))) return null;
  return findExe(dir());
}

export const supported = (): boolean => assetUrl() !== null;

/** Виртуальные модели для каталога апскейла (скачаны — когда бандл установлен). */
export function ncnnModels(): UpModelInfo[] {
  if (!supported()) return [];
  const have = !!exePath();
  return MODELS.map((m) => ({
    id: NCNN_PREFIX + m.name,
    label: `[ncnn · Vulkan] ${m.label}`,
    kind: "upscale" as const,
    scale: m.scale,
    mult: 1,
    multMax: 1,
    arch: "ncnn",
    inputSig: "",
    batch: 1,
    align: 1,
    provider: "",
    trtEngine: "",
    file: `${m.name}.bin`,
    sizeMb: SIZE_MB,
    license: "BSD-3-Clause",
    url: assetUrl() ?? "",
    path: have ? path.join(path.dirname(exePath() as string), "models", `${m.name}.bin`) : "",
    available: have,
    onnxOnDisk: false,
    tags: ["ncnn", ...m.tags],
    rec: { scale: m.scale },
    measured: "",
    sha256: "",
    hint: "Бэкенд ncnn-Vulkan: любая видеокарта без GPU-пака. Пока только для фото.",
    downloading: null,
  }));
}

/** Установка бандла; состояние пишется в общий счётчик загрузок каталога. */
export async function installBundle(st: {
  got: number;
  total: number;
  state: string;
  error: string;
}): Promise<void> {
  const url = assetUrl();
  if (!url) throw new Error("ncnn_unsupported_platform");
  const tmp = path.join(DIRS.storage, "ncnn", "_dl");
  removePath(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, "bundle.zip");
  try {
    await downloadToFile(url, zip, {
      userAgent: UA,
      timeoutMs: 30 * 60 * 1000,
      onProgress: (p) => {
        st.got = p.received;
        st.total = p.total;
      },
    });
    const dest = dir();
    removePath(dest);
    fs.mkdirSync(dest, { recursive: true });
    // Системный bsdtar по полному пути (GNU tar из Git Bash принимает «C:» за хост).
    const tar =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "unzip";
    const args = process.platform === "win32" ? ["-xf", zip, "-C", dest] : ["-q", zip, "-d", dest];
    await new Promise<void>((resolve, reject) =>
      execFile(tar, args, { windowsHide: true }, (err, _o, stderr) =>
        err
          ? reject(new Error(`ncnn_extract_failed: ${String(stderr || err.message).slice(0, 200)}`))
          : resolve(),
      ),
    );
    const exe = findExe(dest);
    if (!exe) throw new Error("ncnn_exe_missing");
    if (process.platform !== "win32") fs.chmodSync(exe, 0o755);
    fs.writeFileSync(
      path.join(dest, "installed.json"),
      JSON.stringify({ tag: TAG, at: Date.now() }),
      "utf8",
    );
    logger.info("upscale.ncnn_installed", { tag: TAG });
  } finally {
    removePath(tmp);
  }
}

export function removeBundle(): void {
  removePath(dir());
}

export interface NcnnRun {
  input: string;
  output: string;
  /** Имя модели без префикса. */
  name: string;
  scale: number;
  onProgress?: (frac: number) => void;
  shouldStop?: () => boolean;
}

/** Один прогон realesrgan-ncnn-vulkan: проценты читаются из stderr, остановка убивает процесс. */
export function runNcnn(o: NcnnRun): Promise<void> {
  const exe = exePath();
  if (!exe) return Promise.reject(new Error("ncnn_not_installed"));
  const known = MODELS.find((m) => m.name === o.name);
  if (!known) return Promise.reject(new Error("ncnn_model_unknown"));
  const args = [
    "-i",
    o.input,
    "-o",
    o.output,
    "-n",
    known.name,
    "-s",
    String(known.scale),
    "-f",
    "png",
    "-m",
    path.join(path.dirname(exe), "models"),
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    let tail = "";
    const read = (d: Buffer): void => {
      const text = d.toString();
      tail = (tail + text).slice(-2000);
      const m = [...text.matchAll(/(\d+(?:[.,]\d+)?)%/g)].pop();
      if (m) o.onProgress?.(Math.min(1, parseFloat(m[1].replace(",", ".")) / 100));
    };
    proc.stdout?.on("data", read);
    proc.stderr?.on("data", read);
    const timer = setInterval(() => {
      if (o.shouldStop?.()) proc.kill();
    }, 300);
    proc.once("error", (e) => {
      clearInterval(timer);
      reject(e);
    });
    proc.once("close", (code) => {
      clearInterval(timer);
      if (o.shouldStop?.()) return reject(new Error("stopped"));
      if (code === 0 && fs.existsSync(o.output)) return resolve();
      reject(new Error(`ncnn_exit_${code}: ${tail.slice(-250)}`));
    });
  });
}
