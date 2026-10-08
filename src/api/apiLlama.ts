/**
 * API встроенного llama.cpp (server/ts/routes/llamacpp.ts): сборки, GGUF-модели, сервер.
 */
import { BASE, pageHeaders, req, tokenHeaders } from "@/api/apiHttp";

export type LlamaBuildId = "cpu" | "vulkan" | "cuda";

export interface LlamaCatalogModel {
  id: string;
  kind: "translate" | "chat" | "tts" | "ocr";
  repo: string;
  file: string;
  sizeMb: number;
  note: string;
  extra?: { file: string; sizeMb: number }[];
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

export const llamaApi = {
  llamaStatus: () => req<LlamaStatus>("GET", "/llamacpp/status"),
  llamaBuildInstall: (id: LlamaBuildId) => req<unknown>("POST", "/llamacpp/build", { id }),
  llamaBuildCancel: () => req<unknown>("POST", "/llamacpp/build/cancel"),
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
  llamaStop: () => req<{ ok: boolean }>("POST", "/llamacpp/stop"),
};
