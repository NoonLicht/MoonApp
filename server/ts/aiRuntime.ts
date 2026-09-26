/**
 * Единый рантайм для ИИ-функций удобства (заметки/задачи, ai-чат, лекции,
 * игры, конвертация/апскейл/сжатие, монитор, бюджет, фильмы, книги).
 *
 * Режим по умолчанию — DeepSeek API (ключ "deepseek" из server/security.js,
 * тот же секрет, что уже использует ai-чат). Альтернатива — локальная ONNX-
 * модель (Qwen2.5, качается по требованию через @huggingface/transformers,
 * который сам гоняет её на onnxruntime-node — та же библиотека, что уже
 * использует апскейл). Третий режим — полностью выключено.
 *
 * На каждой странице переключатель хранит выбор здесь же (storage/ai-settings.json)
 * и читается заново при КАЖДОМ вызове runFeature — поэтому смена режима
 * применяется сразу к следующему действию, без перезапуска страницы.
 *
 * TS-исходник, как server/ts/notesAi.ts: компилируется в server/aiRuntime.js
 * командой `npm run compile:server`.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";

/* eslint-disable @typescript-eslint/no-require-imports */
const providers = require("./providers") as {
  getProvider: (id: string) => {
    chat: (o: {
      secret: string;
      model: string;
      messages: Array<{ role: string; text: string }>;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
    }) => Promise<string>;
  };
};
const security = require("./security") as {
  getSecret: (name: string) => string;
  hasSecret: (name: string) => boolean;
};

const { FILES, DIRS } = config;

export type AiMode = "api" | "local" | "off";

export const AI_FEATURES = [
  "notes",
  "chat",
  "lecture",
  "games",
  "convert",
  "monitor",
  "budget",
  "movies",
  "books",
] as const;
export type AiFeatureId = (typeof AI_FEATURES)[number];

export interface AiFeatureSetting {
  mode: AiMode;
  /** id модели из LOCAL_MODEL_CATALOG — только для mode === "local". */
  localModel?: string;
}
export type AiSettingsMap = Record<AiFeatureId, AiFeatureSetting>;

const DEFAULT_SETTING: AiFeatureSetting = { mode: "api" };

