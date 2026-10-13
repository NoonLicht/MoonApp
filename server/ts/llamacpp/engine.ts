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
  for (const r of pool.values()) if (r.build === id) kill(r);
  removePath(buildDir(id));
}

// ───────────────────────────── сервер ─────────────────────────────

/** Где реально лежит модель: слои и веса на видеокарте/в оперативной памяти (разбор лога llama.cpp). */
export interface Placement {
  layersGpu: number;
  layersTotal: number;
  gpuMb: number;
  cpuMb: number;
  kvGpuMb: number;
  kvCpuMb: number;
  /** Название видеокарты (пусто — процессор). */
  device: string;
  moe: boolean;
  mode: "cpu" | "gpu-full" | "gpu-partial";
  /** Итог подбора --fit: влезло целиком или что-то ушло в RAM. */
  fit: string;
}

const num = (v: string | undefined): number => (v ? Math.round(parseFloat(v)) : 0);

/** Разбор лога загрузки (-lv 4): слои на GPU, размеры буферов, имя устройства. */
export function parsePlacement(log: string, o: { gpu: boolean; file: string }): Placement {
  const layers = /offloaded (\d+)\/(\d+) layers to GPU/.exec(log);
  let gpuMb = 0;
  let cpuMb = 0;
  for (const m of log.matchAll(/(\S+) model buffer size =\s*([\d.]+) MiB/g))
    if (/^CPU/i.test(m[1])) cpuMb += num(m[2]);
    else gpuMb += num(m[2]);
  let kvGpuMb = 0;
  let kvCpuMb = 0;
  for (const m of log.matchAll(/(\S+) KV buffer size =\s*([\d.]+) MiB/g))
    if (/^CPU/i.test(m[1])) kvCpuMb += num(m[2]);
    else kvGpuMb += num(m[2]);
  const dev = /using device \S+ \((.+?)\)/.exec(log);
  const fit = /common_params_fit_impl: (will leave[^\n]*|[^\n]*(?:changes|offload)[^\n]*)/i.exec(
    log,
  );
  const layersGpu = layers ? Number(layers[1]) : 0;
  const layersTotal = layers ? Number(layers[2]) : 0;
  const moe = isMoeFile(o.file);
  const onGpu = o.gpu && (layersGpu > 0 || gpuMb > 0);
  let mode: Placement["mode"] = "cpu";
  if (onGpu) {
    const partial =
      (layersTotal > 0 && layersGpu < layersTotal) || (moe && cpuMb > Math.max(1, gpuMb) * 0.2);
    mode = partial ? "gpu-partial" : "gpu-full";
  }
  return {
    layersGpu,
    layersTotal,
    gpuMb,
    cpuMb,
    kvGpuMb,
    kvCpuMb,
    device: onGpu ? (dev?.[1] ?? "") : "",
    moe,
    mode,
    fit: fit?.[1]?.trim().slice(0, 200) ?? "",
  };
}

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
  used: number;
  mmproj: string;
  task: string;
  place: Placement;
  device: Device;
  ctx: number;
}

/** Пул запущенных серверов: ключ → процесс. Несколько моделей живут одновременно в пределах лимита. */
const pool = new Map<string, Running>();
const starting = new Map<string, { p: Promise<Running>; file: string; task: string }>();
let lastUsedKey = "";
/** Лимит одновременно загруженных моделей; задаёт router.ts (зависит от ноутбука/памяти). */
let limitFn: () => number = () => 2;
/** Режим размещения MoE-моделей на видеокарте (см. router.ts). */
let moeFn: () => boolean = () => true;
/** Заданное пользователем число слоёв на видеокарте для файла (0 — автоматически). */
let layersFn: (file: string) => number = () => 0;
export function configureEngine(o: {
  limit?: () => number;
  moeOffload?: () => boolean;
  idleMs?: () => number;
  gpuLayers?: (file: string) => number;
}): void {
  if (o.gpuLayers) layersFn = o.gpuLayers;
  if (o.limit) limitFn = o.limit;
  if (o.idleMs) idleFn = o.idleMs;
  if (o.moeOffload) moeFn = o.moeOffload;
}
/** Модель из семейства MoE (Gemma 4 26B-A4B, Qwen3.6-35B-A3B…): по имени файла. */
export const isMoeFile = (file: string): boolean =>
  /(?:^|[-_.])a\d+(?:\.\d+)?b(?:[-_.]|$)|moe|gpt-oss/i.test(path.basename(file));
/** Сборки, на которых сервер не поднялся: пропускаем до перезапуска приложения. */
const bad = new Set<BuildId>();
let idleFn: () => number = () => 10 * 60 * 1000;

