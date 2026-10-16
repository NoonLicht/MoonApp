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
import { ggufInfo } from "./gguf";

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
export function configureEngine(o: {
  limit?: () => number;
  moeOffload?: () => boolean;
  idleMs?: () => number;
}): void {
  if (o.limit) limitFn = o.limit;
  if (o.idleMs) idleFn = o.idleMs;
  if (o.moeOffload) moeFn = o.moeOffload;
}
/** Запасной признак MoE по имени файла — если заголовок GGUF прочитать не удалось. */
const moeByName = (file: string): boolean =>
  /(?:^|[-_.]|\db)a\d+(?:\.\d+)?b(?:[-_.]|$)|moe|gpt-oss|glm-4\.\d+-flash/i.test(
    path.basename(file),
  );
/**
 * Модель MoE или обычная — по метаданным GGUF (`<arch>.expert_count` > 0), а не по названию.
 * Имя используется только когда файл недоступен или это не GGUF.
 */
export const isMoeFile = (file: string): boolean => {
  const full = path.isAbsolute(file) && fs.existsSync(file) ? file : path.join(modelsDir(), path.basename(file));
  const info = ggufInfo(full);
  return info ? info.experts > 0 : moeByName(file);
};
/**
 * Сборки с неисправностью САМОЙ сборки (драйвер, DLL, архитектура видеокарты): пропускаем
 * BAD_TTL_MS. Нехватка памяти под крупную модель или битый GGUF сюда не попадают: раньше один
 * такой сбой навсегда отключал CUDA и Vulkan, и все модели молча уходили на процессор.
 */
const BAD_TTL_MS = 10 * 60 * 1000;
const bad = new Map<BuildId, number>();
let idleFn: () => number = () => 10 * 60 * 1000;

const isBad = (b: BuildId): boolean => {
  const until = bad.get(b);
  if (!until) return false;
  if (Date.now() < until) return true;
  bad.delete(b);
  return false;
};

export const badBuilds = (): BuildId[] => BUILD_IDS.filter(isBad);

/** Снова разрешить сборки (кнопка «включить» и ручная перезагрузка модели). */
export function clearBadBuilds(): void {
  bad.clear();
}

// ───────────────────────────── сбои запуска ─────────────────────────────

/** build — неисправна сборка; memory — модель не влезла; model — прочее (битый файл, таймаут). */
export type Fault = "build" | "memory" | "model";

const MEMORY_RE =
  /out of memory|failed to allocate|cudaMalloc failed|unable to allocate|ErrorOutOfDeviceMemory|ErrorOutOfHostMemory|not enough memory|bad_alloc|insufficient memory/i;
const BUILD_RE =
  /spawn_failed|ENOENT|EACCES|EPERM|ggml_cuda_init: failed|no CUDA-capable device|CUDA error:[^\n]*(no kernel image|invalid device|unknown error)|failed to initialize CUDA|cudaGetDeviceCount failed|vkCreateInstance|failed to create (a )?vulkan instance|0xC0000135|STATUS_DLL_NOT_FOUND/i;

/** Причина неудачного запуска по тексту ошибки и хвосту лога сервера. */
export function classifyFault(text: string): Fault {
  if (MEMORY_RE.test(text)) return "memory";
  if (BUILD_RE.test(text)) return "build";
  return "model";
}

function tagFault(e: unknown, log: string): Error & { fault: Fault } {
  const err = (e instanceof Error ? e : new Error(String(e))) as Error & { fault: Fault };
  err.fault = classifyFault(`${err.message}\n${log}`);
  return err;
}

export interface LoadFailure {
  file: string;
  /** Код для перевода: memory | build | model | gpu_build_missing | gpu_build_failed | build_missing. */
  code: string;
  detail: string;
  device: string;
  at: number;
}

/** Последний неудачный запуск каждой модели: UI показывает причину, а не молча «теряет» модель. */
const failures = new Map<string, LoadFailure>();

export const loadFailures = (): LoadFailure[] =>
  [...failures.values()].sort((a, b) => b.at - a.at);

export function clearFailure(file?: string): void {
  if (file) failures.delete(path.basename(file));
  else failures.clear();
}