function readSettingsRaw(): Partial<AiSettingsMap> {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.aiSettings, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeSettingsRaw(s: AiSettingsMap): void {
  fs.writeFileSync(FILES.aiSettings, JSON.stringify(s, null, 2), "utf8");
}

/** Настройки всех фич сразу (для страницы Settings/тумблеров). */
export function getAiSettings(): AiSettingsMap {
  const raw = readSettingsRaw();
  const out = {} as AiSettingsMap;
  for (const f of AI_FEATURES) out[f] = { ...DEFAULT_SETTING, ...(raw[f] || {}) };
  return out;
}

/** Меняет режим/модель одной фичи. Применяется сразу — следующий вызов
 *  runFeature(feature, ...) уже читает новое значение, перезапуск не нужен. */
export function setFeatureSetting(
  feature: string,
  patch: Partial<AiFeatureSetting>,
): AiFeatureSetting {
  if (!(AI_FEATURES as readonly string[]).includes(feature)) {
    throw new Error(`unknown_ai_feature: ${feature}`);
  }
  const all = getAiSettings();
  const id = feature as AiFeatureId;
  all[id] = { ...all[id], ...patch };
  if (all[id].mode !== "local") delete all[id].localModel;
  writeSettingsRaw(all);
  return all[id];
}

/* ---------------------------------------------------------------------- */
/* Каталог локальных ONNX-моделей (скачиваются по требованию)             */
/* ---------------------------------------------------------------------- */

export interface LocalModelInfo {
  id: string;
  label: string;
  /** HF repo с готовым ONNX-экспортом (onnx-community — квантованные сборки). */
  repo: string;
  approxSizeMb: number;
  hint: string;
}

export const LOCAL_MODEL_CATALOG: LocalModelInfo[] = [
  {
    id: "qwen2.5-0.5b",
    label: "Qwen2.5 0.5B Instruct",
    repo: "onnx-community/Qwen2.5-0.5B-Instruct",
    approxSizeMb: 500,
    hint: "Самая лёгкая — только для простых структурированных задач (категории, короткие подписи).",
  },
  {
    id: "qwen2.5-1.5b",
    label: "Qwen2.5 1.5B Instruct",
    repo: "onnx-community/Qwen2.5-1.5B-Instruct",
    approxSizeMb: 1600,
    hint: "Баланс скорости и качества — разумный вариант по умолчанию для CPU.",
  },
  {
    id: "qwen2.5-3b",
    label: "Qwen2.5 3B Instruct",
    repo: "onnx-community/Qwen2.5-3B-Instruct",
    approxSizeMb: 3200,
    hint: "Заметно связнее (конспекты, рекомендации) — медленнее на слабом CPU.",
  },
];

function localModelInfo(id: string): LocalModelInfo {
  const info = LOCAL_MODEL_CATALOG.find((m) => m.id === id);
  if (!info) throw new Error(`unknown_local_model: ${id}`);
  return info;
}

const INSTALLED_FILE = path.join(DIRS.aiModels, "installed.json");
function readInstalled(): Record<string, boolean> {
  try {
    return JSON.parse(fs.readFileSync(INSTALLED_FILE, "utf8"));
  } catch {
    return {};
  }
}
function markInstalled(id: string, val: boolean): void {
  const m = readInstalled();
  if (val) m[id] = true;
  else delete m[id];
  fs.writeFileSync(INSTALLED_FILE, JSON.stringify(m, null, 2), "utf8");
}

export interface LocalModelStatus {
  state: "idle" | "downloading" | "loading" | "ready" | "error";
  progress?: number;
  error?: string;
}
const loadStatus = new Map<string, LocalModelStatus>();
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const loadedPipelines = new Map<string, Promise<any>>();

export function getLoadStatus(id: string): LocalModelStatus {
  return loadStatus.get(id) || { state: readInstalled()[id] ? "idle" : "idle" };
}

export function listLocalModels(): Array<LocalModelInfo & { installed: boolean; status: LocalModelStatus }> {
  const installed = readInstalled();
  return LOCAL_MODEL_CATALOG.map((m) => ({
    ...m,
    installed: !!installed[m.id],
    status: getLoadStatus(m.id),
  }));
}

/** Выгружает модель из памяти (не с диска) — например, перед удалением файлов. */
export function unloadLocalModel(id: string): void {
  loadedPipelines.delete(id);
  loadStatus.delete(id);
}

/** Удаляет скачанные веса модели с диска и выгружает её из памяти. */
export function deleteLocalModel(id: string): void {
  const info = localModelInfo(id);
  unloadLocalModel(id);
  markInstalled(id, false);
  try {
    const dir = path.join(DIRS.aiModels, ...info.repo.split("/"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.warn("ai.deleteLocalModel: rmSync failed", { id, err: String(e) });
  }
}

/**
 * Скачивает (если нужно) и загружает модель в память — это и есть кнопка
 * «Запустить» в переключателе на странице: пользователь явно инициирует
 * загрузку, а не она происходит незаметно при первом клике по фиче.
 */
export async function warmLocalModel(id: string): Promise<void> {
  const info = localModelInfo(id);
  const existing = loadedPipelines.get(id);
  if (existing) {
    await existing;
    return;
  }
  loadStatus.set(id, { state: "downloading", progress: 0 });
  const promise = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = DIRS.aiModels + path.sep;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    const pipe = await pipeline("text-generation", info.repo, {
      dtype: "q4",
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      progress_callback: (pr: any) => {
        if (pr?.status === "progress") {
          loadStatus.set(id, { state: "downloading", progress: Math.round(pr.progress || 0) });
        } else if (pr?.status === "done") {
          loadStatus.set(id, { state: "loading", progress: 100 });
        }
      },
    });
    markInstalled(id, true);
    loadStatus.set(id, { state: "ready" });
    return pipe;
  })();
  loadedPipelines.set(id, promise);
  try {
    await promise;
  } catch (e) {
    loadedPipelines.delete(id);
    loadStatus.set(id, { state: "error", error: String((e as Error)?.message || e) });
    throw e;
  }
}

/* ---------------------------------------------------------------------- */
/* Выполнение запроса — маршрутизация по режиму фичи                      */
/* ---------------------------------------------------------------------- */

export interface AiRunOptions {
  system?: string;
  user: string;
  maxTokens?: number;
}
export interface AiRunResult {
  text: string;
  mode: AiMode;
  model: string;
}

const DEEPSEEK_MODEL = "deepseek-chat";

/**
 * Единая точка входа для всех фич. Настройки читаются заново на каждый вызов —
 * тумблер на странице действует сразу, без перезапуска и повтора действия.
 */
export async function runFeature(
  feature: AiFeatureId,
  opts: AiRunOptions,
): Promise<AiRunResult> {
  const setting = getAiSettings()[feature];
  if (setting.mode === "off") throw new Error("ai_feature_off");

  if (setting.mode === "api") {
    if (!security.hasSecret("deepseek")) throw new Error("ai_no_api_key");
    const provider = providers.getProvider("deepseek");
    const secret = security.getSecret("deepseek");
    const messages: Array<{ role: string; text: string }> = [];
    if (opts.system) messages.push({ role: "system", text: opts.system });
    messages.push({ role: "user", text: opts.user });
    const text = await provider.chat({
      secret,
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.4,
      maxTokens: opts.maxTokens || 600,
      stream: false,
    });
    return { text, mode: "api", model: DEEPSEEK_MODEL };
  }

  // mode === "local"
  if (!setting.localModel) throw new Error("ai_no_local_model");
  const id = setting.localModel;
  if (getLoadStatus(id).state !== "ready") await warmLocalModel(id);
  const pipe = await loadedPipelines.get(id);
  if (!pipe) throw new Error("ai_local_model_not_loaded");
  const info = localModelInfo(id);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const messages: any[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });
  const out = await pipe(messages, {
    max_new_tokens: opts.maxTokens ? Math.min(opts.maxTokens, 512) : 400,
    do_sample: false,
  });
  const gen = out?.[0]?.generated_text;
  const last = Array.isArray(gen) ? gen[gen.length - 1] : gen;
  const text = typeof last === "string" ? last : last?.content || "";
  return { text, mode: "local", model: info.label };
}
