/**
 * Настройки запуска ComfyUI: куда класть модели (видеопамять или оперативная), точность, внимание, кэш.
 *
 * Хранятся в storage/comfy/settings.json и превращаются в ключи командной строки при старте. Все
 * значения перечислены явно: в командную строку попадает только известное, а «свои ключи» проходят
 * через запретный список (сетевые и путевые ключи задаёт само приложение).
 */
import fs from "fs";
import path from "path";
import config from "../config";

const comfyRoot = (): string => path.join(config.DIRS.storage, "comfy");

/** auto — ComfyUI решает сам (динамическая загрузка весов); остальное — явный режим. */
export type MemoryMode = "auto" | "gpu" | "high" | "low" | "none" | "cpu";

export interface RunSettings {
  /** gpu: всё в видеопамяти · high: модели остаются в видеопамяти · low: энкодеры на процессоре, веса частями · none: почти всё в оперативной памяти · cpu: вообще без видеокарты. */
  memory: MemoryMode;
  /** VAE (декодирование картинки) считать на процессоре и держать в оперативной памяти. */
  cpuVae: boolean;
  /** Сколько ГБ видеопамяти оставить системе и другим программам; 0 — по умолчанию. */
  reserveVramGb: number;
  /** Выключить — модели агрессивно уходят в оперативную память вместо остатка в видеопамяти. */
  smartMemory: boolean;
  asyncOffload: "auto" | "on" | "off";
  dynamicVram: "auto" | "on" | "off";
  cache: "auto" | "classic" | "lru" | "none";
  cacheLru: number;
  highRam: boolean;
  unet: "auto" | "fp32" | "fp16" | "bf16" | "fp8_e4m3fn" | "fp8_e5m2";
  vae: "auto" | "fp32" | "fp16" | "bf16";
  textEnc: "auto" | "fp32" | "fp16" | "bf16" | "fp8_e4m3fn" | "fp8_e5m2";
  attention: "auto" | "pytorch" | "split" | "quad" | "sage" | "flash";
  /** Непроверенные ускорения ComfyUI (--fast). */
  fast: boolean;
  preview: "auto" | "none" | "latent2rgb" | "taesd";
  /** Номера видеокарт через запятую; пусто — все. */
  cudaDevice: string;
  /** Встроенный менеджер узлов и моделей ComfyUI (ставится отдельной кнопкой). */
  manager: boolean;
  disableCudaMalloc: boolean;
  disablePartnerNodes: boolean;
  /** Свои ключи командной строки (через пробел). */
  extraArgs: string;
}

export const DEFAULT_RUN: RunSettings = {
  memory: "auto",
  cpuVae: false,
  reserveVramGb: 0,
  smartMemory: true,
  asyncOffload: "auto",
  dynamicVram: "auto",
  cache: "auto",
  cacheLru: 8,
  highRam: false,
  unet: "auto",
  vae: "auto",
  textEnc: "auto",
  attention: "auto",
  fast: false,
  preview: "auto",
  cudaDevice: "",
  manager: false,
  disableCudaMalloc: false,
  disablePartnerNodes: true,
  extraArgs: "",
};

const ENUMS: Partial<Record<keyof RunSettings, readonly string[]>> = {
  memory: ["auto", "gpu", "high", "low", "none", "cpu"],
  asyncOffload: ["auto", "on", "off"],
  dynamicVram: ["auto", "on", "off"],
  cache: ["auto", "classic", "lru", "none"],
  unet: ["auto", "fp32", "fp16", "bf16", "fp8_e4m3fn", "fp8_e5m2"],
  vae: ["auto", "fp32", "fp16", "bf16"],
  textEnc: ["auto", "fp32", "fp16", "bf16", "fp8_e4m3fn", "fp8_e5m2"],
  attention: ["auto", "pytorch", "split", "quad", "sage", "flash"],
  preview: ["auto", "none", "latent2rgb", "taesd"],
};
const BOOLS: (keyof RunSettings)[] = [
  "cpuVae",
  "smartMemory",
  "highRam",
  "fast",
  "manager",
  "disableCudaMalloc",
  "disablePartnerNodes",
];

/** Ключи, которые задаёт приложение или которые открыли бы ComfyUI в сеть. */
const BLOCKED_FLAGS = new Set([
  "--listen",
  "--port",
  "--tls-keyfile",
  "--tls-certfile",
  "--enable-cors-header",
  "--base-directory",
  "--extra-model-paths-config",
  "--output-directory",
  "--temp-directory",
  "--input-directory",
  "--previews-directory",
  "--user-directory",
  "--models-directory",
  "--auto-launch",
  "--database-url",
  "--front-end-root",
  "--front-end-version",
  "--comfy-api-base",
  "--multi-user",
]);

