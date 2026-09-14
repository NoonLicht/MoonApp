/**
 * Типизированный API-клиент к Node-бэкенду (Express).
 *
 * Как это работает:
 *  - все запросы идут на `${BASE}/api/<путь>` (BASE пустой: фронт и API на одном
 *    origin — Vite-proxy в dev, раздача Express в prod);
 *  - каждый запрос несёт заголовок x-moonapp-token (токен генерирует Electron,
 *    см. electron/main.js → preload.js → window.appBridge.getToken);
 *  - streamChatSend/streamArena читают SSE-стрим через fetch + ReadableStream.
 */
import type {
  AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation,
  ConvertTools, ConvertResult, ConvertInstallStatus,
  VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus,
  LhmStatus, MonitorSnapshot, ProviderInfo, ProxyStatus, VlessProfile,
  ProxyCoreStatus, ProxyNode, ProxySubscription, ProxyPageRule, ProxyLatency, ProxyInstallStatus, ProxyPingStatus,
  FlibustaBook, BookGenre, BooksFeedResult, BookDownloadResult,
  GraphData, GraphNode, GraphEdge,
  MusicTrack, MusicSearchResult, MusicFormats, MusicDownloadStart, MusicJobStatus,
  VaultFile, VaultFileContent, VaultSearchResult, VaultTag, VaultBacklink,
  TaskItem, TaskCreatePayload,
  HolstFileEntry, HolstReadResult, HolstWriteResult,
  MediaKind, MediaSummary, MediaDetails, MediaCast, MediaCrew, MediaVideo, MediaProvider,
  MediaProviders, MediaGallery, MediaGenre, MediaListResult, MediaWatchStatus,
  MediaWatchlistEntry, MediaRatingEntry, MediaWatchEntry, MediaState, MediaLibrary,
  MediaStats, MediaStatus, TorrentFile, TorrentAddResult, TorrentStatus,
} from "./types";
import { logEvent, getCurrentPage } from "../utils/telemetry";

export type { AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation, ConvertTools, ConvertResult, ConvertInstallStatus, VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus, LhmStatus, MonitorSnapshot, ProviderInfo, ProxyStatus, VlessProfile, FlibustaBook, BookGenre, BooksFeedResult, BookDownloadResult, MusicTrack, MusicSearchResult, MusicFormats, MusicDownloadStart, MusicJobStatus, VaultFile, VaultFileContent, VaultSearchResult, VaultTag, VaultBacklink, TaskItem, TaskCreatePayload, HolstFileEntry, HolstReadResult, HolstWriteResult, MediaKind, MediaSummary, MediaDetails, MediaCast, MediaCrew, MediaVideo, MediaProvider, MediaProviders, MediaGallery, MediaGenre, MediaListResult, MediaWatchStatus, MediaWatchlistEntry, MediaRatingEntry, MediaWatchEntry, MediaState, MediaLibrary, MediaStats, MediaStatus, TorrentFile, TorrentAddResult, TorrentStatus };

const BASE = ""; // тот же origin: фронт и API вместе (Vite-proxy или раздача Express)

/* --- Типы новых модулей: Compressor / TTS / Sitebak --- */
export interface CompressorJob {
  id: string; name: string; size: number;
  stage: "queued" | "analyze" | "encode" | "done" | "error";
  progress: number; etaSec: number | null;
  steps: string[]; error: string; done: boolean;
  outSize: number;
  codec: string; engine: string; engineUsed?: string; qualityMode: string;
  crf: number; targetKbps: number; maxKbps: number; speed: string;
  tenBit: boolean; targetHeight: string; audio: string; audioKbps: number;
  fallbacks?: string[]; command?: string; durationSec?: number;
  info?: { width?: number; height?: number; codec?: string; fps?: string; bitRate?: number };
}
export interface CompressorHardware {
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  cpu: { name: string; coresPhysical: number; coresLogical: number };
  gpus: { vendor: string; name: string; tier: string }[];
  methods: Record<string, boolean>;
  recommended: { engine: string; codec: string; qualityMode: string; crf: number; speed: string; hwName: string; reason: string };
  optimal: Record<string, any>;
  speedScales: Record<string, string[]>;
}
export interface CompressorPreset {
  id?: string; name?: string; createdAt?: number;
  params: Record<string, unknown>;
  targetMB?: number;
}
export interface TtsProfile {
  id: string; name: string; refFile?: string; engine?: "f5" | "xtts";
  language?: string; createdAt: number;
}
export interface TtsPreset {
  id: string; name: string; builtin?: boolean; engine: "f5" | "xtts";
  params: Record<string, unknown>; refFile?: string; createdAt?: number;
}
export interface TtsHardware {
  gpu: { found: boolean; name: string; vramTotalGb: number; vramUsedGb: number; utilPct: number; driver: string };
  cpu: { name: string; cores: number };
  platform: string;
  optimal: Record<string, unknown> & { precision?: string; nfe?: string; cfg?: string; vram?: number };
}
export interface TtsChunk { text?: string; pauseMs?: number }
export interface TtsBookChapter { title: string; text: string }
export interface TtsBook {
  title: string; author: string; coverImage: string | null;
  chapters: TtsBookChapter[]; format?: string; encoding?: string;
}
export interface TtsJob {
  id: string; engine: string; stage: string; progress: number; chunkIndex: number; chunksTotal: number;
  error: string; done: boolean; outSize: number; outFile?: string;
  vram?: { usedGb: number; totalGb: number; utilPct: number } | null;
  opts?: { format?: string; title?: string; author?: string };
  chunksPreview?: TtsChunk[];
}
export interface SitebakJob {
  id: string; url: string; name: string; stage: string; progress: number;
  pages: number; origSize: number; bakSize: number; error: string; done: boolean;
  stats?: { pages: number; origSize: number; bakSize: number; savedPct: number; compression?: { textAlgo: string; ratio: number }; rendered?: boolean };
}
export interface SitebakArchive {
  id: string; name: string; site: string; createdAt: number;
  stats?: SitebakJob["stats"];
}

