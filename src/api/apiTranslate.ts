/**
 * API страницы «Переводчик» (server/ts/routes/translate.ts).
 */
import { blobGet, multipart, req } from "@/api/apiHttp";

export type TrVariant = "q4" | "q4f16" | "dml";
export type TrProvider = "auto" | "cpu" | "dml" | "cuda" | "llamacpp";

export interface TrDownload {
  variant: TrVariant;
  status: "downloading" | "done" | "error" | "cancelled";
  bytes: number;
  total: number;
  file: string;
  error: string;
}

export interface TrStatus {
  runtime: { available: boolean; version: string; error: string };
  backends: string[];
  pack: boolean;
  /** GPU-пак поставлен, но нужен перезапуск приложения. */
  restart: boolean;
  platform: string;
  installed: TrVariant[];
  download: TrDownload | null;
  loaded: { provider: string; variant: TrVariant } | null;
  /** «вариант|провайдер», не прошедшие запуск или самопроверку. */
  failed: string[];
  languages: string[];
  ocrLanguages: string[];
  fileExt: string[];
}

export interface TrBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  lineH: number;
  text: string;
  dst: string;
  confidence: number;
}

export interface TrJob {
  id: string;
  kind: "text" | "file" | "image";
  status: "queued" | "loading" | "running" | "done" | "error" | "cancelled";
  src: string;
  tgt: string;
  done: number;
  total: number;
  partial: string;
  error: string;
  outName: string;
  blocks: TrBlock[];
  provider: string;
  variant: string;
  tokens: number;
  genMs: number;
  prefillMs: number;
  loadMs: number;
  /** Скорость генерации, токенов в секунду. */
  tps: number;
}

export interface TrOptions {
  src: string;
  tgt: string;
  provider: TrProvider;
  /** Для llamacpp — имя .gguf-файла. */
  variant: string;
}

const fields = (o: TrOptions): Record<string, string> => ({
  src: o.src,
  tgt: o.tgt,
  provider: o.provider,
  variant: o.variant,
});

export const translateApi = {
  trStatus: () => req<TrStatus>("GET", "/translate/status"),
  trModelDownload: (variant: TrVariant) => req<TrDownload>("POST", "/translate/model", { variant }),
  trModelCancel: () => req<{ ok: boolean }>("POST", "/translate/model/cancel"),
  trModelDelete: (variant: TrVariant) =>
    req<{ ok: boolean }>("DELETE", `/translate/model/${variant}`),
  trUnload: () => req<{ ok: boolean }>("POST", "/translate/unload"),
  trText: (text: string, o: TrOptions) =>
    req<TrJob>("POST", "/translate/text", { text, ...fields(o) }),
  trFile: (file: File, o: TrOptions, kind: "file" | "image") => {
    const fd = new FormData();
    fd.append("file", file);
    for (const [k, v] of Object.entries(fields(o))) fd.append(k, v);
    return multipart<TrJob>(`/translate/${kind}`, fd);
  },
  trJob: (id: string) => req<TrJob>("GET", `/translate/jobs/${id}`),
  trJobCancel: (id: string) => req<{ ok: boolean }>("POST", `/translate/jobs/${id}/cancel`),
  trJobDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/translate/jobs/${id}`),
  trJobDownload: (id: string) => blobGet(`/translate/jobs/${id}/download`),
};