function noteFailure(o: StartOptions, e: unknown): void {
  const err = e as Error & { fault?: Fault };
  const msg = String(err?.message ?? e);
  const code = /^(gpu_build_missing|gpu_build_failed|build_missing)$/.test(msg)
    ? msg
    : (err?.fault ?? "model");
  failures.set(path.basename(o.model), {
    file: path.basename(o.model),
    code,
    detail: msg.replace(/\s+/g, " ").slice(0, 240),
    device: o.device ?? "auto",
    at: Date.now(),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── видеокарта ─────────────────────────────

export interface GpuProbe {
  present: boolean;
  name: string;
  vramMb: number;
}

let gpuProbe: GpuProbe = { present: false, name: "", vramMb: 0 };
let gpuProbeAt = 0;

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) =>
        resolve(err ? "" : String(out || "")),
      );
    } catch {
      resolve("");
    }
  });
}

/** Видит ли система видеокарту (кэш на минуту, запрос в фоне). Нужна подсказкам интерфейса. */
export function gpuInfo(): GpuProbe {
  if (Date.now() - gpuProbeAt > 60_000) {
    gpuProbeAt = Date.now();
    void (async () => {
      const smi = await runCmd("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
      ]);
      const line = smi.split(/\r?\n/).find((l) => l.trim());
      if (line) {
        const [name, mem] = line.split(",").map((x) => x.trim());
        gpuProbe = { present: true, name, vramMb: parseInt(mem, 10) || 0 };
        return;
      }
      if (process.platform === "win32") {
        const wmi = await runCmd("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_VideoController).Name",
        ]);
        const name = wmi
          .split(/\r?\n/)
          .map((x) => x.trim())
          .find((x) => /nvidia|geforce|rtx|gtx|radeon|amd|arc\b|intel.*(arc|iris|xe)/i.test(x));
        gpuProbe = { present: !!name, name: name ?? "", vramMb: 0 };
      }
    })();
  }
  return gpuProbe;
}

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
  const have = installedBuilds().filter((b) => !isBad(b));
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
  proc.once("error", () => (exited = true));
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
function gpuArgs(o: StartOptions, gpu: boolean): string[] {
  if (!gpu) return ["-ngl", "0"];
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
    ...gpuArgs(o, gpu),
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
  let proc: ChildProcess;
  try {
    proc = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // В Windows spawn бросает синхронно («spawn UNKNOWN» — файл не исполняемый или заблокирован).
    throw tagFault(new Error(`spawn_failed: ${(e as Error).message}`), "");
  }
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
  // Без обработчика 'error' неудачный запуск (нет файла, антивирус) валит весь серверный процесс.
  let spawnErr = "";
  const spawnFailed = new Promise<never>((_, reject) =>
    proc.once("error", (e) => {
      spawnErr = `spawn_failed: ${e.message}`;
      reject(new Error(spawnErr));
    }),
  );
  try {
    await Promise.race([waitReady(proc, base, () => log), spawnFailed]);
  } catch (e) {
    // Ждём реального выхода: пока процесс жив, он держит видеопамять, и следующая попытка упадёт.
    await reap(proc);
    throw tagFault(e, `${log}
${spawnErr}`);
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

/** Серверы, которые сейчас завершаются: до выхода процесса видеопамять ещё занята. */
const dying = new Set<Promise<void>>();

/**
 * Завершить процесс и дождаться его выхода (через 6 с — принудительно, через 12 с — не ждём).
 * Ещё 300 мс после выхода: драйверу нужно время, чтобы вернуть видеопамять.
 */
export function reap(proc: ChildProcess): Promise<void> {
  const done = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const force = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* уже завершён */
      }
    }, 6000);
    const giveUp = setTimeout(resolve, 12_000);
    proc.once("exit", () => {
      clearTimeout(force);
      clearTimeout(giveUp);
      setTimeout(resolve, 300);
    });
    try {
      proc.kill();
    } catch {
      resolve();
    }
  });
  dying.add(done);
  void done.finally(() => dying.delete(done));
  return done;
}

/** Дождаться, пока завершатся все выгружаемые серверы (и освободится видеопамять). */
export const settled = (): Promise<void> => Promise.all([...dying]).then(() => undefined);

function kill(r: Running): void {
  if (r.idle) clearTimeout(r.idle);
  for (const [k, v] of pool) if (v === r) pool.delete(k);
  void reap(r.proc);
  logger.info("llamacpp.stopped", { build: r.build, model: path.basename(r.model) });
}