function tokenHeaders(): Record<string, string> {
  const t = window.appBridge?.getToken?.();
  return t ? { "x-moonapp-token": t } : {};
}

/**
 * Заголовок X-App-Page: какой страницей инициирован запрос. По нему бэкенд
 * решает, идти во внешнюю сеть напрямую или через прокси (per-page правила,
 * см. server/middleware/perPageProxy.js + таблицу proxy_page_rules).
 * На уровне Chromium такая фильтрация невозможна — все страницы SPA делят один
 * origin, поэтому разграничение живёт на бэкенде.
 */
function pageHeaders(): Record<string, string> {
  return { "X-App-Page": getCurrentPage() };
}

async function req<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const t0 = Date.now();
  const ts = () => Date.now() - t0;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${url}`, {
      method,
      headers: {
        ...tokenHeaders(),
        ...pageHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Сетевой сбой (сервер не отвечает) — в общий журнал для диагностики.
    logEvent("error", "api.fail", { method, path: url, ms: ts(), error: (e as Error).message });
    throw e;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code: string | undefined;
    try { const j = await res.json(); msg = j.error || msg; code = j.code; } catch { /* keep default */ }
    if (url !== "/health") logEvent("error", "api.error", { method, path: url, status: res.status, ms: ts(), error: msg });
    const err = new Error(msg) as Error & { code?: string; status?: number };
    err.code = code;
    err.status = res.status;
    throw err;
  }
  if (url !== "/health") logEvent("action", "api.ok", { method, path: url, status: res.status, ms: ts() });
  return (res.status === 204 ? null : await res.json()) as T;
}

function toFormData(file: File, to: string): FormData {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("to", to);
  return fd;
}

/**
 * Multipart-запрос к бэкенду (загрузка файла).
 * Доступ к токену прокидывается так же, как в req(); Content-Type с boundary
 * браузер ставит сам. Ошибки обрабатываются как в req().
 */
async function multipart<T = unknown>(url: string, formData: FormData): Promise<T> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api${url}`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders() },
    body: formData,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    logEvent("error", "api.error", { method: "POST(multipart)", path: url, status: res.status, ms: Date.now() - t0, error: msg });
    throw new Error(msg);
  }
  logEvent("action", "api.ok", { method: "POST(multipart)", path: url, status: res.status, ms: Date.now() - t0 });
  return res.json() as T;
}

