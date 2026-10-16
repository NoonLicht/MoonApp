/**
 * API встроенного llama.cpp (server/ts/routes/llamacpp.ts): сборки, GGUF-модели, сервер.
 */
import { BASE, pageHeaders, req, tokenHeaders } from "@/api/apiHttp";

export type LlamaBuildId = "cpu" | "vulkan" | "cuda";

export interface LlamaCatalogModel {
  id: string;
  kind: "translate" | "chat" | "tts" | "ocr" | "embed";
  repo: string;
  file: string;
  sizeMb: number;
  /** Квант (q4km, q5km…). */
  note: string;
  /** Семейство: кванты одной модели сворачиваются в группу. */
  group: string;
  title: string;
  vision?: boolean;
  extra?: { file: string; sizeMb: number; as?: string }[];
}

export interface LlamaPlacement {
  layersGpu: number;
  layersTotal: number;
  gpuMb: number;
  cpuMb: number;
  kvGpuMb: number;
  kvCpuMb: number;
  device: string;
  moe: boolean;
  mode: "cpu" | "gpu-full" | "gpu-partial";
  fit: string;
}

export interface LlamaRouterSettings {
  devices: Record<string, string>;
  maxLoaded: number;
  moeOffload: boolean;
  defaultModel: string;
  autoWarm: boolean;
  idleMinutes: number;
  /** Окно контекста чатовых моделей, токены. */
  ctx: number;
}

export interface LlamaActivity {
  loaded: {
    file: string;
    task: string;
    busy: boolean;
    gpu: boolean;
    build: string;
    device: string;
    ctx: number;
    mmproj: string;
    place: LlamaPlacement;
  }[];
  loading: { file: string; task: string }[];
  limit: number;
  laptop: boolean;
  ramMb: number;
  /** Модели, которые не удалось загрузить: код причины для перевода и подробности. */
  failed: { file: string; code: string; detail: string; device: string; at: number }[];
  /** Видеокарта, которую видит система. */
  gpu: { present: boolean; name: string; vramMb: number };
  /** Сборки, временно отключённые после сбоя самой сборки. */
  badBuilds: LlamaBuildId[];
}

export interface LlamaStatus {
  tag: string;
  platform: string;
  builds: { id: LlamaBuildId; sizeMb: number; installed: boolean }[];
  failedBuilds: LlamaBuildId[];
  install: {
    state: "idle" | "working" | "done" | "error";
    id: string | null;
    progress: number;
    phase: string;
    error: string;
  };
  catalog: LlamaCatalogModel[];
  models: { file: string; sizeMb: number }[];
  download: {
    file: string;
    status: "downloading" | "done" | "error" | "cancelled";
    bytes: number;
    total: number;
    error: string;
  } | null;
  server: { build: LlamaBuildId; gpu: boolean; model: string; file: string } | null;
  activity: LlamaActivity;
  router: LlamaRouterSettings;
  /** Установленные модели Chandra OCR 2 (без проекторов). */
  ocrModels: { file: string; sizeMb: number }[];
}

export interface LlamaOcrResult {
  html: string;
  tokens: number;
  ms: number;
  build: string;
  gpu: boolean;
  model: string;
}

export interface AiFeatureDef {
  id: string;
  group: "chat" | "notes" | "mail" | "lecture" | "translate";
  task: string;
  /** Функцию можно выключить целиком. */
  switchable?: boolean;
}
export interface AiBinding {
  /** false — функция выключена. Нет поля — включена. */
  enabled?: boolean;
  auto: boolean;
  provider: string;
  model: string;
}
export interface AiBindingsData {
  features: AiFeatureDef[];
  bindings: Record<string, AiBinding>;
  providers: { id: string; label: string; local: boolean; configured: boolean }[];
}