/**
 * Запуски идут строго по одному: две модели, стартующие одновременно, замеряют свободную
 * видеопамять в один и тот же момент, обе берут «всё свободное» и обе падают.
 */
let startChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = startChain.then(fn, fn);
  startChain = run.catch(() => undefined);
  return run;
}

let orphansReaped = false;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Серверы, оставшиеся от прошлого запуска (приложение закрыли аварийно): родителя уже нет, а
 * видеопамять занята. Завершаем только процессы из нашей папки сборок и только осиротевшие.
 */
async function reapOrphans(): Promise<void> {
  if (orphansReaped || process.platform !== "win32") return;
  orphansReaped = true;
  const out = await runCmd("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)\" }",
  ]);
  const mine = new Set([...pool.values()].map((r) => r.proc.pid));
  const root = buildsDir().toLowerCase();
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, exe] = line.trim().split("|");
    if (!pid || !exe || !exe.toLowerCase().startsWith(root)) continue;
    if (mine.has(Number(pid)) || alive(Number(ppid))) continue;
    try {
      process.kill(Number(pid));
      logger.warn("llamacpp.orphan_killed", { pid: Number(pid) });
    } catch {
      /* уже завершён */
    }
  }
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
function makeRoom(queued: number, wantsGpu: boolean): void {
  const limit = Math.max(1, limitFn());
  while (pool.size + queued >= limit) {
    const idle = [...pool.values()].filter((r) => r.busy === 0).sort((a, b) => a.used - b.used);
    if (!idle.length) break; // все заняты — временно превышаем лимит, чем ломаем запрос
    kill(idle[0]);
  }
  // Небольшая видеокарта (до 12 ГБ): вторая модель рядом с первой получает жалкие остатки
  // видеопамяти и работает на процессоре. Простаивающую «видеокартную» модель выгружаем.
  const vram = gpuInfo().vramMb;
  if (wantsGpu && vram > 0 && vram <= 12288)
    for (const r of [...pool.values()]) if (r.gpu && r.busy === 0) kill(r);
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
  const p = serialized(async () => {
    await reapOrphans();
    makeRoom(Math.max(0, starting.size - 1), device !== "cpu");
    await settled();
    const candidates = buildOrder(device);
    if (!candidates.length) {
      const gpuAsked = device !== "auto" && device !== "cpu";
      const gpuInstalled = installedBuilds().some((b) => b !== "cpu");
      throw new Error(
        gpuAsked ? (gpuInstalled ? "gpu_build_failed" : "gpu_build_missing") : "build_missing",
      );
    }
    let last: unknown = null;
    let gpuNoMemory = false;
    for (const build of candidates) {
      // Видеопамяти не хватило — Vulkan после CUDA её не добавит, идём сразу к процессору.
      if (build !== "cpu" && gpuNoMemory) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await spawnServer(build, o, device === "cpu");
          r.key = key;
          r.used = Date.now();
          pool.set(key, r);
          lastUsedKey = key;
          failures.delete(path.basename(o.model));
          arm(r);
          logger.info("llamacpp.started", { build, gpu: r.gpu, model: path.basename(o.model) });
          return r;
        } catch (e) {
          last = e;
          const fault = (e as { fault?: Fault }).fault ?? "model";
          logger.warn("llamacpp.start_failed", {
            build,
            fault,
            attempt,
            error: String((e as Error).message).slice(0, 300),
          });
          if (fault === "build") {
            bad.set(build, Date.now() + BAD_TTL_MS);
            break;
          }
          if (build === "cpu" || attempt === 1) {
            if (build !== "cpu" && fault === "memory") gpuNoMemory = true;
            break;
          }
          // Часто это гонка за видеопамять с только что выгруженной моделью: одна повторная попытка.
          await sleep(1500);
          await settled();
        }
      }
    }
    const err = new Error(
      `llama_start_failed: ${String((last as Error)?.message || last).slice(0, 300)}`,
    ) as Error & { fault?: Fault };
    err.fault = (last as { fault?: Fault } | null)?.fault ?? "model";
    throw err;
  })
    .catch((e) => {
      noteFailure(o, e);
      throw e;
    })
    .finally(() => {
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