export const api = {
  // Health
  health: () => req<{ ok: boolean }>("GET", "/health"),

  // Lecture Recorder
  lectureEngine: () => req<LectureEngineStatus>("GET", "/lecture/engine"),
  lectureSessions: () => req<LectureSession[]>("GET", "/lecture/sessions"),
  lectureCreate: (title: string) =>
    req<LectureCreateResult>("POST", "/lecture/sessions", { title, sampleRate: 16000, channels: 1 }),
  lectureStatus: (id: number) => req<LectureStatus>("GET", `/lecture/${id}`),
  lectureIngest: (id: number, body: ArrayBuffer) => rawPost(`/api/lecture/${id}/ingest`, body),
  lectureEditChunk: (chunkId: number, text: string) =>
    req<LectureChunk>("PATCH", `/lecture/chunks/${chunkId}`, { text }),
  lectureMarker: (id: number, atMs: number, label: string) =>
    req<{ atMs: number; timestamp: string; label: string }>("POST", `/lecture/${id}/markers`, { atMs, label }),
  lectureStop: (id: number) => req<LectureStatus>("POST", `/lecture/${id}/stop`),
  lectureDelete: (id: number) => req<{ ok: boolean }>("DELETE", `/lecture/${id}`),
  lectureExportUrl: (id: number, format: "md" | "srt" | "vtt") => `/api/lecture/${id}/export?format=${format}`,
  lectureAudioUrl: (id: number) => `/api/lecture/${id}/audio`,
  lectureConspectus: (id: number) =>
    req<{ markdown: string; model: string }>("POST", `/lecture/${id}/conspectus`),

  // Zapret / DPI Bypass
  zapretEngine: () => req<ZapretEngine>("GET", "/zapret/engine"),
  zapretStrategies: () => req<ZapretStrategy[]>("GET", "/zapret/strategies"),
  zapretBatFiles: () => req<ZapretBatFile[]>("GET", "/zapret/bat-files"),
  zapretUpdate: () => req<ZapretUpdate>("GET", "/zapret/update"),
  zapretInstall: (body?: { tag?: string }) => req<ZapretInstallState>("POST", "/zapret/install", body || {}),
  zapretInstallStatus: () => req<ZapretInstallState>("GET", "/zapret/install-status"),
  zapretPayloads: () => req<ZapretPayload[]>("GET", "/zapret/payloads"),
  zapretStatus: () => req<ZapretStatus>("GET", "/zapret/status"),
  zapretStart: (body: { strategyId?: string; customArgs?: string; mode?: string }) =>
    req<ZapretStatus>("POST", "/zapret/start", body),
  zapretStop: () => req<ZapretStatus>("POST", "/zapret/stop"),
  zapretService: (action: "install" | "remove" | "status", strategyId?: string) =>
    req<{ ok: boolean; installed?: boolean; running?: boolean }>("POST", "/zapret/service", { action, strategyId }),
  zapretDiagnostics: () => req<ZapretDiagnostics>("POST", "/zapret/diagnostics"),
  zapretDiagnosticsTargets: () => req<{ targets: { id: string; name: string; kind: string; url?: string }[] }>("GET", "/zapret/diagnostics"),
  zapretAutoTune: (apply?: boolean) => req<ZapretAutoTuneResult>("POST", "/zapret/auto-tune", { apply }),
  zapretLists: () => req<ZapretList[]>("GET", "/zapret/lists"),
  zapretSaveList: (name: string, content: string) =>
    req<{ ok: boolean }>("PUT", `/zapret/lists/${encodeURIComponent(name)}`, { content }),
  zapretProfiles: () => req<ZapretProfile[]>("GET", "/zapret/profiles"),
  zapretSaveProfile: (body: { name: string; customArgs?: string; isService?: boolean; batchFilePath?: string }) =>
    req<ZapretProfile>("POST", "/zapret/profiles", body),
  zapretDeleteProfile: (id: number) => req<{ ok: boolean }>("DELETE", `/zapret/profiles/${id}`),
  zapretActivateProfile: (id: number) => req<ZapretStatus>("POST", `/zapret/profiles/${id}/activate`),
  zapretDomains: () => req<ZapretDomain[]>("GET", "/zapret/domains"),
  zapretAddDomain: (domain: string, type: "include" | "exclude") =>
    req<ZapretDomain[]>("POST", "/zapret/domains", { domain, type }),
  zapretToggleDomain: (id: number, isEnabled: boolean) =>
    req<ZapretDomain[]>("PATCH", `/zapret/domains/${id}`, { isEnabled }),
  zapretDeleteDomain: (id: number) => req<ZapretDomain[]>("DELETE", `/zapret/domains/${id}`),
  zapretCleanup: (body: { discord?: boolean; dns?: boolean }) =>
    req<{ discord?: { freedKb: number }; dns?: { ok: boolean; error?: string } }>("POST", "/zapret/cleanup", body),
  zapretGameFilter: (tcp: boolean, udp: boolean) =>
    req<Record<string, unknown>>("POST", "/zapret/gamefilter", { tcp, udp }),
  zapretSaveSettings: (body: { dir?: string; mode?: string; customTargets?: string; autoApplyBest?: boolean }) =>
    req<Record<string, unknown>>("POST", "/zapret/settings", body),
  // Проверка конфигов через service.bat (vendor utils/test zapret.ps1) + консоль
  zapretCheckStatus: () => req<ZapretCheckState>("GET", "/zapret/check"),
  zapretCheckStart: (fast?: boolean, strategyId?: string) => req<ZapretCheckState>("POST", "/zapret/check", { fast: fast !== false, strategyId }),
  zapretCheckStop: () => req<ZapretCheckState>("POST", "/zapret/check/stop"),
  zapretServiceDiagnostics: () => req<ZapretCheckState>("POST", "/zapret/service-diagnostics"),
  zapretFixUserLists: () => req<ZapretCheckState>("POST", "/zapret/user-lists"),

  // Settings / providers
  getSettings: () => req("GET", "/settings"),
  updateSettings: (patch: unknown) => req("PATCH", "/settings", patch),
  getProviders: () => req<ProviderInfo[]>("GET", "/settings/providers"),
  saveKey: (id: string, key: string) => req("POST", `/settings/providers/${id}/key`, { key }),

  // Chat
  getConversations: () => req<Conversation[]>("GET", "/chat"),
  createConversation: (provider: string, title: string) =>
    req<Conversation>("POST", "/chat", { provider, title }),
  getMessages: (id: number) => req<ChatMessage[]>("GET", `/chat/${id}/messages`),
  deleteConversation: (id: number) => req("DELETE", `/chat/${id}`),
  chatModels: (provider: string) => req<string[]>("GET", `/chat/models?provider=${encodeURIComponent(provider)}`),
  chatUpdateConv: (id: number, patch: { title?: string; pinned?: boolean }) =>
    req<Conversation>("PATCH", `/chat/${id}`, patch),
  chatTruncateFrom: (id: number, msgId: number) =>
    req<{ ok: boolean }>("DELETE", `/chat/${id}/messages/${msgId}`),
  chatChoose: (id: number, text: string) =>
    req<{ ok: boolean }>("POST", `/chat/${id}/choose`, { text }),

  // Books / monitor / archives
  // Books — OPDS-фиды напрямую (без локального каталога) + избранное/закладки
  getBooks: (params?: string) => req<BooksFeedResult>("GET", `/books${params ? '?' + params : ''}`),
  getBookGenres: () => req<{ genres: BookGenre[] }>("GET", "/books/genres"),
  refreshBooks: () => req<{ ok: boolean }>("POST", "/books/refresh"),
  toggleBookFlag: (field: "fav" | "bm", bid: number, book: FlibustaBook) =>
    req<{ fav: boolean; bm: boolean }>("POST", "/books/toggle", { field, bid, book }),
  getBookFlags: (bids: number[]) =>
    req<Record<string, { fav: boolean; bm: boolean }>>("GET", `/books/my-flags?bids=${bids.join(",")}`),
  /** Скачать книгу по bid+fmt. */
  downloadBook: (bid: number, fmt: string) =>
    req<BookDownloadResult>("POST", "/books/download", { bid, fmt }),

  getMonitor: () => req<MonitorSnapshot>("GET", "/monitor"),
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
    return multipart<{ codec?: string; width?: number; height?: number; fps?: string; bitRate?: number; duration?: number }>("/compressor/probe", fd);
  },
  compressorCommand: (id: string) => req<{ command: string }>("GET", `/compressor/${id}/command`),
  compressorPresets: () => req<{ system: CompressorPreset[]; custom: CompressorPreset[] }>("GET", "/compressor/presets"),
  compressorSavePreset: (p: { name: string } & Record<string, unknown>) =>
    req<{ ok: boolean; custom: CompressorPreset[] }>("POST", "/compressor/presets", p),
  compressorDeletePreset: (name: string) => req<{ ok: boolean }>("DELETE", `/compressor/presets/${encodeURIComponent(name)}`),

  // --- Аудиокнижная TTS-студия (F5-TTS / Coqui XTTS v2) ---
  ttsHardware: () => req<TtsHardware>("GET", "/tts/hardware"),
  ttsPresets: () => req<TtsPreset[]>("GET", "/tts/presets"),
  ttsSavePreset: (p: { name: string; engine: string; params: Record<string, unknown>; refFile?: string }) =>
    req<TtsPreset>("POST", "/tts/presets", p),
  ttsDeletePreset: (id: string) => req("DELETE", `/tts/presets/${id}`),
  ttsProfiles: () => req<TtsProfile[]>("GET", "/tts/profiles"),
  ttsSaveProfile: (p: Partial<TtsProfile>) => req<TtsProfile>("POST", "/tts/profiles", p),
  ttsDeleteProfile: (id: string) => req("DELETE", `/tts/profiles/${id}`),
  // Референс грузится отдельным шагом — сервер возвращает имя ref_* файла.
  ttsUploadReference: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<{ refFile: string; size: number }>("/tts/reference", fd);
  },
  // Универсальный импорт книги: epub/fb2/fb2.zip/pdf/mobi/rtf/txt → главы.
  ttsImportBook: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<TtsBook>("/tts/import-book", fd);
  },
  // NLP-предпросмотр чанков для Batch Editor (без генерации).
  ttsPreviewChunks: (text: string, engine: string, opts: Record<string, unknown>) =>
    req<{ chunks: TtsChunk[] }>("POST", "/tts/preview-chunks", { text, engine, ...opts }),
  ttsStart: (body: Record<string, unknown>) => req<TtsJob>("POST", "/tts", body),
  ttsStatus: (id: string) => req<TtsJob>("GET", `/tts/${id}`),
  ttsReveal: (path: string) => req<{ ok: boolean }>("POST", "/tts/reveal", { path }),
  ttsDownload: async (id: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/tts/${id}/download`, { headers: { ...tokenHeaders() } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return { blob: await res.blob(), name: m?.[1] ? decodeURIComponent(m[1]) : "audiobook.mp3" };
  },

  // --- Web Archive (.sitebak) ---
  archiveStart: (opts: Record<string, unknown>) => req<SitebakJob>("POST", "/archive/start", opts),
  archiveStatus: (id: string) => req<SitebakJob>("GET", `/archive/status/${id}`),
  archiveList: () => req<SitebakArchive[]>("GET", "/archive/list"),
  archiveDelete: (id: string) => req("DELETE", `/archive/${id}`),
  archiveVerify: (id: string) => req<{ ok: number; bad: number; total: number; badPaths: string[] }>("POST", `/archive/${id}/verify`),
  archiveExtract: (id: string) => req<{ ok: boolean; files: number }>("POST", `/archive/${id}/extract`),
  archiveDownload: (id: string) => `/api/archive/${id}/download`,
  archivePreview: (id: string, p = "") => `/api/archive/${id}/file?path=${encodeURIComponent(p || "index.html")}`,


  // Convert — страница конвертации файлов (нативный движок через FFmpeg)
  getConvertTools: () => req<ConvertTools>("GET", "/convert/tools"),
  getConvertInstall: () => req<ConvertInstallStatus>("GET", "/convert/install"),
  startConvertInstall: () => req<ConvertInstallStatus>("POST", "/convert/install/start"),
  uploadConvert: (file: File, to: string) =>
    multipart<ConvertResult>("/convert", toFormData(file, to)),
  /** Скачивает результат одним файлом (blob) с токеном, минуя CORS-проверку /api. */
  downloadConvert: async (key: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/convert/download/${encodeURIComponent(key)}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(
      (res.headers.get("content-disposition") || "").split("filename*=")[1]?.split("''")[1] ||
      (res.headers.get("content-disposition") || "").split("filename=")[1]?.replace(/"/g, "") ||
      "result"
    );
    return { blob: await res.blob(), name };
  },

  // Video — страница загрузки видео через yt-dlp
  getVideoInfo: (url: string) => req<VideoInfo>("GET", `/video/info?url=${encodeURIComponent(url)}`),
  startVideoDownload: (body: { url: string; info: VideoInfo; height?: number; container?: string; subs?: string[]; thumb?: { embed: boolean } }) =>
    req<VideoDownloadResult>("POST", "/video/download", body),
  getVideoJobStatus: (id: string) => req<VideoJobStatus>("GET", `/video/status/${id}`),
  downloadVideoFile: async (key: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/video/download/${encodeURIComponent(key)}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(
      (res.headers.get("content-disposition") || "").split("filename*=")[1]?.split("''")[1] ||
      (res.headers.get("content-disposition") || "").split("filename=")[1]?.replace(/"/g, "") ||
      "result"
    );
    return { blob: await res.blob(), name };
  },
  getVideoInstall: () => req<YtdlpInstallStatus>("GET", "/video/install"),
  startVideoInstall: () => req<YtdlpInstallStatus>("POST", "/video/install/start"),

  // LibreHardwareMonitor — датчики температур/вентиляторов/напряжений
  getLhmStatus: () => req<LhmStatus>("GET", "/monitor/lhm"),
  startLhm: () => req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/start"),
  downloadLhmEngine: () => req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/download"),
  stopLhm: () => req<{ ok: boolean }>("POST", "/monitor/lhm/stop"),

  // Backup
  createBackup: () => req("POST", "/backup"),
  listBackups: () => req<BackupInfo[]>("GET", "/backup"),

  // Catalog — пользовательский каталог загрузок
  getCatalog: () => req("GET", "/catalog"),
  addCatalog: (name: string, url: string, category: string) =>
    req("POST", "/catalog", { name, url, category }),
  deleteCatalog: (id: number) => req("DELETE", `/catalog/${id}`),
  downloadCatalog: (id: number) => req("POST", `/catalog/${id}/download`),
  downloadAndInstall: (id: number) => req("POST", `/catalog/${id}/download-and-install`),
  installAllFavorites: () => req("POST", "/catalog/install-all", { onlyFavorites: true }),

  // Apps — объединённый каталог: winget + custom/comss
  getApps: () => req<{ ready: boolean; items: AppItem[] }>("GET", "/apps"),
  favoriteApp: (key: string) => req<{ ok: boolean; favorite: boolean }>("POST", "/apps/favorite", { key }),
  installApp: (key: string) => req("POST", "/apps/install", { key }),
  downloadApp: (key: string) => req<{ ok: boolean; method: string; file?: string; dir?: string }>("POST", "/apps/download", { key }),
  wingetSearch: (q: string) => req<AppItem[]>("GET", `/apps/winget/search?q=${encodeURIComponent(q)}`),
  wingetStatus: () => req<{ state: string; cached: number }>("GET", "/apps/winget/status"),
  wingetIndex: () => req("POST", "/apps/winget/index"),
  comssCategories: () => req("GET", "/apps/comss/categories"),
  comssScrape: (categories: string[], limit: number) =>
    req<{ ok: boolean; jobId: string }>("POST", "/apps/comss/scrape", { categories, limit }),
  comssProgress: (jobId: string) => req("GET", `/apps/comss/progress?job=${encodeURIComponent(jobId)}`),
  comssImport: (items: unknown[]) => req<{ added: number; skipped: number }>("POST", "/apps/comss/import", { items }),

  // Диагностика: собрать файл со всеми логами (клики, навигация, ошибки).
  // Файл создаётся в корне storage — рядом с приложением у установленной сборки.
  collectLogs: () => req<{ ok: boolean; file: string; size: number; events: number }>("POST", "/backup/logs"),
  logReports: () => req<{ file: string; size: number; mtime: string }[]>("GET", "/backup/logs"),

  // Proxy
  getProxyStatus: () => req<ProxyStatus>("GET", "/proxy/status"),
  startProxy: (vlessLink: string) => req<ProxyStatus>("POST", "/proxy/start", { vlessLink }),
  stopProxy: () => req<ProxyStatus>("POST", "/proxy/stop"),
  pingProxy: () => req<{ pingMs: number | null; country: string | null; error?: string }>("POST", "/proxy/ping"),
  getProxyInstall: () => req<{ state: string; progress: number; phase: string; error: string; installed: boolean }>("GET", "/proxy/install"),
  startProxyInstall: () => req<{ state: string; progress: number; phase: string; error: string; installed: boolean }>("POST", "/proxy/install/start"),
  // Сохранённые VLESS-профили прокси
  getSavedVless: () => req<VlessProfile[]>("GET", "/proxy/vless"),
  saveVless: (link: string, name?: string) => req<VlessProfile>("POST", "/proxy/vless/save", { link, name }),
  deleteVless: (id: string) => req<{ ok: boolean }>("DELETE", `/proxy/vless/${id}`),

  // Proxy core (встроенный sing-box): узлы, подписки, правила страниц
  proxyCoreStatus: () => req<ProxyCoreStatus>("GET", "/proxycore/status"),
  proxyCoreStart: (p: { id?: number; uri?: string }) => req<ProxyCoreStatus>("POST", "/proxycore/start", p),
  proxyCoreStop: () => req<ProxyCoreStatus>("POST", "/proxycore/stop"),
  proxyCoreInstallStatus: () => req<ProxyInstallStatus>("GET", "/proxycore/install"),
  proxyCoreInstall: () => req<ProxyInstallStatus>("POST", "/proxycore/install/start"),
  proxyCoreLatency: (timeout?: number) => req<ProxyLatency>("GET", `/proxycore/latency${timeout ? `?timeout=${timeout}` : ""}`),
  proxyCoreSubscriptions: () => req<ProxySubscription[]>("GET", "/proxycore/subscriptions"),
  proxyCoreAddSubscription: (name: string, url: string) => req<{ id: number; refresh: { added?: number; error?: string } }>("POST", "/proxycore/subscriptions", { name, url }),
  proxyCoreRefreshSubscription: (id: number) => req<{ added: number }>("POST", `/proxycore/subscriptions/${id}/refresh`),
  proxyCoreDeleteSubscription: (id: number) => req<{ changes: number }>("DELETE", `/proxycore/subscriptions/${id}`),
  proxyCoreNodes: () => req<ProxyNode[]>("GET", "/proxycore/nodes"),
  proxyCoreSelectNode: (id: number) => req<{ ok: boolean }>("POST", "/proxycore/nodes/select", { id }),
  /** Убрать узел из списка (он останется скрытым и при обновлении подписки). */
  proxyCoreHideNode: (id: number) => req<{ ok: boolean; hidden: boolean }>("DELETE", `/proxycore/nodes/${id}`),
  /** Вернуть ранее скрытый узел. */
  proxyCoreRestoreNode: (id: number) => req<{ ok: boolean; hidden: boolean }>("POST", `/proxycore/nodes/${id}/restore`),
  /** Вернуть все скрытые узлы (или одной подписки). */
  proxyCoreRestoreHidden: (subId?: number) => req<{ ok: boolean; restored: number }>("DELETE", `/proxycore/nodes/hidden${subId != null ? `?sub=${subId}` : ""}`),
  /** Пропинговать все конфиги (реальный TTFB через временное ядро). */
  proxyCorePingNodes: (p: { subId?: number; ids?: number[]; onlyMissing?: boolean } = {}) =>
    req<ProxyPingStatus>("POST", "/proxycore/nodes/ping", p),
  proxyCorePingStatus: () => req<ProxyPingStatus>("GET", "/proxycore/nodes/ping"),
  proxyCorePingCancel: () => req<ProxyPingStatus>("POST", "/proxycore/nodes/ping/cancel"),
  proxyCorePages: () => req<ProxyPageRule[]>("GET", "/proxycore/pages"),
  proxyCoreSetPage: (route: string, isProxied: boolean) => req<{ ok: boolean }>("POST", "/proxycore/pages", { route, isProxied }),

// Music / Audio
  musicSearch: (q: string) => req<MusicSearchResult>("GET", `/music/search?q=${encodeURIComponent(q)}`),
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
  // Логирование действий пользователя на бэкенде
// MySpace / Vault
  myspaceTree: () => req<VaultFile[]>("GET", "/myspace/tree"),
  myspaceRead: (path: string) => req<VaultFileContent>("GET", `/myspace/file?path=${encodeURIComponent(path)}`),
  myspaceWrite: (path: string, content: string, frontmatter?: Record<string, string>) =>
    req("POST", "/myspace/file", { path, content, frontmatter }),
  myspaceDelete: (path: string) => req("DELETE", `/myspace/file?path=${encodeURIComponent(path)}`),
  myspaceRename: (oldPath: string, newPath: string) => req("PUT", "/myspace/rename", { oldPath, newPath }),
  myspaceCreateFolder: (path: string) => req("POST", "/myspace/folder", { path }),
  myspaceSearch: (q: string) => req<VaultSearchResult[]>("GET", `/myspace/search?q=${encodeURIComponent(q)}`),
  myspaceTags: () => req<VaultTag[]>("GET", "/myspace/tags"),
  myspaceBacklinks: (path: string) => req<VaultBacklink[]>("GET", `/myspace/backlinks?path=${encodeURIComponent(path)}`),
  // MySpace Canvas / Holst
  myspaceListHolsts: () => req<HolstFileEntry[]>("GET", "/myspace/holsts"),
  myspaceReadHolst: (name: string) => req<HolstReadResult>("GET", `/myspace/holst?name=${encodeURIComponent(name)}`),
  myspaceWriteHolst: (name: string, data: any) => req<HolstWriteResult>("POST", "/myspace/holst", { name, data }),
  myspaceDeleteHolst: (name: string) => req<{ ok: boolean }>("DELETE", `/myspace/holst?name=${encodeURIComponent(name)}`),
  logAction: (event: string, data?: unknown) => req("POST", "/log", { event, data }),
  // MySpace Tasks
  tasksList: (params?: { status?: string; tag?: string; projectId?: string; search?: string }) =>
    req<TaskItem[]>("GET", `/myspace/tasks?${new URLSearchParams(params as any).toString()}`),
  tasksCreate: (payload: TaskCreatePayload) => req<TaskItem>("POST", "/myspace/tasks", payload),
  tasksUpdate: (id: string, data: Partial<TaskItem>) => req<TaskItem>("PUT", `/myspace/tasks/${id}`, data),
  tasksDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/myspace/tasks/${id}`),
  tasksTimer: (id: string, action: "start" | "pause") => req<TaskItem>("POST", `/myspace/tasks/${id}/timer`, { action }),

  // --- Фильмы и сериалы: каталог TMDB, библиотека, торрент-плеер ---
  moviesStatus: () => req<MediaStatus>("GET", "/movies/status"),
  moviesSaveKey: (key: string) => req<{ ok: boolean; hasKey: boolean }>("POST", "/movies/key", { key }),
  moviesRefresh: () => req<{ ok: boolean }>("POST", "/movies/refresh"),
  moviesTrending: (kind: MediaKind, window: "day" | "week" = "week", page = 1) =>
    req<MediaListResult>("GET", `/movies/trending?kind=${kind}&window=${window}&page=${page}`),
  moviesList: (kind: MediaKind, category = "popular", page = 1) =>
    req<MediaListResult>("GET", `/movies/list?kind=${kind}&category=${category}&page=${page}`),
  moviesSearch: (q: string, kind: MediaKind | "multi" = "multi", page = 1) =>
    req<MediaListResult>("GET", `/movies/search?q=${encodeURIComponent(q)}&kind=${kind}&page=${page}`),
  moviesGenres: (kind: MediaKind) => req<{ genres: MediaGenre[] }>("GET", `/movies/genres?kind=${kind}`),
  moviesDiscover: (kind: MediaKind, p: { genre?: string | number; year?: string | number; sort?: string; page?: number } = {}) => {
    const qs = new URLSearchParams();
    qs.set("kind", kind);
    if (p.genre) qs.set("genre", String(p.genre));
    if (p.year) qs.set("year", String(p.year));
    if (p.sort) qs.set("sort", p.sort);
    if (p.page) qs.set("page", String(p.page));
    return req<MediaListResult>("GET", `/movies/discover?${qs.toString()}`);
  },
  moviesDetails: (kind: MediaKind, id: number) => req<MediaDetails>("GET", `/movies/details/${kind}/${id}`),
  moviesProviders: (kind: MediaKind, id: number) => req<MediaProviders>("GET", `/movies/providers/${kind}/${id}`),
  moviesLibrary: () => req<MediaLibrary>("GET", "/movies/library"),
  moviesState: (kind: MediaKind, id: number) => req<MediaState>("GET", `/movies/state/${kind}/${id}`),
  moviesSetWatchlist: (p: {
    kind: MediaKind; id: number; title: string; poster?: string;
    year?: number | null; runtime?: number | null; genres?: (string | MediaGenre)[]; status: MediaWatchStatus;
  }) => req<{ ok: boolean; watchlist: MediaWatchlistEntry }>("POST", "/movies/watchlist", p),
  moviesRemoveWatchlist: (kind: MediaKind, id: number) => req<{ ok: boolean }>("DELETE", `/movies/watchlist/${kind}/${id}`),
  moviesRate: (p: { kind: MediaKind; id: number; title?: string; rating: number }) =>
    req<{ ok: boolean; rating: MediaRatingEntry | null }>("POST", "/movies/rate", p),
  moviesWatch: (p: {
    kind: MediaKind; id: number; title?: string; genres?: (string | MediaGenre)[];
    cast?: { name: string }[]; runtime?: number | null; progress?: number;
  }) => req<{ ok: boolean }>("POST", "/movies/watch", p),
  moviesRemoveWatch: (kind: MediaKind, id: number) => req<{ ok: boolean }>("DELETE", `/movies/watch/${kind}/${id}`),
  moviesStats: () => req<MediaStats>("GET", "/movies/stats"),
  moviesClearStats: () => req<{ ok: boolean }>("POST", "/movies/stats/clear"),

  // Торрент-плеер: источник (magnet/.torrent) задаёт пользователь.
  moviesTorrentEngine: () => req<{ installed: boolean; client?: boolean; error?: string }>("GET", "/movies/torrent/engine"),
  moviesTorrentActive: () => req<{ infoHash: string; name: string; progress: number; peers: number }[]>("GET", "/movies/torrent/active"),
  moviesTorrentAdd: (p: { magnet?: string; torrent?: string }) => req<TorrentAddResult>("POST", "/movies/torrent/add", p),
  moviesTorrentStatus: (infoHash: string) => req<TorrentStatus>("GET", `/movies/torrent/status/${encodeURIComponent(infoHash)}`),
  moviesTorrentRemove: (infoHash: string) => req<{ removed: boolean }>("DELETE", `/movies/torrent/${encodeURIComponent(infoHash)}`),
  moviesTorrentFile: (infoHash: string, index: number) =>
    req<{ name: string; length: number; mime: string }>("GET", `/movies/torrent/file/${encodeURIComponent(infoHash)}/${index}`),
  /** URL стрима для HTML5 <video> (Range поддерживается). */
  moviesTorrentStreamUrl: (infoHash: string, index: number) =>
    `/api/movies/torrent/stream/${encodeURIComponent(infoHash)}/${index}`,
};

