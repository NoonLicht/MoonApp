/**
 * Встроенный llama.cpp: сборки `llama-server` (CPU / Vulkan / CUDA), их установка и запуск.
 *
 * Одна общая точка для всех страниц с языковыми моделями: переводчик, чат, конспекты лекций,
 * заметки. Сервер поднимается по требованию на свободном локальном порту, держит одну модель
 * и выгружается после простоя. Vulkan работает на видеокартах NVIDIA, AMD и Intel без драйверных
 * SDK, поэтому он рекомендуемый; CUDA быстрее на NVIDIA, но тяжелее (нужны ещё библиотеки CUDA).
 */
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { execFile, spawn, type ChildProcess } from "child_process";
import config from "../config";
import logger from "../logger";
import { downloadToFile } from "../download";
import { createSetupTask } from "../setupTask";
import { removePath } from "../fsUtil";

const { DIRS } = config;

/** Закреплённая версия: сборки llama.cpp выходят по несколько раз в день. */
export const LLAMA_TAG = "b11476";
const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;
const UA = "MoonApp/1.0 (+llama.cpp)";

export type BuildId = "cpu" | "vulkan" | "cuda";
export const BUILD_IDS: BuildId[] = ["cpu", "vulkan", "cuda"];
export const isBuildId = (v: string): v is BuildId => (BUILD_IDS as string[]).includes(v);

export const llamaDir = (): string => path.join(DIRS.storage, "llama");
const buildsDir = (): string => path.join(llamaDir(), "builds");
const dlDir = (): string => path.join(llamaDir(), "_dl");
export const modelsDir = (): string => path.join(DIRS.storage, "models", "llama");

interface BuildSpec {
  id: BuildId;
  /** Имена архивов релиза (для CUDA — ещё и библиотеки CUDA). */
  assets: string[];
  sizeMb: number;
}

/** Каталог сборок под текущую платформу; пустой — если готовых сборок нет. */
export function catalog(): BuildSpec[] {
  if (process.arch !== "x64") return [];
  if (process.platform === "win32") {
    return [
      { id: "cpu", assets: [`llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`], sizeMb: 19 },
      { id: "vulkan", assets: [`llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`], sizeMb: 33 },
      {
        id: "cuda",
        assets: [
          `llama-${LLAMA_TAG}-bin-win-cuda-13.4-x64.zip`,
          "cudart-llama-bin-win-cuda-13.4-x64.zip",
        ],
        sizeMb: 577,
      },
    ];
  }
  if (process.platform === "linux") {
    return [
      { id: "cpu", assets: [`llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`], sizeMb: 18 },
      { id: "vulkan", assets: [`llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`], sizeMb: 32 },
      {
        id: "cuda",
        assets: [
          `llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
          `cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
        ],
        sizeMb: 593,
      },
    ];
  }
  return [];
}

const exeName = (): string => (process.platform === "win32" ? "llama-server.exe" : "llama-server");
const buildDir = (id: BuildId): string => path.join(buildsDir(), id);