export const badBuilds = (): BuildId[] => [...bad];

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** auto — лучшая из установленных; cpu/gpu — по типу; vulkan/cuda — строго эта сборка. */
export type Device = "auto" | "cpu" | "gpu" | BuildId;

/** Порядок сборок для выбранного устройства: GPU-сборки раньше CPU, CUDA раньше Vulkan. */
export function buildOrder(device: Device): BuildId[] {
  const have = installedBuilds().filter((b) => !bad.has(b));
  if (isBuildId(device) && device !== "cpu") return have.includes(device) ? [device] : [];
  if (device === "cpu") return have.includes("cpu") ? ["cpu"] : have.slice(0, 1);
  const order: BuildId[] = ["cuda", "vulkan", "cpu"];
  const list = order.filter((b) => have.includes(b));
  return device === "gpu" ? list.filter((b) => b !== "cpu") : list;
}

export interface StartOptions {
  /** Файл .gguf. */
  model: string;
  /** Проектор изображений (--mmproj) для мультимодальных моделей. */
  mmproj?: string;
  device?: Device;
  /** Контекст в токенах. */
  ctx?: number;
  /** Без jinja-шаблона чата: для сырого /completion (у TranslateGemma шаблон не разбирается). */
  raw?: boolean;
  /** Для чего запущено (подпись в индикаторе активности): command, summary, translate… */
  task?: string;
}

