/**
 * API встроенного llama.cpp (server/ts/routes/llamacpp.ts): сборки, GGUF-модели, сервер.
 */
import { req } from "@/api/apiHttp";

export type LlamaBuildId = "cpu" | "vulkan" | "cuda";

export interface LlamaCatalogModel {
  id: string;
  kind: "translate" | "chat" | "tts";
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
  llamaStop: () => req<{ ok: boolean }>("POST", "/llamacpp/stop"),
};