export const llamaApi = {
  /** Привязка модели к ИИ-функциям (Настройки → «Привязка моделей ИИ»). */
  aiBindings: () => req<AiBindingsData>("GET", "/ai-bindings"),
  aiBindingSet: (id: string, patch: Partial<AiBinding>) =>
    req<AiBinding>("PUT", `/ai-bindings/${encodeURIComponent(id)}`, patch),
  aiBindingsReset: () => req<{ ok: boolean }>("POST", "/ai-bindings/reset"),
  llamaStatus: () => req<LlamaStatus>("GET", "/llamacpp/status"),
  llamaBuildInstall: (id: LlamaBuildId) => req<unknown>("POST", "/llamacpp/build", { id }),
  llamaBuildCancel: () => req<unknown>("POST", "/llamacpp/build/cancel"),
  /** Вернуть сборки, отключённые после сбоя, и сбросить ошибки загрузки. */
  llamaResetBuilds: () => req<{ ok: boolean }>("POST", "/llamacpp/reset-builds"),
  llamaBuildRemove: (id: LlamaBuildId) => req<{ ok: boolean }>("DELETE", `/llamacpp/build/${id}`),
  llamaModelDownload: (body: { id?: string; url?: string }) =>
    req<unknown>("POST", "/llamacpp/model", body),
  llamaModelCancel: () => req<{ ok: boolean }>("POST", "/llamacpp/model/cancel"),
  llamaModelRemove: (file: string) =>
    req<{ ok: boolean }>("DELETE", `/llamacpp/model/${encodeURIComponent(file)}`),
  /** Распознать картинку моделью Chandra OCR 2 (ответ — HTML-блоки с координатами). */
  llamaOcr: async (
    image: Blob,
    o: { model?: string; device?: string; signal?: AbortSignal },
  ): Promise<LlamaOcrResult> => {
    const q = new URLSearchParams();
    if (o.model) q.set("model", o.model);
    if (o.device) q.set("device", o.device);
    const res = await fetch(`${BASE}/api/llamacpp/ocr?${q}`, {
      method: "POST",
      headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": image.type || "image/jpeg" },
      body: image,
      signal: o.signal,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  /** Загрузить PDF для распознавания: сервер хранит файл и отдаёт страницы картинками. */
  llamaPdfOpen: async (pdf: Blob, signal?: AbortSignal): Promise<{ id: string; pages: number }> => {
    const res = await fetch(`${BASE}/api/llamacpp/ocr/pdf`, {
      method: "POST",
      headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/pdf" },
      body: pdf,
      signal,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  llamaPdfPage: async (id: string, page: number, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/llamacpp/ocr/pdf/${id}/${page}?width=1800`, {
      headers: { ...tokenHeaders(), ...pageHeaders() },
      signal,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  llamaPdfClose: (id: string) =>
    fetch(`${BASE}/api/llamacpp/ocr/pdf/${id}`, {
      method: "DELETE",
      headers: { ...tokenHeaders(), ...pageHeaders() },
    }).catch(() => undefined),
  /** Скачать картинку по внешней ссылке через сервер (в обход CORS). */
  llamaFetchImage: async (url: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/llamacpp/ocr/fetch?url=${encodeURIComponent(url)}`, {
      headers: { ...tokenHeaders(), ...pageHeaders() },
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  llamaStop: (file?: string) => req<{ ok: boolean }>("POST", "/llamacpp/stop", { file }),
  /** Загрузить модель вручную; device: auto | cpu | gpu (запоминается для этой модели). */
  llamaLoad: (file: string, device?: string) =>
    req<{ file: string; started: boolean }>("POST", "/llamacpp/load", { file, device }),
  llamaActivity: () => req<LlamaActivity>("GET", "/llamacpp/activity"),
  llamaSetRouter: (patch: Partial<LlamaRouterSettings>) =>
    req<LlamaRouterSettings>("POST", "/llamacpp/settings", patch),
  /** Загрузить модель под задачу заранее: command | summary | translate | chat | vision | stt. */
  llamaWarm: (task: string) =>
    req<{ file: string | null; started: boolean }>("POST", "/llamacpp/warm", { task }),
};