/** Событие стрима чата. */
export interface StreamEvent {
  type: "token" | "done" | "error" | "meta";
  text?: string;
  message?: string;
  side?: "a" | "b";
  model?: string;
  title?: string;
  stats?: { ms: number; chars: number; tokensApprox: number };
}

/** Потоковая отправка в чат. onEvent({type:'token'|'done'|'error'|'meta'}). */
export async function streamChatSend(
  conversationId: number,
  body: { text: string; model?: string; temperature?: number; maxTokens?: number; stream?: boolean; images?: string[]; topP?: number; frequencyPenalty?: number; presencePenalty?: number; systemPrompt?: string },
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${BASE}/api/chat/${conversationId}/send`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409 || res.status === 401) {
    let msg = "Ошибка";
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { onEvent(JSON.parse(payload) as StreamEvent); } catch { /* skip */ }
    }
  }
}

/** Arena: один вопрос двум моделям параллельно. События помечены side: "a"|"b". */
export async function streamArena(
  conversationId: number,
  body: { text: string; models: [string, string]; temperature?: number; maxTokens?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number; systemPrompt?: string; images?: string[]; persist?: boolean },
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${BASE}/api/chat/${conversationId}/arena`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409 || res.status === 401) {
    let msg = "Ошибка";
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { onEvent(JSON.parse(payload) as StreamEvent); } catch { /* skip */ }
    }
  }
}