const file = (): string => path.join(comfyRoot(), "settings.json");

/** Приводит произвольный объект к допустимым настройкам: неизвестное отбрасывается. */
export function sanitize(input: unknown, base: RunSettings = DEFAULT_RUN): RunSettings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: RunSettings = { ...base };
  for (const [k, allowed] of Object.entries(ENUMS)) {
    const v = src[k];
    if (typeof v === "string" && allowed?.includes(v)) (out as unknown as Record<string, unknown>)[k] = v;
  }
  for (const k of BOOLS) if (typeof src[k] === "boolean") (out as unknown as Record<string, unknown>)[k] = src[k];
  if (typeof src.reserveVramGb === "number" && Number.isFinite(src.reserveVramGb))
    out.reserveVramGb = Math.min(64, Math.max(0, Math.round(src.reserveVramGb * 10) / 10));
  if (typeof src.cacheLru === "number" && Number.isFinite(src.cacheLru))
    out.cacheLru = Math.min(256, Math.max(1, Math.round(src.cacheLru)));
  if (typeof src.cudaDevice === "string") out.cudaDevice = /^\d+(,\d+)*$/.test(src.cudaDevice.trim()) ? src.cudaDevice.trim() : "";
  if (typeof src.extraArgs === "string") out.extraArgs = src.extraArgs.slice(0, 500);
  return out;
}

export function readRunSettings(): RunSettings {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch {
    return { ...DEFAULT_RUN };
  }
}

export function writeRunSettings(patch: unknown): RunSettings {
  const next = sanitize(patch, readRunSettings());
  fs.mkdirSync(comfyRoot(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Разбор «своих ключей»: токены `--ключ`, за каждым — простые значения; запретные ключи пропускаются. */
export function parseExtraArgs(text: string): string[] {
  const out: string[] = [];
  let mode: "skip" | "take" | "none" = "none";
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("--")) {
      const name = tok.split("=")[0];
      if (BLOCKED_FLAGS.has(name) || !/^--[a-z0-9][a-z0-9_-]*(=[A-Za-z0-9_.,:/-]*)?$/i.test(tok)) {
        mode = "skip";
        continue;
      }
      out.push(tok);
      mode = "take";
      continue;
    }
    // значение предыдущего ключа
    if (mode === "take" && /^[A-Za-z0-9_.,:/-]+$/.test(tok)) out.push(tok);
    else mode = "skip";
  }
  return out;
}

/** Ключи командной строки для настроек (без путей и порта — их добавляет запуск). */
export function buildRunArgs(s: RunSettings, opts: { cpu?: boolean; managerReady?: boolean } = {}): string[] {
  const a: string[] = [];
  if (opts.cpu || s.memory === "cpu") a.push("--cpu");
  else if (s.memory === "gpu") a.push("--gpu-only");
  else if (s.memory === "high") a.push("--highvram");
  else if (s.memory === "low") a.push("--lowvram");
  else if (s.memory === "none") a.push("--novram");
  if (s.cpuVae) a.push("--cpu-vae");
  if (s.reserveVramGb > 0) a.push("--reserve-vram", String(s.reserveVramGb));
  if (!s.smartMemory) a.push("--disable-smart-memory");
  if (s.asyncOffload === "on") a.push("--async-offload");
  else if (s.asyncOffload === "off") a.push("--disable-async-offload");
  if (s.dynamicVram === "on") a.push("--enable-dynamic-vram");
  else if (s.dynamicVram === "off") a.push("--disable-dynamic-vram");
  if (s.cache === "classic") a.push("--cache-classic");
  else if (s.cache === "lru") a.push("--cache-lru", String(s.cacheLru));
  else if (s.cache === "none") a.push("--cache-none");
  if (s.highRam) a.push("--high-ram");
  if (s.unet !== "auto") a.push(`--${s.unet}-unet`);
  if (s.vae !== "auto") a.push(`--${s.vae}-vae`);
  if (s.textEnc !== "auto") a.push(`--${s.textEnc}-text-enc`);
  if (s.attention !== "auto") a.push(`--use-${s.attention}-${s.attention === "sage" || s.attention === "flash" ? "attention" : "cross-attention"}`);
  if (s.fast) a.push("--fast");
  if (s.preview !== "auto") a.push("--preview-method", s.preview);
  if (s.cudaDevice) a.push("--cuda-device", s.cudaDevice);
  if (s.disableCudaMalloc) a.push("--disable-cuda-malloc");
  if (s.disablePartnerNodes) a.push("--disable-partner-nodes");
  if (s.manager && opts.managerReady) a.push("--enable-manager");
  a.push(...parseExtraArgs(s.extraArgs));
  return a;
}
