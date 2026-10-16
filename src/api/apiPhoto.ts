/**
 * API страницы «Фото и видео» (server/ts/routes/photo.ts): удаление фона, InvSR, замена лица.
 */
import { req, multipart, blobGet } from "@/api/apiHttp";

export interface SetupState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
  id: string | null;
  received: number;
  total: number;
}

export interface PhotoModel {
  id: string;
  feature: "bgremove" | "faceswap";
  title: string;
  license: string;
  sizeMb: number;
  installed: boolean;
}

export interface PhotoModelsState {
  models: PhotoModel[];
  task: SetupState;
}

export interface PhotoTool {
  id: "invsr" | "faceswap" | "chatterbox";
  title: string;
  license: string;
  note: string;
  python: string;
  sizeMb: { cuda: number; cpu: number };
  ready: boolean;
  missing: string[];
  installed: boolean;
}

export interface PhotoInstallSnapshot {
  state: SetupState;
  tool: string;
  device: string;
  step: string;
  steps: string[];
  log: string[];
}

export interface PhotoToolsState {
  tools: PhotoTool[];
  install: PhotoInstallSnapshot;
  liveRunning: boolean;
}

export interface PhotoJob {
  id: string;
  tool: "invsr" | "faceswap";
  state: "running" | "done" | "error" | "cancelled";
  progress: number;
  stage: string;
  log: string[];
  out: string;
  error: string;
  startedAt: number;
  finishedAt: number;
}

export interface BgResult {
  name: string;
  url: string;
  provider: string;
  sec: number;
}

export const photoApi = {
  photoModels: () => req<PhotoModelsState>("GET", "/photo/models"),
  photoModelDownload: (id: string) => req<SetupState>("POST", "/photo/models/download", { id }),
  photoModelCancel: () => req<SetupState>("POST", "/photo/models/cancel"),
  photoModelRemove: (id: string) => req<{ ok: boolean }>("DELETE", `/photo/models/${id}`),

  photoBgRemove: (file: File, opts: { model: string; mode: string; color?: string }) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("model", opts.model);
    fd.append("mode", opts.mode);
    if (opts.color) fd.append("color", opts.color);
    return multipart<BgResult>("/photo/bg-remove", fd);
  },
  /** Результат как blob (токен идёт в заголовке, <img src> его передать не может). */
  photoFile: (name: string) => blobGet(`/photo/file/${encodeURIComponent(name)}`),

  photoTools: () => req<PhotoToolsState>("GET", "/photo/tools"),
  photoToolInstall: (id: string, device: "cuda" | "cpu") =>
    req<PhotoInstallSnapshot>("POST", "/photo/tools/install", { id, device }),
  photoToolInstallState: () => req<PhotoInstallSnapshot>("GET", "/photo/tools/install"),
  photoToolCancel: () => req<PhotoInstallSnapshot>("POST", "/photo/tools/cancel"),
  photoToolRemove: (id: string) => req<{ ok: boolean }>("DELETE", `/photo/tools/${id}`),

  photoInvsr: (file: File, opts: { steps: number; tile: number; colorFix: string }) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("steps", String(opts.steps));
    fd.append("tile", String(opts.tile));
    fd.append("colorFix", opts.colorFix);
    return multipart<PhotoJob>("/photo/invsr", fd);
  },
  photoFaceSwap: (
    source: File,
    target: File,
    opts: {
      device: "cuda" | "cpu";
      enhance: boolean;
      manyFaces: boolean;
      mouthMask: boolean;
      quality: number;
    },
  ) => {
    const fd = new FormData();
    fd.append("source", source);
    fd.append("target", target);
    for (const [k, v] of Object.entries(opts)) fd.append(k, String(v));
    return multipart<PhotoJob>("/photo/faceswap", fd);
  },
  photoFaceLive: (on: boolean, device: "cuda" | "cpu") =>
    req<{ running: boolean }>("POST", "/photo/faceswap/live", { on, device }),

  photoJob: (id: string) => req<PhotoJob>("GET", `/photo/jobs/${id}`),
  photoJobCancel: (id: string) => req<{ ok: boolean }>("POST", `/photo/jobs/${id}/cancel`),
};
