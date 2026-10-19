/**
 * ComfyUI внутри приложения: установка портативной сборки, запуск и остановка собственного процесса.
 *
 * Берём официальную портативную сборку Windows (Python и torch внутри), поэтому системный Python не
 * нужен. Данные пользователя (модели, входные и выходные файлы, воркфлоу) лежат в storage/comfy
 * и не стираются при переустановке: ComfyUI запускается с ключами `--*-directory` и общим
 * `extra_model_paths.yaml`. Папки GGUF-моделей llama.cpp и stable-diffusion.cpp подключены как
 * источники моделей, поэтому Qwen-Image и энкодер, скачанные в панели llama.cpp, видны и тут.
 *
 * Сам интерфейс ComfyUI и его API приложение отдаёт через прокси (см. proxy.ts) — тот же origin,
 * токен приложения и свой дизайн вокруг.
 */
import fs from "fs";
import net from "net";
import path from "path";
import { execFile, spawn, type ChildProcess } from "child_process";
import AdmZip from "adm-zip";
import config from "../config";
import logger from "../logger";
import { downloadToFile } from "../download";
import { createSetupTask } from "../setupTask";
import { removePath } from "../fsUtil";
import { modelsDir, settled, stopServer } from "../llamacpp/engine";
import { sdModelsDir } from "../llamacpp/models";

const { DIRS } = config;
const UA = "MoonApp/1.0 (+ComfyUI)";
const RELEASE = "https://github.com/Comfy-Org/ComfyUI/releases/latest/download";
const GGUF_NODE_ZIP = "https://github.com/leejet/ComfyUI-GGUF/archive/refs/heads/main.zip";

export type ComfyFlavor = "nvidia" | "amd" | "intel";
export const COMFY_FLAVORS: { id: ComfyFlavor; sizeMb: number }[] = [
  { id: "nvidia", sizeMb: 2018 },
  { id: "amd", sizeMb: 1636 },
  { id: "intel", sizeMb: 1451 },
];
export const isFlavor = (v: string): v is ComfyFlavor => COMFY_FLAVORS.some((f) => f.id === v);

/** Подпапки моделей ComfyUI, которыми управляет приложение. */
export const MODEL_FOLDERS = [
  "checkpoints",
  "diffusion_models",
  "text_encoders",
  "vae",
  "loras",
  "controlnet",
  "upscale_models",
  "clip_vision",
  "embeddings",
] as const;
export type ModelFolder = (typeof MODEL_FOLDERS)[number];
export const isModelFolder = (v: string): v is ModelFolder =>
  (MODEL_FOLDERS as readonly string[]).includes(v);

export const comfyRoot = (): string => path.join(DIRS.storage, "comfy");
const installDir = (): string => path.join(comfyRoot(), "app");
export const comfyModelsDir = (): string => path.join(comfyRoot(), "models");
const dataDir = (k: "user" | "input" | "output" | "temp"): string => path.join(comfyRoot(), k);
export const outputDir = (): string => dataDir("output");
const dlDir = (): string => path.join(comfyRoot(), "_dl");
const metaFile = (): string => path.join(installDir(), "moonapp-install.json");

export const comfySetup = createSetupTask("comfy");

export const supported = (): boolean => process.platform === "win32" && process.arch === "x64";

/**
 * Корень сборки. Верхняя папка архива («ComfyUI_windows_portable») срезается при распаковке: самые
 * длинные пути внутри torch достигают ≈165 знаков, а встроенный Python не открывает пути длиннее
 * 260 символов, поэтому каждый лишний сегмент пути важен (см. checkPathLength).
 */
function portableRoot(): string | null {
  const d = installDir();
  return fs.existsSync(path.join(d, "python_embeded", "python.exe")) && fs.existsSync(path.join(d, "ComfyUI", "main.py"))
    ? d
    : null;
}

/** Самый длинный путь внутри сборки (с запасом) + путь установки должны влезать в MAX_PATH. */
const LONGEST_INSIDE = 170;
export function checkPathLength(): void {
  if (installDir().length + LONGEST_INSIDE > 259) throw new Error("path_too_long");
}

interface InstallMeta {
  flavor: ComfyFlavor;
  at: number;
}
function readMeta(): InstallMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), "utf8")) as InstallMeta;
  } catch {
    return null;
  }
}

export const isInstalled = (): boolean => !!portableRoot() && !!readMeta();
const pythonExe = (): string => path.join(portableRoot() ?? "", "python_embeded", "python.exe");
const customNodes = (): string => path.join(portableRoot() ?? "", "ComfyUI", "custom_nodes");
export const ggufNodeInstalled = (): boolean =>
  fs.existsSync(path.join(customNodes(), "ComfyUI-GGUF", "nodes.py"));

function extract(archive: string, dest: string, strip = 0): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xf", archive, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])], { windowsHide: true, maxBuffer: 16 << 20 }, (err, _o, stderr) =>
      err ? reject(new Error(`extract_failed: ${String(stderr || err.message).slice(0, 200)}`)) : resolve(),
    );
  });
}

