/**
 * Эмбеддинги через встроенный llama.cpp (EmbeddingGemma). Отдельный процесс llama-server,
 * независимый от того, что сейчас держит основной слот (чат, OCR, перевод): модель лёгкая
 * (~200–300 МБ) и работает на процессоре, чтобы не отнимать видеопамять у остальных.
 * Простаивающий сервер выгружается сам.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import logger from "../logger";
import config from "../config";
import { buildOrder, exePath, freePort, waitReady, type BuildId } from "./engine";
import { installed, modelPath } from "./models";

/** Размер вектора: Matryoshka-усечение 768 → 256 почти не теряет качества и втрое компактнее. */
export const DIM = 256;
const IDLE_MS = 5 * 60 * 1000;
const BATCH = 16;

export type EmbedKind = "query" | "doc" | "similar";

/** Настройки умного поиска (кнопка в шапке): включён ли, какая модель и на чём запускать. */
export interface EmbedConfig {
  enabled: boolean;
  /** Файл .gguf; пусто — лучшая из установленных. */
  model: string;
  device: "cpu" | "gpu" | "auto";
}
const CFG_FILE = path.join(config.DIRS.storage, "semantic", "config.json");
let cfg: EmbedConfig | null = null;

export function embedConfig(): EmbedConfig {
  if (cfg) return cfg;
  const d: EmbedConfig = { enabled: true, model: "", device: "cpu" };
  try {
    const v = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) as Partial<EmbedConfig>;
    if (typeof v.enabled === "boolean") d.enabled = v.enabled;
    if (typeof v.model === "string") d.model = v.model;
    if (v.device === "cpu" || v.device === "gpu" || v.device === "auto") d.device = v.device;
  } catch {
    /* первый запуск — значения по умолчанию */
  }
  cfg = d;
  return d;
}

export function setEmbedConfig(p: Partial<EmbedConfig>): EmbedConfig {
  const cur = embedConfig();
  const next: EmbedConfig = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled,
    model: typeof p.model === "string" ? p.model : cur.model,
    device: p.device === "cpu" || p.device === "gpu" || p.device === "auto" ? p.device : cur.device,
  };
  cfg = next;
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(next), "utf8");
  // Другая модель или устройство — процесс перезапустится при следующем запросе; выключено — сразу выгружаем.
  if (!next.enabled || next.model !== cur.model || next.device !== cur.device) stop();
  return next;
}

/** Установленные модели эмбеддингов (любой GGUF с «embedding» в имени). */
export function embedModels(): string[] {
  return installed()
    .map((m) => m.file)
    .filter((f) => /embedding/i.test(f) && !/mmproj/i.test(f));
}

/** Модель, которую выбрала бы настройка, не учитывая выключатель. */
export function embedModelChoice(): string | null {
  const all = embedModels();
  const c = embedConfig().model;
  if (c && all.includes(c)) return c;
  return all.find((f) => /q8_0/i.test(f)) ?? all[0] ?? null;
}

/** Файл модели для работы: null, если умный поиск выключен или модели нет. */
export function embedModelFile(): string | null {
  return embedConfig().enabled ? embedModelChoice() : null;
}

export function unloadEmbed(): void {
  stop();
}

interface Srv {
  proc: ChildProcess;
  gpu: boolean;
  base: string;
  file: string;
  build: BuildId;
  busy: number;
  idle: NodeJS.Timeout | null;
}

let srv: Srv | null = null;
let starting: Promise<Srv> | null = null;

function stop(): void {
  const s = srv;
  if (!s) return;
  if (s.idle) clearTimeout(s.idle);
  srv = null;
  try {
    s.proc.kill();
  } catch {
    /* уже завершён */
  }
  logger.info("embed.stopped", {});
}

process.once("exit", () => {
  try {
    srv?.proc.kill();
  } catch {
    /* ignore */
  }
});

function arm(s: Srv): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => {
    if (s.busy > 0) return arm(s);
    stop();
  }, IDLE_MS);
  s.idle.unref?.();
}

async function spawnOn(build: BuildId, file: string, gpu: boolean): Promise<Srv> {
  const exe = exePath(build);
  if (!exe) throw new Error("build_missing");
  const port = await freePort();
  const proc = spawn(
    exe,
    [
      "-m",
      modelPath(file),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--embeddings",
      "-c",
      "2048",
      "-b",
      "2048",
      "-ub",
      "2048",
      "-ngl",
      gpu ? "99" : "0",
      "-np",
      "1",
      "--no-webui",
      "-t",
      String(Math.max(1, Math.floor(os.cpus().length / 2))),
    ],
    { cwd: path.dirname(exe), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
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
  const s: Srv = { proc, gpu, base, file, build, busy: 0, idle: null };
  proc.once("exit", () => {
    if (srv === s) srv = null;
  });
  return s;
}

async function ensure(): Promise<Srv> {
  const file = embedModelFile();
  if (!file) throw new Error("embed_model_missing");
  if (srv && srv.file === file) return srv;
  if (srv) stop();
  if (starting) return starting;
  const dev = embedConfig().device;
  const candidates =
    dev === "cpu"
      ? buildOrder("cpu").length
        ? buildOrder("cpu")
        : buildOrder("auto")
      : buildOrder(dev);
  if (!candidates.length) throw new Error("build_missing");
  starting = (async () => {
    let last: unknown = null;
    for (const b of candidates) {
      try {
        const s = await spawnOn(b, file, b !== "cpu" && dev !== "cpu");
        srv = s;
        arm(s);
        logger.info("embed.started", { build: b, model: file });
        return s;
      } catch (e) {
        last = e;
        logger.warn("embed.start_failed", { build: b, error: String((e as Error).message) });
      }
    }
    throw new Error(
      `embed_start_failed: ${String((last as Error)?.message || last).slice(0, 300)}`,
    );
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Вставляет префиксы задач EmbeddingGemma: запрос, документ или сходство. */
export function withPrefix(text: string, kind: EmbedKind, title = "none"): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 6000);
  if (kind === "query") return `task: search result | query: ${t}`;
  if (kind === "similar") return `task: sentence similarity | query: ${t}`;
  return `title: ${title.replace(/\s+/g, " ").trim().slice(0, 200) || "none"} | text: ${t}`;
}

function shrink(v: number[]): Float32Array {
  const out = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) {
    out[i] = v[i] ?? 0;
    n += out[i] * out[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) out[i] /= n;
  return out;
}

/** Векторы для готовых строк (префикс уже добавлен), по порядку. */
export async function embedRaw(inputs: string[]): Promise<Float32Array[]> {
  if (!inputs.length) return [];
  const s = await ensure();
  s.busy++;
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += BATCH) {
      const res = await fetch(`${s.base}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: inputs.slice(i, i + BATCH), model: "embed" }),
      });
      if (!res.ok) throw new Error(`embed_${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
      const rows = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== Math.min(BATCH, inputs.length - i)) throw new Error("embed_bad_response");
      for (const r of rows) {
        const v = shrink(r.embedding);
        if (!Number.isFinite(v[0])) throw new Error("embed_nan");
        out.push(v);
      }
    }
    return out;
  } finally {
    s.busy--;
    arm(s);
  }
}

export const embedLoaded = (): boolean => !!srv;
export const embedRuntime = (): { file: string; gpu: boolean; build: string } | null =>
  srv ? { file: srv.file, gpu: srv.gpu, build: srv.build } : null;