/* ================= Lecture Recorder (whisper.cpp + VAD) ================= */

export interface LectureEngineStatus {
  ready: boolean; bin: string | null; model: string | null;
  backend: string | null; language: string; activeSession: boolean;
}
export interface LectureSession {
  id: number; title: string; started_at: string; ended_at: string | null;
  duration_ms: number; sample_rate: number; channels: number;
  raw_file: string; status: string; notes: string;
}
export interface LectureChunk {
  id: number; lecture_id: number; idx: number; start_ms: number; end_ms: number;
  text: string; status: "pending" | "done" | "empty" | "error"; error: string; file: string;
}
export interface LectureStatus {
  lecture: LectureSession; chunks: LectureChunk[];
  live: boolean; queue: number; transcribing: boolean;
  recordingSec: number; vadStats: { frames: number; speechFrames: number; rejected: number; chunks: number } | null;
  lastError: string; whisper: LectureEngineStatus;
}
export interface LectureCreateResult {
  id: number; sampleRate: number; channels: number;
  vad: { silenceMs: number; minChunkMs: number; maxChunkMs: number; forceSplitMs: number; padMs: number };
  whisper: LectureEngineStatus;
}

/** POST бинарного тела (PCM-стрим) с токеном. */
export async function rawPost(path: string, body: ArrayBuffer): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...tokenHeaders(), "Content-Type": "application/octet-stream" },
    body,
  });
}