function run(exe: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { cwd, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve(String(out))),
    );
  });
}

// ───────────────────────────── установка ─────────────────────────────

export function installComfy(flavor: ComfyFlavor): { ok: boolean; error?: string } {
  if (!supported()) return { ok: false, error: "unsupported_platform" };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  if (running()) return { ok: false, error: "running" };
  comfySetup.reset("comfy", flavor);
  void (async () => {
    const name = `ComfyUI_windows_portable_${flavor}.7z`;
    const file = path.join(dlDir(), name);
    try {
      removePath(dlDir());
      fs.mkdirSync(dlDir(), { recursive: true });
      comfySetup.state.phase = "download";
      await downloadToFile(`${RELEASE}/${name}`, file, {
        userAgent: UA,
        timeoutMs: 2 * 60 * 60 * 1000,
        shouldCancel: comfySetup.shouldCancel,
        onProgress: (p) => {
          comfySetup.state.received = p.received;
          comfySetup.state.total = p.total;
          comfySetup.state.progress = p.total ? Math.round((p.received / p.total) * 85) : 0;
        },
      });
      comfySetup.state.phase = "extract";
      comfySetup.state.progress = 88;
      checkPathLength();
      removePath(installDir());
      await extract(file, installDir(), 1);
      removePath(dlDir());
      if (!portableRoot()) throw new Error("comfy_layout_unexpected");
      fs.writeFileSync(metaFile(), JSON.stringify({ flavor, at: Date.now() }), "utf8");
      writeModelPaths();
      comfySetup.state.progress = 100;
      logger.info("comfy.installed", { flavor });
      comfySetup.done();
    } catch (e) {
      removePath(dlDir());
      removePath(installDir());
      comfySetup.fail(e);
    }
  })();
  return { ok: true };
}

/** Узел ComfyUI-GGUF (форк leejet с Qwen-Image 2.1): загрузчики GGUF-моделей и энкодеров. */
export function installGgufNode(): { ok: boolean; error?: string } {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  if (running()) return { ok: false, error: "running" };
  comfySetup.reset("gguf-node", null);
  void (async () => {
    const zip = path.join(dlDir(), "ComfyUI-GGUF.zip");
    try {
      removePath(dlDir());
      fs.mkdirSync(dlDir(), { recursive: true });
      comfySetup.state.phase = "download";
      await downloadToFile(GGUF_NODE_ZIP, zip, {
        userAgent: UA,
        shouldCancel: comfySetup.shouldCancel,
        onProgress: (p) => {
          comfySetup.state.received = p.received;
          comfySetup.state.total = p.total;
          comfySetup.state.progress = p.total ? Math.round((p.received / p.total) * 30) : 0;
        },
      });
      comfySetup.state.phase = "extract";
      const tmp = path.join(dlDir(), "x");
      new AdmZip(zip).extractAllTo(tmp, true);
      const inner = fs.readdirSync(tmp).find((d) => fs.existsSync(path.join(tmp, d, "nodes.py")));
      if (!inner) throw new Error("gguf_node_layout");
      const dest = path.join(customNodes(), "ComfyUI-GGUF");
      removePath(dest);
      fs.mkdirSync(customNodes(), { recursive: true });
      fs.renameSync(path.join(tmp, inner), dest);
      comfySetup.state.phase = "pip";
      comfySetup.state.progress = 50;
      await run(pythonExe(), ["-s", "-m", "pip", "install", "--no-warn-script-location", "gguf", "sentencepiece", "protobuf"], portableRoot() ?? ".");
      removePath(dlDir());
      logger.info("comfy.gguf_node_installed");
      comfySetup.done();
    } catch (e) {
      removePath(dlDir());
      comfySetup.fail(e);
    }
  })();
  return { ok: true };
}

export function removeComfy(): void {
  if (running()) stopComfy();
  removePath(installDir());
}

// ───────────────────────────── пути моделей ─────────────────────────────

/** YAML-путь: прямые слеши, без кавычек-проблем в Windows-путях. */
const y = (p: string): string => p.replace(/\\/g, "/");

