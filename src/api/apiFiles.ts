/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req, multipart, BASE, tokenHeaders, pageHeaders, pdfBlobPost } from "@/api/apiHttp";
import type {
  BookDownloadResult,
  MusicSearchResult,
  MusicDownloadStart,
  MusicJobStatus,
  MusicFormats,
  MusicPlaylist,
  PlaylistTrackInput,
  ScreenshotItem,
  DiskScanStatus,
  DiskNode,
  DiskExtStat,
} from "@/api/types";
import type {
  CompressorJob,
  CompressorHardware,
  CompressorPreset,
  SitebakJob,
  SitebakArchive,
  ArchivePagesResult,
} from "@/api/apiTypesMedia";

export const filesApi = {
  /** Скачать книгу по bid+fmt. */
  downloadBook: (bid: number, fmt: string) =>
    req<BookDownloadResult>("POST", "/books/download", { bid, fmt }),
  compressorReveal: (id: string) => req<{ path: string }>("GET", `/compressor/${id}/reveal`),
  archiveReveal: (id: string) => req<{ path: string }>("GET", `/archive/${id}/reveal`),

  // --- Compressor: матрица энкодеров (CPU/GPU), пресеты, рекомендатель ---
  compressVideo: (file: File, opts: Record<string, string | number | boolean>) => {
    const fd = new FormData();
    fd.append("file", file);
    for (const [k, v] of Object.entries(opts)) fd.append(k, String(v));
    return multipart<CompressorJob>("/compressor", fd);
  },
  compressorStatus: (id: string) => req<CompressorJob>("GET", `/compressor/${id}`),
  compressorDelete: (id: string) => req("DELETE", `/compressor/${id}`),
  compressorUrl: (id: string, what: "download" | "preview") => `/api/compressor/${id}/${what}`,
  compressorHardware: () => req<CompressorHardware>("GET", "/compressor/hardware"),
  compressorProbe: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<{
      codec?: string;
      width?: number;
      height?: number;
      fps?: string;
      bitRate?: number;
      duration?: number;
    }>("/compressor/probe", fd);
  },
  compressorCommand: (id: string) => req<{ command: string }>("GET", `/compressor/${id}/command`),
  compressorPresets: () =>
    req<{ system: CompressorPreset[]; custom: CompressorPreset[] }>("GET", "/compressor/presets"),
  compressorSavePreset: (p: { name: string } & Record<string, unknown>) =>
    req<{ ok: boolean; custom: CompressorPreset[] }>("POST", "/compressor/presets", p),
  compressorDeletePreset: (name: string) =>
    req<{ ok: boolean }>("DELETE", `/compressor/presets/${encodeURIComponent(name)}`),

  // --- Web Archive (.sitebak) ---
  archiveStart: (opts: Record<string, unknown>) => req<SitebakJob>("POST", "/archive/start", opts),
  archiveStatus: (id: string) => req<SitebakJob>("GET", `/archive/status/${id}`),
  archiveList: () => req<SitebakArchive[]>("GET", "/archive/list"),
  // Встроенный просмотр архива: список страниц внутри .sitebak. Сама страница
  // отдаётся archivePreview (в ней уже вырезаны скрипты и переписаны ссылки).
  archivePages: (id: string) => req<ArchivePagesResult>("GET", `/archive/${id}/pages`),
  archiveDelete: (id: string) => req("DELETE", `/archive/${id}`),
  archiveVerify: (id: string) =>
    req<{ ok: number; bad: number; total: number; badPaths: string[] }>(
      "POST",
      `/archive/${id}/verify`,
    ),
  archiveExtract: (id: string) =>
    req<{ ok: boolean; files: number }>("POST", `/archive/${id}/extract`),
  archiveDownload: (id: string) => `/api/archive/${id}/download`,
  archivePreview: (id: string, p = "") =>
    `/api/archive/${id}/file?path=${encodeURIComponent(p || "index.html")}`,
  /** Скачивает результат одним файлом (blob) с токеном, минуя CORS-проверку /api. */
  downloadConvert: async (key: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/convert/download/${encodeURIComponent(key)}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(
      (res.headers.get("content-disposition") || "").split("filename*=")[1]?.split("''")[1] ||
        (res.headers.get("content-disposition") || "").split("filename=")[1]?.replace(/"/g, "") ||
        "result",
    );
    return { blob: await res.blob(), name };
  },
  downloadVideoFile: async (key: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/video/download/${encodeURIComponent(key)}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(
      (res.headers.get("content-disposition") || "").split("filename*=")[1]?.split("''")[1] ||
        (res.headers.get("content-disposition") || "").split("filename=")[1]?.replace(/"/g, "") ||
        "result",
    );
    return { blob: await res.blob(), name };
  },
  downloadLhmEngine: () =>
    req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/download"),
  downloadCatalog: (id: number) => req("POST", `/catalog/${id}/download`),
  downloadAndInstall: (id: number) => req("POST", `/catalog/${id}/download-and-install`),
  downloadApp: (key: string) =>
    req<{ ok: boolean; method: string; file?: string; dir?: string }>("POST", "/apps/download", {
      key,
    }),

  // Music / Audio
  musicSearch: (q: string) =>
    req<MusicSearchResult>("GET", `/music/search?q=${encodeURIComponent(q)}`),
  musicDownload: (url: string, format?: string, quality?: number) =>
    req<MusicDownloadStart>("POST", "/music/download", { url, format, quality }),
  musicJobStatus: (id: string) => req<MusicJobStatus>("GET", `/music/status/${id}`),
  musicDownloadFile: (key: string) => {
    const t = window.appBridge?.getToken?.();
    return fetch(`/api/music/download/${key}`, {
      headers: t ? { "x-moonapp-token": t } : {},
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const disp = res.headers.get("content-disposition") || "";
      const match = /filename\*?=(?:UTF-8'')?([^;\s]+)/i.exec(disp);
      const name = match ? decodeURIComponent(match[1]) : "audio.mp3";
      const blob = await res.blob();
      return { blob, name };
    });
  },
  musicFormats: () => req<MusicFormats>("GET", "/music/formats"),
  musicPlaylists: () => req<MusicPlaylist[]>("GET", "/music/playlists"),
  musicPlaylistCreate: (name: string) => req<MusicPlaylist>("POST", "/music/playlists", { name }),
  musicPlaylistDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/music/playlists/${id}`),
  musicPlaylistAddTrack: (playlistId: string, track: PlaylistTrackInput) =>
    req<MusicPlaylist>("POST", `/music/playlists/${playlistId}/tracks`, track),
  musicPlaylistRemoveTrack: (playlistId: string, trackId: string) =>
    req<MusicPlaylist>("DELETE", `/music/playlists/${playlistId}/tracks/${trackId}`),

  // --- PDF-тулкит ---
  pdfMerge: async (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/merge`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  pdfSplit: async (file: File, ranges: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("ranges", ranges);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/split`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  pdfExtractText: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/extract-text`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ text: string; pages: number }>;
  },
  pdfRotate: async (file: File, angle: number) =>
    pdfBlobPost("/api/pdf/rotate", { file, angle: String(angle) }),
  pdfOrganize: async (file: File, order: string) =>
    pdfBlobPost("/api/pdf/organize", { file, order }),
  pdfWatermark: async (file: File, text: string, opacity: number) =>
    pdfBlobPost("/api/pdf/watermark", { file, text, opacity: String(opacity) }),
  pdfPageNumbers: async (file: File, startAt: number) =>
    pdfBlobPost("/api/pdf/page-numbers", { file, startAt: String(startAt) }),
  pdfImagesToPdf: async (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/images-to-pdf`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  pdfSign: async (file: File, signature: File, opts: { page?: number; width?: number } = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("signature", signature);
    if (opts.page != null) fd.append("page", String(opts.page));
    if (opts.width != null) fd.append("width", String(opts.width));
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/sign`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  pdfProtectStatus: () =>
    req<{ found: boolean; path: string | null }>("GET", "/pdf/protect/status"),
  pdfProtect: async (file: File, password: string) =>
    pdfBlobPost("/api/pdf/protect", { file, password }),
  pdfUnlock: async (file: File, password: string) =>
    pdfBlobPost("/api/pdf/unlock", { file, password }),
  pdfToJpg: async (file: File, dpi = 200) =>
    pdfBlobPost("/api/pdf/to-jpg", { file, dpi: String(dpi) }),
  pdfOcrStatus: () =>
    req<{ python: string; fitz: boolean; paddleocr: boolean; gpu: boolean; gpuChecked: boolean }>(
      "GET",
      "/pdf/ocr/status",
    ),
  pdfOcrInstallStatus: () =>
    req<{
      state: string;
      progress: number;
      phase: string;
      error: string;
      fitz: boolean;
      paddleocr: boolean;
      gpu: boolean;
    }>("GET", "/pdf/ocr/install"),
  pdfOcrInstall: (withOcr: boolean, device: "cpu" | "gpu" | "auto" = "auto") =>
    req<{ state: string; progress: number; phase: string; error: string }>(
      "POST",
      "/pdf/ocr/install",
      {
        withOcr,
        device,
      },
    ),
  pdfOcr: async (
    file: File,
    opts: { dpi?: number; lang?: string; device?: "cpu" | "gpu" } = {},
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.dpi != null) fd.append("dpi", String(opts.dpi));
    if (opts.lang) fd.append("lang", opts.lang);
    if (opts.device) fd.append("device", opts.device);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/pdf/ocr`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ text: string; pages: number }>;
  },

  // --- Word/PowerPoint/Excel ⇄ PDF (MS Office COM, если есть, иначе LibreOffice) ---
  officeStatus: () =>
    req<{
      found: boolean;
      libre: { found: boolean; path: string | null; version: string | null };
      msoffice: { word: boolean; excel: boolean; powerpoint: boolean; any: boolean };
    }>("GET", "/office/status"),
  officeConvert: async (file: File, to: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("to", to);
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/office/convert`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob, name: m ? m[1] : `converted.${to}` };
  },

  // --- OCR ---
  ocrRecognize: (file: File | Blob) => {
    const fd = new FormData();
    fd.append("file", file, "ocr.png");
    return multipart<{ text: string; confidence: number }>("/ocr/recognize", fd);
  },

  // --- Библиотека скриншотов и записей экрана ---
  screenshotsList: () => req<ScreenshotItem[]>("GET", "/screenshots"),
  screenshotsSaveImage: (blob: Blob, meta: { width?: number; height?: number }) => {
    const fd = new FormData();
    fd.append("file", blob, "shot.png");
    if (meta.width) fd.append("width", String(meta.width));
    if (meta.height) fd.append("height", String(meta.height));
    return multipart<ScreenshotItem>("/screenshots/image", fd);
  },
  screenshotsSaveVideo: (
    blob: Blob,
    meta: {
      width?: number;
      height?: number;
      durationSec?: number;
      bitrateMbps?: number;
      /** Путь к резервному WAV системного звука на Linux (см. audioCaptureLinux.ts)
       *  — файл уже лежит на диске этой же машины, не загружается заново. */
      extraAudioPath?: string | null;
    },
  ) => {
    const fd = new FormData();
    fd.append("file", blob, "rec.webm");
    if (meta.width) fd.append("width", String(meta.width));
    if (meta.height) fd.append("height", String(meta.height));
    if (meta.durationSec) fd.append("durationSec", String(Math.round(meta.durationSec)));
    if (meta.bitrateMbps) fd.append("bitrateMbps", String(meta.bitrateMbps));
    if (meta.extraAudioPath) fd.append("extraAudioPath", meta.extraAudioPath);
    return multipart<ScreenshotItem>("/screenshots/video", fd);
  },
  screenshotsDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/screenshots/${id}`),
  screenshotFileUrl: (id: string) => `${BASE}/api/screenshots/file/${id}`,

  // --- Анализатор диска (WinDirStat) ---
  diskScanRoots: () => req<{ roots: string[] }>("GET", "/diskscan/roots"),
  diskScanStart: (path: string) => req<{ id: string }>("POST", "/diskscan/start", { path }),
  diskScanStatus: (id: string) => req<DiskScanStatus>("GET", `/diskscan/status/${id}`),
  // Без path — корень; с path — один уровень поддерева (узел + прямые дети,
  // без внуков), см. пояснение в server/ts/diskScan.ts:getNode.
  diskScanResult: (id: string, path?: string) =>
    req<DiskNode>(
      "GET",
      `/diskscan/result/${id}${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  diskScanCancel: (id: string) => req<{ ok: boolean }>("POST", `/diskscan/cancel/${id}`),
  diskScanFiles: (path: string) =>
    req<{ files: DiskNode[] }>("GET", `/diskscan/files?path=${encodeURIComponent(path)}`),
  diskScanReveal: (path: string) => req<{ ok: boolean }>("POST", "/diskscan/reveal", { path }),
  diskScanConsole: (path: string, isDir: boolean) =>
    req<{ ok: boolean }>("POST", "/diskscan/console", { path, isDir }),
  diskScanDelete: (path: string, isDir: boolean) =>
    req<{ ok: boolean }>("POST", "/diskscan/delete", { path, isDir }),
  diskScanCompress: (path: string) =>
    req<{ ok: boolean; dest: string }>("POST", "/diskscan/compress", { path }),
  diskScanExts: (id: string) => req<{ exts: DiskExtStat[] }>("GET", `/diskscan/exts/${id}`),
  diskScanExtFiles: (id: string, ext: string) =>
    req<{ files: DiskNode[] }>("GET", `/diskscan/exts/${id}/files?ext=${encodeURIComponent(ext)}`),
};
