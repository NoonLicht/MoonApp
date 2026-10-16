/**
 * Маршрутизатор локальных моделей: какая модель под какую задачу, сколько их держать в памяти
 * одновременно и когда загружать заранее.
 *
 * Задачи: command (команды в заметках), summary (сводки почты и т. п.), translate, chat, vision.
 * Выбранную в настройках «модель по умолчанию» берём в первую очередь; иначе — самую сильную из
 * установленных, что влезает в бюджет памяти. Эмбеддинги живут отдельным процессом (embed.ts) и
 * лимит не занимают. На ноутбуках по умолчанию держится одна модель: остальные выгружаются.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import config from "../config";
import {
  badBuilds,
  clearBadBuilds,
  clearFailure,
  configureEngine,
  ensureServer,
  gpuInfo,
  loadedServers,
  loadFailures,
  loadingServers,
  stopServer,
  type BuildId,
  type Device,
  type GpuProbe,
  type LoadFailure,
  type Placement,
} from "./engine";
import { CATALOG, installed, modelPath, siblingMmproj } from "./models";

export type Task = "command" | "summary" | "translate" | "chat" | "vision";

export interface RouterSettings {
  /** Лимит одновременно загруженных моделей; 0 — автоматически (ноутбук 1, ПК 2–4). */
  maxLoaded: number;
  /** MoE-модели (A3B/A4B): держать на видеокарте только нужные слои, эксперты — в RAM. */
  moeOffload: boolean;
  /** Модель по умолчанию для команд, сводок и чата; пусто — подбирается автоматически. */
  defaultModel: string;
  /** Загружать модель заранее при входе на страницу, которой она нужна. */
  autoWarm: boolean;
  /** Через сколько минут простоя выгружать модель; 0 — автоматически. */
  idleMinutes: number;
  /** Устройство для конкретной модели: файл → auto | cpu | gpu. */
  devices: Record<string, string>;
  /** Окно контекста чатовых моделей (токены: промпт + ответ). Больше — больше RAM/VRAM под KV-кэш. */
  ctx: number;
}

export const CTX_MIN = 2048;
export const CTX_MAX = 131072;
export const CTX_DEFAULT = 16384;

/** Окно контекста для чатовых задач (команды, сводки, чат, vision). */
export const chatCtx = (): number => routerSettings().ctx;

const FILE = path.join(config.DIRS.storage, "llama", "router.json");
let cfg: RouterSettings | null = null;

const clampInt = (v: unknown, min: number, max: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;

function cleanDevices(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object")
    for (const [k, d] of Object.entries(v as Record<string, unknown>))
      if (d === "cpu" || d === "gpu") out[path.basename(k)] = d;
  return out;
}

/** Выбранное для модели устройство (auto — решает llama.cpp). */
export const deviceFor = (file: string): Device => {
  const d = routerSettings().devices[path.basename(file)];
  return d === "cpu" || d === "gpu" ? d : "auto";
};

export function routerSettings(): RouterSettings {
  if (cfg) return cfg;
  let v: Partial<RouterSettings> = {};
  try {
    v = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<RouterSettings>;
  } catch {
    /* первый запуск */
  }
  cfg = {
    maxLoaded: clampInt(v.maxLoaded, 0, 8, 0),
    moeOffload: v.moeOffload !== false,
    defaultModel: typeof v.defaultModel === "string" ? v.defaultModel : "",
    autoWarm: v.autoWarm !== false,
    idleMinutes: clampInt(v.idleMinutes, 0, 240, 0),
    devices: cleanDevices(v.devices),
    ctx: clampInt(v.ctx, CTX_MIN, CTX_MAX, CTX_DEFAULT),
  };
  return cfg;
}

export function setRouterSettings(p: Partial<RouterSettings>): RouterSettings {
  const cur = routerSettings();
  const next: RouterSettings = {
    maxLoaded: clampInt(p.maxLoaded, 0, 8, cur.maxLoaded),
    moeOffload: typeof p.moeOffload === "boolean" ? p.moeOffload : cur.moeOffload,
    defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : cur.defaultModel,
    autoWarm: typeof p.autoWarm === "boolean" ? p.autoWarm : cur.autoWarm,
    idleMinutes: clampInt(p.idleMinutes, 0, 240, cur.idleMinutes),
    devices: p.devices ? cleanDevices(p.devices) : cur.devices,
    ctx: clampInt(p.ctx, CTX_MIN, CTX_MAX, cur.ctx),
  };
  cfg = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next), "utf8");
  return next;
}

