/**
 * Генерация картинок: stable-diffusion.cpp (`sd-cli`) с моделями Qwen-Image 2.1 и 2.1 Turbo.
 *
 * Сборки (CPU / Vulkan / CUDA) ставятся из релиза GitHub, как сборки llama.cpp. Для запуска нужны
 * четыре вещи: сборка, диффузионная модель (GGUF в storage/models/sd), VAE (там же) и текстовый
 * энкодер Qwen3-VL 8B (GGUF в папке моделей llama — он же служит чат-моделью).
 * Видеопамяти не хватит на энкодер, диффузию и чат-модель сразу, поэтому перед запуском выгружаем
 * серверы llama.cpp, а сам sd-cli работает с `--offload-to-cpu`.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile, spawn } from "child_process";
import config from "../config";
import logger from "../logger";
import { downloadToFile } from "../download";
import { createSetupTask } from "../setupTask";
import { removePath } from "../fsUtil";
import { settled, stopServer } from "../llamacpp/engine";
import { installed, installedSd, modelPath, sdPath } from "../llamacpp/models";

const { DIRS } = config;

/** Закреплённый релиз: файлы называются по коммиту. */
export const SD_TAG = "master-975-95b3090";
const SD_COMMIT = "95b3090";
const RELEASE = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_TAG}`;
const UA = "MoonApp/1.0 (+stable-diffusion.cpp)";

export type SdBuildId = "cpu" | "vulkan" | "cuda";
export const SD_BUILD_IDS: SdBuildId[] = ["cpu", "vulkan", "cuda"];
export const isSdBuildId = (v: string): v is SdBuildId => (SD_BUILD_IDS as string[]).includes(v);

const sdRoot = (): string => path.join(DIRS.storage, "sd");
const buildDir = (id: SdBuildId): string => path.join(sdRoot(), "builds", id);
const dlDir = (): string => path.join(sdRoot(), "_dl");

interface BuildSpec {
  id: SdBuildId;
  assets: string[];
  sizeMb: number;
}

export function sdCatalog(): BuildSpec[] {
  if (process.arch !== "x64") return [];
  if (process.platform === "win32")
    return [
      { id: "cpu", assets: [`sd-master-${SD_COMMIT}-bin-win-cpu-x64.zip`], sizeMb: 17 },
      { id: "vulkan", assets: [`sd-master-${SD_COMMIT}-bin-win-vulkan-x64.zip`], sizeMb: 28 },
      {
        id: "cuda",
        assets: [`sd-master-${SD_COMMIT}-bin-win-cuda12-x64.zip`, "cudart-sd-bin-win-cu12-x64.zip"],
        sizeMb: 865,
      },
    ];
  if (process.platform === "linux")
    return [
      { id: "cpu", assets: [`sd-master-${SD_COMMIT}-bin-Linux-Ubuntu-24.04-x86_64.zip`], sizeMb: 25 },
      {
        id: "vulkan",
        assets: [`sd-master-${SD_COMMIT}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`],
        sizeMb: 35,
      },
    ];
  return [];
}

const exeNames = (): string[] =>
  process.platform === "win32" ? ["sd-cli.exe", "sd.exe"] : ["sd-cli", "sd"];

function findExe(dir: string, depth = 0): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const n of exeNames()) {
    const hit = entries.find((e) => e.isFile() && e.name === n);
    if (hit) return path.join(dir, hit.name);
  }
  if (depth >= 3) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findExe(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function sdExe(id: SdBuildId): string | null {
  if (!fs.existsSync(path.join(buildDir(id), "installed.json"))) return null;
  return findExe(buildDir(id));
}

export const installedSdBuilds = (): SdBuildId[] =>
  sdCatalog()
    .map((b) => b.id)
    .filter((id) => sdExe(id));

export const sdSetup = createSetupTask("sdcpp");

async function digests(): Promise<Record<string, string>> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/${SD_TAG}`,
      {
        headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) return {};
    const j = (await r.json()) as { assets?: { name: string; digest?: string }[] };
    const out: Record<string, string> = {};
    for (const a of j.assets ?? [])
      if (a.digest?.startsWith("sha256:")) out[a.name] = a.digest.slice(7);
    return out;
  } catch {
    return {};
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Распаковка системным tar (bsdtar читает zip): GNU tar из PATH принимает «C:» за хост. */
function extract(archive: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  return new Promise((resolve, reject) => {
    execFile(
      tar,
      ["-xf", archive, "-C", dest],
      { windowsHide: true, maxBuffer: 8 << 20 },
      (err, _o, stderr) =>
        err
          ? reject(new Error(`extract_failed: ${String(stderr || err.message).slice(0, 200)}`))
          : resolve(),
    );
  });
}

export function installSdBuild(id: SdBuildId): { ok: boolean; error?: string } {
  const spec = sdCatalog().find((b) => b.id === id);
  if (!spec) return { ok: false, error: "unsupported_platform" };
  if (sdSetup.state.state === "working") return { ok: false, error: "busy" };
  sdSetup.reset("build", id);
  void (async () => {
    const tmp = path.join(dlDir(), id);
    try {
      removePath(tmp);
      fs.mkdirSync(tmp, { recursive: true });
      const sums = await digests();
      const dest = buildDir(id);
      removePath(dest);
      fs.mkdirSync(dest, { recursive: true });
      for (let i = 0; i < spec.assets.length; i++) {
        const name = spec.assets[i];
        const file = path.join(tmp, name);
        sdSetup.state.phase = "download";
        await downloadToFile(`${RELEASE}/${name}`, file, {
          userAgent: UA,
          timeoutMs: 60 * 60 * 1000,
          shouldCancel: sdSetup.shouldCancel,
          onProgress: (p) => {
            const share = 1 / spec.assets.length;
            const frac = p.total ? p.received / p.total : 0;
            sdSetup.state.received = p.received;
            sdSetup.state.total = p.total;
            sdSetup.state.progress = Math.round((i * share + frac * share) * 90);
          },
        });
        const want = sums[name];
        if (want && (await sha256File(file)) !== want) throw new Error(`sha256_mismatch_${name}`);
        sdSetup.state.phase = "extract";
        await extract(file, dest);
        removePath(file);
      }
      if (!findExe(dest)) throw new Error("sd_cli_missing");
      fs.writeFileSync(
        path.join(dest, "installed.json"),
        JSON.stringify({ tag: SD_TAG, id, at: Date.now() }),
        "utf8",
      );
      removePath(tmp);
      logger.info("sdcpp.build_installed", { id, tag: SD_TAG });
      sdSetup.done();
    } catch (e) {
      removePath(tmp);
      removePath(buildDir(id));
      sdSetup.fail(e);
    }
  })();
  return { ok: true };
}

export function removeSdBuild(id: SdBuildId): void {
  removePath(buildDir(id));
}

// ───────────────────────────── файлы модели ─────────────────────────────

/** Диффузионные модели: GGUF в папке sd (VAE — .safetensors — не в счёт). Turbo — вперёд: быстрее. */
export function sdModels(): string[] {
  return installedSd()
    .map((m) => m.file)
    .filter((f) => /\.gguf$/i.test(f))
    .sort((a, b) => Number(/turbo/i.test(b)) - Number(/turbo/i.test(a)));
}

const vaeFile = (): string | null =>
  installedSd().find((m) => /vae.*\.safetensors$/i.test(m.file))?.file ?? null;

/** Текстовый энкодер Qwen3-VL 8B (чат-модель, не проектор); Q4_K_M — предпочтительный. */
function encoderFile(): string | null {
  const all = installed()
    .map((m) => m.file)
    .filter((f) => /^Qwen3-VL-8B-Instruct/i.test(f) && !/mmproj/i.test(f));
  return all.find((f) => /Q4_K_M/i.test(f)) ?? all[0] ?? null;
}

export interface SdStatus {
  tag: string;
  builds: { id: SdBuildId; sizeMb: number; installed: boolean }[];
  install: ReturnType<typeof sdSetup.snapshot>;
  models: string[];
  /** Всё нужное для запуска есть (сборка, модель, VAE, энкодер); иначе — чего не хватает. */
  ready: boolean;
  missing: ("build" | "model" | "vae" | "encoder")[];
  busy: boolean;
}

let running = false;

export function sdStatus(): SdStatus {
  const missing: SdStatus["missing"] = [];
  if (!installedSdBuilds().length) missing.push("build");
  if (!sdModels().length) missing.push("model");
  if (!vaeFile()) missing.push("vae");
  if (!encoderFile()) missing.push("encoder");
  return {
    tag: SD_TAG,
    builds: sdCatalog().map((b) => ({
      id: b.id,
      sizeMb: b.sizeMb,
      installed: installedSdBuilds().includes(b.id),
    })),
    install: sdSetup.snapshot(),
    models: sdModels(),
    ready: missing.length === 0,
    missing,
    busy: running,
  };
}

// ───────────────────────────── генерация ─────────────────────────────

export interface GenOptions {
  prompt: string;
  /** Файл диффузионной модели; пусто — первая установленная (Turbo впереди). */
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  device?: "auto" | "cpu" | "gpu";
  signal?: AbortSignal;
}

const snap32 = (v: number | undefined, def: number): number =>
  Math.max(256, Math.min(1536, Math.round((Number(v) || def) / 32) * 32));

function buildFor(device: GenOptions["device"]): SdBuildId | null {
  const have = installedSdBuilds();
  const order: SdBuildId[] = device === "cpu" ? ["cpu"] : ["cuda", "vulkan", "cpu"];
  return order.find((b) => have.includes(b)) ?? null;
}

/** Нарисовать картинку по тексту; ответ — PNG. Одновременно идёт только одна генерация. */
export async function generateImage(o: GenOptions): Promise<Buffer> {
  const prompt = o.prompt.trim();
  if (!prompt) throw new Error("prompt_required");
  if (running) throw new Error("sd_busy");
  const build = buildFor(o.device);
  const exe = build ? sdExe(build) : null;
  if (!build || !exe) throw new Error("sd_build_missing");
  const model = o.model && sdModels().includes(path.basename(o.model)) ? path.basename(o.model) : sdModels()[0];
  if (!model) throw new Error("sd_model_missing");
  const vae = vaeFile();
  if (!vae) throw new Error("sd_vae_missing");
  const enc = encoderFile();
  if (!enc) throw new Error("sd_encoder_missing");

  running = true;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-sd-"));
  try {
    // Чат-модель и энкодер вместе в видеопамять не влезут: освобождаем её.
    stopServer();
    await settled();
    const turbo = /turbo/i.test(model);
    const out = path.join(work, "out.png");
    const args = [
      "--diffusion-model",
      sdPath(model),
      "--vae",
      sdPath(vae),
      "--llm",
      modelPath(enc),
      "-p",
      prompt,
      "-W",
      String(snap32(o.width, 768)),
      "-H",
      String(snap32(o.height, 768)),
      "--sampling-method",
      "euler",
      ...(turbo
        ? ["--sigmas", "qwen-image-2.1-turbo", "--steps", "8", "--cfg-scale", "1.0"]
        : ["--steps", String(Math.max(8, Math.min(60, o.steps ?? 24))), "--cfg-scale", "6.0"]),
      ...(Number.isFinite(o.seed) ? ["-s", String(o.seed)] : []),
      "--offload-to-cpu",
      "-o",
      out,
    ];
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(exe, args, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "";
      const add = (d: Buffer): void => {
        tail = (tail + d.toString()).slice(-3000);
      };
      proc.stdout?.on("data", add);
      proc.stderr?.on("data", add);
      const stop = (): void => {
        proc.kill();
      };
      o.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, 45 * 60 * 1000);
      proc.once("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`spawn_failed: ${e.message}`));
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", stop);
        if (o.signal?.aborted) return reject(new Error("aborted"));
        if (code === 0 && fs.existsSync(out)) return resolve();
        const msg = tail.split("\n").filter(Boolean).slice(-4).join(" | ");
        reject(new Error(`sd_failed (${code}): ${msg.slice(0, 400)}`));
      });
    });
    logger.info("sdcpp.generated", { model, build, w: o.width, h: o.height });
    return fs.readFileSync(out);
  } finally {
    running = false;
    removePath(work);
  }
}