export async function waitReady(
  proc: ChildProcess,
  base: string,
  tail: () => string,
): Promise<void> {
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

/**
 * Размещение слоёв. На CPU — ничего на видеокарте. На GPU слои не задаём жёстко: llama.cpp сам
 * подбирает (--fit) по свободной видеопамяти и выгружает в оперативную память то, что не влезло —
 * у MoE-моделей это эксперты (A3B/A4B считают на 3–4 млрд параметров, остальные веса лежат в RAM).
 */
function gpuArgs(o: StartOptions, gpu: boolean, build: BuildId = "cuda"): string[] {
  if (!gpu) return ["-ngl", "0"];
  const n = layersFn(path.basename(o.model));
  if (n > 0) {
    // Ручное число слоёв: --fit выключаем, иначе он перераспределит по-своему.
    if (isMoeFile(o.model)) {
      // MoE: всё (внимание, нормы) на видеокарте, а эксперты — на видеокарте только у первых N слоёв.
      const dev = build === "vulkan" ? "Vulkan0" : "CUDA0";
      const first = Array.from({ length: Math.min(n, 256) }, (_, i) => i).join("|");
      return [
        "--fit",
        "off",
        "-ngl",
        "99",
        "-ot",
        `blk\\.(?:${first})\\.ffn_.*_exps\\.=${dev},ffn_.*_exps\\.=CPU`,
      ];
    }
    return ["--fit", "off", "-ngl", String(n)];
  }
  if (isMoeFile(o.model) && !moeFn()) return ["-ngl", "99"];
  return ["--fit", "on", "--fit-target", "768"];
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
    ...gpuArgs(o, gpu, build),
    "-np",
    "1",
    "--no-webui",
    // подробный лог загрузки: по нему определяем, сколько слоёв и весов ушло на видеокарту
    "-lv",
    "4",
    ...(o.raw ? ["--no-jinja"] : []),
    ...(o.mmproj ? ["--mmproj", o.mmproj, ...(gpu ? [] : ["--no-mmproj-offload"])] : []),
    "-t",
    String(Math.max(1, Math.floor(os.cpus().length / 2))),
  ];
  const proc = spawn(exe, args, {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let boot = "";
  let booting = true;
  const add = (d: Buffer): void => {
    const t = d.toString();
    log = (log + t).slice(-4000);
    if (booting && boot.length < 400_000) boot += t;
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
  booting = false;
  const place = parsePlacement(boot, { gpu, file: o.model });
  boot = "";
  const r: Running = {
    key: "",
    proc,
    baseUrl: base,
    build,
    gpu,
    model: o.model,
    busy: 0,
    idle: null,
    used: Date.now(),
    mmproj: o.mmproj ?? "",
    task: o.task ?? "",
    place,
    device: o.device ?? "auto",
    ctx: o.ctx ?? 4096,
  };
  proc.once("exit", () => {
    for (const [k, v] of pool) if (v === r) pool.delete(k);
  });
  return r;
}

function kill(r: Running): void {
  if (r.idle) clearTimeout(r.idle);
  for (const [k, v] of pool) if (v === r) pool.delete(k);
  try {
    r.proc.kill();
  } catch {
    /* уже завершён */
  }
  logger.info("llamacpp.stopped", { build: r.build, model: path.basename(r.model) });
}

/** Выгрузить все модели или только ту, что запущена из этого файла. */
export function stopServer(file?: string): void {
  for (const r of [...pool.values()])
    if (!file || path.basename(r.model) === path.basename(file)) kill(r);
}

process.once("exit", () => {
  for (const r of pool.values()) {
    try {
      r.proc.kill();
    } catch {
      /* ignore */
    }
  }
});

function arm(r: Running): void {
  if (r.idle) clearTimeout(r.idle);
  r.idle = setTimeout(() => {
    if (r.busy > 0) return arm(r);
    kill(r);
  }, idleFn());
  r.idle.unref?.();
}

/** Освободить место под новую модель: выгружаем давно не использованные простаивающие серверы. */
function makeRoom(): void {
  const limit = Math.max(1, limitFn());
  while (pool.size + starting.size >= limit) {
    const idle = [...pool.values()].filter((r) => r.busy === 0).sort((a, b) => a.used - b.used);
    if (!idle.length) return; // все заняты — временно превышаем лимит, чем ломаем запрос
    kill(idle[0]);
  }
}

/** Поднять сервер для модели (или взять уже работающий). Лишние простаивающие выгружаются по лимиту. */
export async function ensureServer(o: StartOptions): Promise<ServerInfo> {
  const device = o.device ?? "auto";
  const key = `${o.model}|${o.mmproj ?? ""}|${device}|${o.ctx ?? 4096}|${o.raw ? "raw" : "chat"}`;
  const have = pool.get(key);
  if (have) {
    have.used = Date.now();
    lastUsedKey = key;
    return have;
  }
  // Тот же файл, устройство и окно, но без проектора (чат без картинок) — годится уже
  // загруженный экземпляр с проектором: вторую копию модели поднимать незачем.
  const mode = o.raw ? "raw" : "chat";
  const ctx = o.ctx ?? 4096;
  for (const r of pool.values()) {
    if (
      r.model === o.model &&
      r.device === device &&
      r.ctx === ctx &&
      r.key.endsWith(`|${mode}`) &&
      (!o.mmproj || r.mmproj === o.mmproj)
    ) {
      r.used = Date.now();
      lastUsedKey = r.key;
      return r;
    }
  }
  const pending = starting.get(key);
  if (pending) return pending.p;
  for (const [k, v] of starting) {
    const [m, mp, dev, c, md] = k.split("|");
    if (
      m === o.model &&
      dev === device &&
      Number(c) === ctx &&
      md === mode &&
      (!o.mmproj || mp === o.mmproj)
    )
      return v.p;
  }
  const candidates = buildOrder(device);
  if (!candidates.length) throw new Error("build_missing");
  makeRoom();
  const p = (async () => {
    let last: unknown = null;
    for (const build of candidates) {
      try {
        const r = await spawnServer(build, o, device === "cpu");
        r.key = key;
        r.used = Date.now();
        pool.set(key, r);
        lastUsedKey = key;
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
    starting.delete(key);
  });
  starting.set(key, { p, file: path.basename(o.model), task: o.task ?? "" });
  return p;
}

/** Обёртка на время запроса: не даёт выгрузить сервер по простою и продлевает таймер. */
export async function withServer<T>(
  o: StartOptions,
  fn: (s: ServerInfo) => Promise<T>,
): Promise<T> {
  const s = (await ensureServer(o)) as Running;
  s.busy++;
  s.used = Date.now();
  if (o.task) s.task = o.task;
  try {
    return await fn(s);
  } finally {
    s.busy--;
    s.used = Date.now();
    if (pool.get(s.key) === s) arm(s);
  }
}

export interface LoadedServer extends ServerInfo {
  file: string;
  busy: boolean;
  used: number;
  mmproj: string;
  task: string;
  place: Placement;
  device: Device;
  ctx: number;
}

/** Модели, которые прямо сейчас загружаются в память. */
export const loadingServers = (): { file: string; task: string }[] =>
  [...starting.values()].map((v) => ({ file: v.file, task: v.task }));

/** Все загруженные сейчас модели (новее — раньше). */
export function loadedServers(): LoadedServer[] {
  return [...pool.values()]
    .sort((a, b) => b.used - a.used)
    .map((r) => ({
      baseUrl: r.baseUrl,
      build: r.build,
      gpu: r.gpu,
      model: r.model,
      file: path.basename(r.model),
      busy: r.busy > 0,
      used: r.used,
      mmproj: r.mmproj ? path.basename(r.mmproj) : "",
      task: r.task,
      place: r.place,
      device: r.device,
      ctx: r.ctx,
    }));
}

/** Модель, которой пользовались последней (для совместимости со старым API). */
export function serverInfo(): (ServerInfo & { file: string }) | null {
  const r = pool.get(lastUsedKey) ?? [...pool.values()][0];
  return r
    ? {
        baseUrl: r.baseUrl,
        build: r.build,
        gpu: r.gpu,
        model: r.model,
        file: path.basename(r.model),
      }
    : null;
}