// ───────────────────────────── ноутбук или нет ─────────────────────────────

let laptop = false;
let probed = false;

/** Определяем наличие батареи один раз в фоне; до ответа считаем, что это настольный ПК. */
export function probeLaptop(): void {
  if (probed) return;
  probed = true;
  try {
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Measure-Object).Count",
        ],
        { windowsHide: true, timeout: 8000 },
        (_e, out) => {
          laptop = Number(String(out).trim()) > 0;
        },
      );
    } else if (process.platform === "linux") {
      laptop = fs.readdirSync("/sys/class/power_supply").some((n) => /^BAT/i.test(n));
    } else if (process.platform === "darwin") {
      execFile("sysctl", ["-n", "hw.model"], { timeout: 4000 }, (_e, out) => {
        laptop = /book/i.test(String(out));
      });
    }
  } catch {
    laptop = false;
  }
}

export const isLaptop = (): boolean => laptop;

const ramMb = (): number => Math.round(os.totalmem() / 1048576);

/** Фактический лимит одновременно загруженных моделей. */
export function effectiveLimit(): number {
  const c = routerSettings().maxLoaded;
  if (c > 0) return c;
  if (laptop) return 1;
  const gb = ramMb() / 1024;
  return gb >= 32 ? 4 : gb >= 16 ? 3 : 2;
}

const effectiveIdleMs = (): number => {
  const m = routerSettings().idleMinutes;
  return (m > 0 ? m : laptop ? 2 : 10) * 60_000;
};

configureEngine({
  limit: effectiveLimit,
  moeOffload: () => routerSettings().moeOffload,
  idleMs: effectiveIdleMs,
});

// ───────────────────────────── выбор модели ─────────────────────────────

/** Не годятся для генерации текста: эмбеддинги, проекторы, OCR, озвучка, переводчик. */
const NOT_CHAT = /embedding|mmproj|chandra|tts|translategemma/i;

export function chatModels(): { file: string; sizeMb: number }[] {
  return installed().filter((m) => !NOT_CHAT.test(m.file));
}

/** Бюджет памяти под одну модель: ноутбук скромнее, у ПК — до трети RAM. */
function budgetMb(): number {
  const third = Math.round(ramMb() * 0.35);
  return Math.max(1500, Math.min(laptop ? 3500 : 9000, third));
}

/**
 * Файл модели под задачу. `preferred` — явный выбор (пользователь или настройка страницы):
 * используется, если установлен. Возвращает null, если подходящих моделей нет.
 */
export function pickModel(task: Task, preferred = ""): string | null {
  const have = installed().map((m) => m.file);
  if (preferred && preferred !== "auto" && have.includes(preferred)) return preferred;
  if (task === "translate") {
    const tg = have.find((f) => /translategemma/i.test(f));
    if (tg) return tg;
  }
  const def = routerSettings().defaultModel;
  if (def && have.includes(def) && !NOT_CHAT.test(def)) return def;
  let list = chatModels();
  if (task === "vision") {
    const withProj = list.filter((m) => siblingMmproj(m.file));
    if (withProj.length) list = withProj;
  }
  if (!list.length) return null;
  const budget = budgetMb();
  const fit = list.filter((m) => m.sizeMb <= budget);
  const pool = fit.length ? fit : [...list].sort((a, b) => a.sizeMb - b.sizeMb).slice(0, 1);
  // Уже загруженная подходящая модель выгоднее: не тратим время на загрузку другой.
  const loaded = loadedServers()
    .map((s) => s.file)
    .find((f) => pool.some((m) => m.file === f));
  if (loaded && task !== "vision") return loaded;
  return [...pool].sort((a, b) => b.sizeMb - a.sizeMb)[0].file;
}

export interface Resolved {
  file: string;
  model: string;
  mmproj?: string;
  device: Device;
}