function findExe(dir: string, depth = 0): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === exeName()) return path.join(dir, e.name);
  if (depth >= 3) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findExe(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Путь к llama-server установленной сборки (с проверкой маркера завершённой установки). */
export function exePath(id: BuildId): string | null {
  if (!fs.existsSync(path.join(buildDir(id), "installed.json"))) return null;
  return findExe(buildDir(id));
}

export function installedBuilds(): BuildId[] {
  return catalog()
    .map((b) => b.id)
    .filter((id) => exePath(id));
}

// ───────────────────────────── установка ─────────────────────────────

export const setup = createSetupTask("llamacpp");

async function assetDigests(): Promise<Record<string, string>> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_TAG}`,
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

/** Распаковка системным tar: bsdtar в Windows 10+ читает и zip, потоково и без загрузки в память. */
function extract(archive: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const args = archive.endsWith(".zip")
    ? ["-xf", archive, "-C", dest]
    : ["-xzf", archive, "-C", dest];
  return new Promise((resolve, reject) => {
    // В Windows берём системный bsdtar по полному пути: GNU tar из PATH (Git Bash) принимает «C:» за хост.
    const tar =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
    execFile(tar, args, { windowsHide: true, maxBuffer: 8 << 20 }, (err, _o, stderr) =>
      err
        ? reject(new Error(`extract_failed: ${String(stderr || err.message).slice(0, 200)}`))
        : resolve(),
    );
  });
}

export function installBuild(id: BuildId): { ok: boolean; error?: string } {
  const spec = catalog().find((b) => b.id === id);
  if (!spec) return { ok: false, error: "unsupported_platform" };
  if (setup.state.state === "working") return { ok: false, error: "busy" };
  setup.reset("build", id);
  void (async () => {
    const tmp = path.join(dlDir(), id);
    try {
      removePath(tmp);
      fs.mkdirSync(tmp, { recursive: true });
      const digests = await assetDigests();
      const dest = buildDir(id);
      removePath(dest);
      fs.mkdirSync(dest, { recursive: true });
      for (let i = 0; i < spec.assets.length; i++) {
        const name = spec.assets[i];
        const file = path.join(tmp, name);
        setup.state.phase = "download";
        await downloadToFile(`${RELEASE}/${name}`, file, {
          userAgent: UA,
          timeoutMs: 60 * 60 * 1000,
          shouldCancel: setup.shouldCancel,
          onProgress: (p) => {
            // Прогресс считаем по всем архивам сборки вместе.
            const share = 1 / spec.assets.length;
            const frac = p.total ? p.received / p.total : 0;
            setup.state.received = p.received;
            setup.state.total = p.total;
            setup.state.progress = Math.round((i * share + frac * share) * 90);
          },
        });
        const want = digests[name];
        if (want && (await sha256File(file)) !== want) throw new Error(`sha256_mismatch_${name}`);
        setup.state.phase = "extract";
        await extract(file, dest);
        removePath(file);
      }
      if (!findExe(dest)) throw new Error("llama_server_missing");
      fs.writeFileSync(
        path.join(dest, "installed.json"),
        JSON.stringify({ tag: LLAMA_TAG, id, at: Date.now() }),
        "utf8",
      );
      removePath(tmp);
      logger.info("llamacpp.build_installed", { id, tag: LLAMA_TAG });
      setup.done();
    } catch (e) {
      removePath(tmp);
      removePath(buildDir(id));
      setup.fail(e);
    }
  })();
  return { ok: true };
}

export function removeBuild(id: BuildId): void {
  if (running?.build === id) stopServer();
  removePath(buildDir(id));
}

// ───────────────────────────── сервер ─────────────────────────────

export interface ServerInfo {
  baseUrl: string;
  build: BuildId;
  /** Слои модели выгружены на видеокарту. */
  gpu: boolean;
  model: string;
}

interface Running extends ServerInfo {
  key: string;
  proc: ChildProcess;
  busy: number;
  idle: NodeJS.Timeout | null;
}

let running: Running | null = null;
let starting: { key: string; p: Promise<Running> } | null = null;
/** Сборки, на которых сервер не поднялся: пропускаем до перезапуска приложения. */
const bad = new Set<BuildId>();
const IDLE_MS = 10 * 60 * 1000;

export const badBuilds = (): BuildId[] => [...bad];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export type Device = "auto" | "cpu" | "gpu";

/** Порядок сборок для выбранного устройства: GPU-сборки раньше CPU, CUDA раньше Vulkan. */
export function buildOrder(device: Device): BuildId[] {
  const have = installedBuilds().filter((b) => !bad.has(b));
  if (device === "cpu") return have.includes("cpu") ? ["cpu"] : have.slice(0, 1);
  const order: BuildId[] = ["cuda", "vulkan", "cpu"];
  const list = order.filter((b) => have.includes(b));
  return device === "gpu" ? list.filter((b) => b !== "cpu") : list;
}

export interface StartOptions {
  /** Файл .gguf. */
  model: string;
  device?: Device;
  /** Контекст в токенах. */
  ctx?: number;
  /** Без jinja-шаблона чата: для сырого /completion (у TranslateGemma шаблон не разбирается). */
  raw?: boolean;
}

async function waitReady(proc: ChildProcess, base: string, tail: () => string): Promise<void> {
  let exited = false;
  proc.once("exit", () => (exited = true));
  const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60 * 1000) {
    if (exited) throw new Error(`llama_exited: ${tail().slice(-300)}`);
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* ещё грузится */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("llama_start_timeout");
}

async function spawnServer(build: BuildId, o: StartOptions, cpuOnly: boolean): Promise<Running> {
  const exe = exePath(build);
  if (!exe) throw new Error("build_missing");
  const port = await freePort();
  const gpu = build !== "cpu" && !cpuOnly;
  const args = [
    "-m",
    o.model,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(o.ctx ?? 4096),
    "-ngl",
    gpu ? "99" : "0",
    "-np",
    "1",
    "--no-webui",
    ...(o.raw ? ["--no-jinja"] : []),
    "-t",
    String(Math.max(1, Math.floor(os.cpus().length / 2))),
  ];
  const proc = spawn(exe, args, {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const add = (d: Buffer): void => {
    log = (log + d.toString()).slice(-4000);
  };
  proc.stdout?.on("data", add);
  proc.stderr?.on("data", add);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitReady(proc, base, () => log);
  } catch (e) {
    proc.kill();
    throw e;
  }
  const r: Running = {
    key: "",
    proc,
    baseUrl: base,
    build,
    gpu,
    model: o.model,
    busy: 0,
    idle: null,
  };
  proc.once("exit", () => {
    if (running === r) running = null;
  });
  return r;
}

export function stopServer(): void {
  const r = running;
  if (!r) return;
  if (r.idle) clearTimeout(r.idle);
  running = null;
  try {
    r.proc.kill();
  } catch {
    /* уже завершён */
  }
  logger.info("llamacpp.stopped", { build: r.build });
}

process.once("exit", () => {
  try {
    running?.proc.kill();
  } catch {
    /* ignore */
  }
});

function arm(r: Running): void {
  if (r.idle) clearTimeout(r.idle);
  r.idle = setTimeout(() => {
    if (r.busy > 0) return arm(r);
    stopServer();
  }, IDLE_MS);
  r.idle.unref?.();
}

/** Поднять сервер для модели (или взять работающий). Смена модели/устройства перезапускает его. */
export async function ensureServer(o: StartOptions): Promise<ServerInfo> {
  const device = o.device ?? "auto";
  const key = `${o.model}|${device}|${o.ctx ?? 4096}|${o.raw ? "raw" : "chat"}`;
  if (running && running.key === key) return running;
  if (running && running.busy === 0) stopServer();
  if (running) return running;
  if (starting?.key === key) return starting.p;
  const candidates = buildOrder(device);
  if (!candidates.length) throw new Error("build_missing");
  const p = (async () => {
    let last: unknown = null;
    for (const build of candidates) {
      try {
        const r = await spawnServer(build, o, device === "cpu");
        r.key = key;
        running = r;
        arm(r);
        logger.info("llamacpp.started", { build, gpu: r.gpu, model: path.basename(o.model) });
        return r;
      } catch (e) {
        last = e;
        bad.add(build);
        logger.warn("llamacpp.start_failed", {
          build,
          error: String((e as Error).message).slice(0, 300),
        });
      }
    }
    throw new Error(
      `llama_start_failed: ${String((last as Error)?.message || last).slice(0, 300)}`,
    );
  })().finally(() => {
    starting = null;
  });
  starting = { key, p };
  return p;
}

/** Обёртка на время запроса: не даёт выгрузить сервер по простою и продлевает таймер. */
export async function withServer<T>(
  o: StartOptions,
  fn: (s: ServerInfo) => Promise<T>,
): Promise<T> {
  const s = (await ensureServer(o)) as Running;
  s.busy++;
  try {
    return await fn(s);
  } finally {
    s.busy--;
    if (running === s) arm(s);
  }
}

export function serverInfo(): (ServerInfo & { file: string }) | null {
  return running
    ? {
        baseUrl: running.baseUrl,
        build: running.build,
        gpu: running.gpu,
        model: running.model,
        file: path.basename(running.model),
      }
    : null;
}