export function writeModelPaths(): string {
  const base = comfyModelsDir();
  for (const f of MODEL_FOLDERS) fs.mkdirSync(path.join(base, f), { recursive: true });
  for (const k of ["user", "input", "output", "temp"] as const) fs.mkdirSync(dataDir(k), { recursive: true });
  const sd = sdModelsDir();
  const llama = modelsDir();
  fs.mkdirSync(sd, { recursive: true });
  const yaml = [
    "moonapp:",
    `  base_path: ${y(base)}/`,
    "  checkpoints: checkpoints/",
    `  diffusion_models: |\n    diffusion_models/\n    ${y(sd)}/`,
    `  unet: |\n    diffusion_models/\n    ${y(sd)}/`,
    `  text_encoders: |\n    text_encoders/\n    ${y(llama)}/`,
    `  clip: |\n    text_encoders/\n    ${y(llama)}/`,
    // VAE из папки sd (формат diffusers для stable-diffusion.cpp) ComfyUI не читает: у него свой файл с тем же именем.
    "  vae: vae/",
    "  loras: loras/",
    "  controlnet: controlnet/",
    "  upscale_models: upscale_models/",
    "  clip_vision: clip_vision/",
    "  embeddings: embeddings/",
    "",
  ].join("\n");
  const file = path.join(comfyRoot(), "extra_model_paths.yaml");
  fs.mkdirSync(comfyRoot(), { recursive: true });
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

// ───────────────────────────── процесс ─────────────────────────────

let child: ChildProcess | null = null;
let port = 0;
let ready = false;
let exitNote = "";
const logLines: string[] = [];

const pushLog = (chunk: Buffer): void => {
  for (const l of chunk.toString("utf8").split(/\r?\n/)) {
    if (!l.trim()) continue;
    logLines.push(l.slice(0, 400));
    if (logLines.length > 300) logLines.shift();
  }
};

export const running = (): boolean => !!child && child.exitCode === null && !child.killed;
export const comfyPort = (): number => (running() ? port : 0);
export const comfyReady = (): boolean => running() && ready;

function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => {
      const t = net.createServer();
      t.listen(0, "127.0.0.1", () => {
        const p = (t.address() as net.AddressInfo).port;
        t.close(() => resolve(p));
      });
    });
    s.listen(preferred, "127.0.0.1", () => s.close(() => resolve(preferred)));
  });
}

async function probe(p: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startComfy(opts: { cpu?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  if (running()) return { ok: true };
  if (comfySetup.state.state === "working") return { ok: false, error: "busy" };
  const root = portableRoot() as string;
  const yaml = writeModelPaths();
  port = await freePort(8188);
  ready = false;
  exitNote = "";
  logLines.length = 0;
  const args = [
    "-s",
    path.join("ComfyUI", "main.py"),
    "--windows-standalone-build",
    "--listen",
    "127.0.0.1",
    "--port",
    String(port),
    "--disable-auto-launch",
    "--extra-model-paths-config",
    yaml,
    "--user-directory",
    dataDir("user"),
    "--input-directory",
    dataDir("input"),
    "--output-directory",
    dataDir("output"),
    "--temp-directory",
    dataDir("temp"),
    ...(opts.cpu ? ["--cpu"] : []),
  ];
  const p = spawn(pythonExe(), args, {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  child = p;
  p.stdout?.on("data", pushLog);
  p.stderr?.on("data", pushLog);
  p.on("error", (e) => {
    exitNote = e.message;
  });
  p.on("exit", (code) => {
    if (child === p) {
      exitNote = code === 0 || code === null ? "" : `exit_${code}`;
      ready = false;
    }
    logger.info("comfy.exit", { code });
  });
  void (async () => {
    for (let i = 0; i < 300 && child === p && p.exitCode === null; i++) {
      if (await probe(port)) {
        ready = true;
        logger.info("comfy.ready", { port });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return { ok: true };
}

/** Останавливает только свой процесс ComfyUI (и его дочерние), чужие не трогает. */
export function stopComfy(): void {
  const p = child;
  if (!p || p.exitCode !== null) return;
  ready = false;
  if (p.pid) {
    execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
  try {
    p.kill();
  } catch {
    /* уже завершён */
  }
}

export interface ComfyStatus {
  supported: boolean;
  installed: boolean;
  flavor: ComfyFlavor | null;
  running: boolean;
  ready: boolean;
  port: number;
  gguf: boolean;
  error: string;
  log: string[];
  setup: ReturnType<typeof comfySetup.snapshot>;
  flavors: { id: ComfyFlavor; sizeMb: number }[];
}

export function comfyStatus(): ComfyStatus {
  const meta = isInstalled() ? readMeta() : null;
  return {
    supported: supported(),
    installed: !!meta,
    flavor: meta?.flavor ?? null,
    running: running(),
    ready: comfyReady(),
    port: comfyPort(),
    gguf: isInstalled() && ggufNodeInstalled(),
    error: exitNote,
    log: logLines.slice(-40),
    setup: comfySetup.snapshot(),
    flavors: COMFY_FLAVORS,
  };
}

// ───────────────────────────── видеопамять ─────────────────────────────
// На 8 ГБ чат-модель и ComfyUI вместе не помещаются: перед работой одного освобождаем память другого.

/** Просит ComfyUI выгрузить модели из видеопамяти (процесс остаётся запущенным). */
export async function freeComfyGpu(): Promise<void> {
  if (!comfyReady()) return;
  try {
    await fetch(`http://127.0.0.1:${comfyPort()}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10000),
    });
    // ComfyUI выгружает на следующем такте очереди, даём ему секунду.
    await new Promise((r) => setTimeout(r, 1200));
  } catch {
    /* ComfyUI занят — не страшно */
  }
}

/** Выгружает чат-модели llama.cpp, чтобы ComfyUI получил всю видеопамять. */
export async function freeLlamaGpu(): Promise<void> {
  stopServer();
  await settled();
}