/* ================= Zapret / DPI Bypass ================= */

export interface ZapretEngine {
  found: boolean; dir: string | null; installDir: string;
  winws: string | null; binDir: string | null;
  serviceBat: string | null; listsDir: string | null;
  version: string | null; gameFilter: "all" | "tcp" | "udp" | "off";
}
export interface ZapretStrategy {
  id: string; name: string; label: string;
  group: "base" | "alt" | "fake-tls-auto" | "simple-fake" | "exp";
  file: string; filePath: string; args: string; winwsCmd: string; index: number;
}
export interface ZapretBatFile {
  name: string; file: string; sizeKb: number;
  kind: "strategy" | "service"; args: string;
}
export interface ZapretUpdate {
  engine: ZapretEngine;
  installed: string | null; installedAt: string | null;
  latest: string | null; hasUpdate: boolean;
  downloadUrl: string | null; assetName: string | null; sizeBytes: number;
  publishedAt: string | null; htmlUrl: string; notes: string;
  error: string; repo: string;
}
export interface ZapretInstallState {
  state: "idle" | "working" | "done" | "error";
  progress: number; phase: string; error: string;
  tag: string | null; at: number;
  engine: ZapretEngine; installed: string | null;
}
export interface ZapretStatus {
  active: boolean;
  process: { running: boolean; pid: number | null; memKb: number | null };
  service: { installed: boolean; running: boolean; raw: string; strategyFile?: string };
  mode: string; profile: { strategyId: string; customArgs: string; mode: string } | null;
  log: string[]; engine: ZapretEngine; strategy: string | null;
  version: string | null; gameFilter: string;
}
export interface ZapretTargetResult {
  id: string; name: string; kind: "http" | "udp"; url?: string;
  ok: boolean; status: number | null; latencyMs: number; error: string | null; packetDrop: boolean;
}
export interface ZapretDiagnostics {
  allOk: boolean; okCount: number; total: number; avgLatency: number; results: ZapretTargetResult[]; at: number;
}
export interface ZapretAutoTuneResult {
  tried: { strategyId: string; allOk: boolean; okCount?: number; total?: number; avgLatency?: number; score?: number; error?: string }[];
  best: string | null; applied: string | null;
}
export interface ZapretProfile {
  id: number; name: string; batch_file_path: string; custom_args: string;
  is_active: number; is_service: number; created_at: string;
}
export interface ZapretDomain { id: number; domain: string; type: "include" | "exclude"; is_enabled: number }
export interface ZapretPayload { name: string; path: string; sizeKb: number }
export interface ZapretList { name: string; content: string }

/* --- Проверка конфигов (service.bat → utils/test zapret.ps1) --- */

export interface ZapretCheckResult {
  strategyId: string; file: string;
  okCount: number; error: number; unsup: number;
  pingOk: number; pingFail: number;
  finished: boolean; failedToStart: boolean;
}
export interface ZapretCheckLight {
  strategy_id: string; file: string; ok: number; ok_count: number;
  error: number; unsup: number; ping_ok: number; ping_fail: number;
  checked_at: string; run_started_at: string;
}
export interface ZapretCheckState {
  state: "idle" | "working" | "done" | "error";
  mode: "check" | "diag" | "lists" | null;
  label: string; running: boolean;
  startedAt: number; finishedAt: number; exitCode: number | null; error: string;
  best: string | null;
  bestId: string | null;
  progress: { done: number; total: number; current: string | null };
  results: ZapretCheckResult[];
  log: string[]; logCursor: number;
  lights: Record<string, ZapretCheckLight>;
}