/** Модель + проектор (если нужны картинки и он скачан). */
export function resolve(task: Task, preferred = "", wantImages = false): Resolved | null {
  const file = pickModel(wantImages ? "vision" : task, preferred);
  if (!file) return null;
  const mmproj = wantImages ? siblingMmproj(file) : null;
  return {
    file,
    model: modelPath(file),
    device: deviceFor(file),
    ...(mmproj ? { mmproj: modelPath(mmproj) } : {}),
  };
}

/** Каталожный размер модели (для подсказок в UI). */
export const catalogSize = (file: string): number =>
  CATALOG.find((c) => c.file === file)?.sizeMb ?? 0;

// ───────────────────────────── прогрев и активность ─────────────────────────────

/** Загрузить модель под задачу заранее (в фоне). Ответ — какая модель выбрана. */
export function warm(task: Task): { file: string | null; started: boolean } {
  if (!routerSettings().autoWarm) return { file: null, started: false };
  const r = resolve(task);
  if (!r) return { file: null, started: false };
  if (loadedServers().some((s) => s.file === r.file)) return { file: r.file, started: false };
  if (loadingServers().some((s) => s.file === r.file)) return { file: r.file, started: false };
  void ensureServer({
    model: r.model,
    device: r.device,
    ctx: task === "translate" ? 4096 : chatCtx(),
    task,
  }).catch(() => undefined);
  return { file: r.file, started: true };
}

export interface LoadedInfo {
  file: string;
  task: string;
  busy: boolean;
  gpu: boolean;
  build: string;
  /** Выбранное устройство: auto | cpu | gpu. */
  device: string;
  ctx: number;
  mmproj: string;
  place: Placement;
}

/**
 * Загрузить конкретную модель вручную (кнопка в панели): при смене устройства сохраняем выбор и
 * перезапускаем сервер этой модели, чтобы она встала в память уже по новым правилам.
 */
export function loadNow(file: string, device?: string): { file: string; started: boolean } {
  const f = path.basename(file);
  if (!installed().some((m) => m.file === f) || /embedding|mmproj|chandra|tts/i.test(f))
    throw new Error("bad_model");
  if (device === "auto" || device === "cpu" || device === "gpu") {
    const devices = { ...routerSettings().devices };
    if (device === "auto") delete devices[f];
    else devices[f] = device;
    setRouterSettings({ devices });
  }
  // Перезагрузка не должна менять «зачем модель загружена»: сохраняем прежнюю задачу.
  const prevTask = loadedServers().find((s) => s.file === f)?.task;
  // Ручная перезагрузка — повод заново попробовать и сборки, отключённые после сбоя.
  clearBadBuilds();
  clearFailure(f);
  stopServer(f);
  const mmproj = siblingMmproj(f);
  void ensureServer({
    model: modelPath(f),
    mmproj: mmproj ? modelPath(mmproj) : undefined,
    device: deviceFor(f),
    ctx: chatCtx(),
    task: prevTask || "manual",
  }).catch(() => undefined);
  return { file: f, started: true };
}

export interface Activity {
  loaded: LoadedInfo[];
  loading: { file: string; task: string }[];
  limit: number;
  laptop: boolean;
  ramMb: number;
  /** Модели, которые не удалось загрузить, и почему. */
  failed: LoadFailure[];
  /** Видеокарта, которую видит система (для подсказок). */
  gpu: GpuProbe;
  /** Сборки, временно отключённые после сбоя самой сборки. */
  badBuilds: BuildId[];
}

export function activity(): Activity {
  return {
    loaded: loadedServers().map((s) => ({
      file: s.file,
      task: s.task,
      busy: s.busy,
      gpu: s.gpu,
      build: s.build,
      device: s.device,
      ctx: s.ctx,
      mmproj: s.mmproj,
      place: s.place,
    })),
    loading: loadingServers(),
    limit: effectiveLimit(),
    laptop,
    ramMb: ramMb(),
    failed: loadFailures().filter(
      (x) =>
        !loadedServers().some((s) => s.file === x.file) &&
        !loadingServers().some((s) => s.file === x.file),
    ),
    gpu: gpuInfo(),
    badBuilds: badBuilds(),
  };
}

export { stopServer };
probeLaptop();
