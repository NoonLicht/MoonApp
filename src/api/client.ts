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
import {
  req,
  BASE,
  tokenHeaders,
  pageHeaders,
  filenameFromDisposition,
  multipart,
  toFormData,
} from "@/api/apiHttp";
import type {
  ProviderInfo,
  SettingsImportResult,
  Conversation,
  ChatMessage,
  BooksFeedResult,
  BookGenre,
  FlibustaBook,
  MonitorSnapshot,
  ConvertTools,
  ConvertInstallStatus,
  ConvertResult,
  VideoInfo,
  VideoDownloadResult,
  VideoJobStatus,
  YtdlpInstallStatus,
  LhmStatus,
  BackupInfo,
  AppItem,
  ProxyStatus,
  VlessProfile,
} from "@/api/types";
import { lectureApi } from "@/api/apiLecture";
import { bypassApi } from "@/api/apiBypass";
import { moviesApi } from "@/api/apiMovies";
import { upscaleApi } from "@/api/apiUpscale";
import { ttsApi } from "@/api/apiTts";
import { myspaceApi } from "@/api/apiMyspace";
import { filesApi } from "@/api/apiFiles";
import { systemApi } from "@/api/apiSystem";
import { tuningApi } from "@/api/apiTuning";
import { privacyApi } from "@/api/apiPrivacy";
import { linutilApi } from "@/api/apiLinutil";
import { translateApi } from "@/api/apiTranslate";
import { llamaApi } from "@/api/apiLlama";

export type {
  CompressorJob,
  CompressorHardware,
  CompressorPreset,
  TtsProfile,
  TtsPreset,
  TtsHardware,
  TtsChunk,
  TtsBookChapter,
  TtsBook,
  TtsJob,
  TtsEnvError,
  TtsPythonEnv,
  PyInstallTask,
  PyInstallSnapshot,
  PyPlan,
  PyPortable,
  PyRemoved,
  PyInstallState,
  PyInterpreter,
  SitebakJob,
  SitebakArchive,
  ArchivePage,
  ArchivePagesResult,
} from "@/api/apiTypesMedia";
export { streamChatSend, streamArena } from "@/api/apiStream";
export type { StreamEvent } from "@/api/apiStream";
export type {
  LectureEngineStatus,
  LectureFit,
  LectureSystemInfo,
  LectureEngineBuild,
  LectureModelEntry,
  LectureEngineTask,
  LectureGpuInfo,
  LectureEngineVerify,
  LectureEngineSetup,
  LectureSession,
  LectureChunk,
  LectureVadMetrics,
  LectureRecheckState,
  LectureConspectusResult,
  LectureConspectusState,
  LectureConspectusTrigger,
  LectureDiarizePackage,
  LectureDiarizeTask,
  LectureDiarizeSettings,
  LectureDiarizeSetup,
  LectureDiarizeState,
  LectureProviderInfo,
  LectureConspectusPreset,
  LectureConspectusSettings,
  LectureAudioSettings,
  LectureAudioPatch,
  LectureStatus,
  LectureCreateResult,
} from "@/api/apiTypesLecture";
export { rawPost } from "@/api/apiHttp";
export type {
  TuningTabId,
  TuningRisk,
  TweakState,
  TweakMeta,
  TweakStatus,
  TuningOverview,
  TuningResult,
  TuningBatchResult,
  TuningBackup,
  WuMeta,
  WuFeatureRow,
  WuApp,
  UsbController,
  DriverRow,
  ProcRow,
  StartupEntry,
  StartupTrashItem,
  BiosFacts,
  BenchRun,
} from "@/api/apiTuning";
export type {
  PrivacyCategory,
  PrivacyItem,
  PrivacyHistoryEntry,
  PrivacyOverview,
  WipeOutcome,
  WipeResult,
} from "@/api/apiPrivacy";
export type { LinutilOverview, LinutilTab, LinutilNode } from "@/api/apiLinutil";
export type {
  TrStatus,
  TrJob,
  TrBlock,
  TrOptions,
  TrProvider,
  TrVariant,
  TrDownload,
} from "@/api/apiTranslate";
export type { LlamaStatus, LlamaBuildId, LlamaCatalogModel } from "@/api/apiLlama";
export type {
  ZapretEngine,
  ZapretStrategy,
  ZapretBatFile,
  ZapretUpdate,
  ZapretInstallState,
  TgwsStatus,
  TgwsSettingsPatch,
  ZapretStatus,
  ZapretTargetResult,
  ZapretDiagnostics,
  ZapretAutoTuneResult,
  ZapretProfile,
  ZapretDomain,
  ZapretPayload,
  ZapretList,
  ZapretCheckResult,
  ZapretCheckLight,
  ZapretCheckState,
} from "@/api/apiTypesBypass";

export const api = {
  // Health
  health: () => req<{ ok: boolean }>("GET", "/health"),

  // Settings / providers
  getSettings: () => req("GET", "/settings"),
  updateSettings: (patch: unknown) => req("PATCH", "/settings", patch),
  getProviders: () => req<ProviderInfo[]>("GET", "/settings/providers"),
  saveKey: (id: string, key: string) => req("POST", `/settings/providers/${id}/key`, { key }),

  /**
   * Экспорт ВСЕХ настроек одним файлом (страница «Настройки» → «Экспорт»).
   * POST, а не GET: клиент передаёт снимок локальных настроек страниц
   * (localStorage), которые сервер не видит — см. src/utils/uiSettings.ts.
   */
  settingsExport: async (
    opts: { includeSecrets?: boolean; ui?: Record<string, string> } = {},
  ): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/settings/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenHeaders(), ...pageHeaders() },
      body: JSON.stringify({ includeSecrets: !!opts.includeSecrets, ui: opts.ui || {} }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = filenameFromDisposition(res) || "moonapp-settings.json";
    return { blob: await res.blob(), name };
  },

  /**
   * Импорт настроек из файла экспорта (или «сырого» settings.json).
   * importSecrets=false — ключи API из файла НЕ применяются (галочка в UI).
   * Возвращает применённые настройки и отчёт (что пропущено).
   */
  settingsImport: (
    payload: unknown,
    opts: { importSecrets?: boolean; ui?: Record<string, string> } = {},
  ): Promise<SettingsImportResult> => {
    const file =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    // Файл экспорта пересылаем как есть; «сырой» settings.json оборачиваем в
    // settings.*, чтобы служебные поля не смешались с настройками.
    const wrapped =
      file.settings && typeof file.settings === "object"
        ? { ...file, importSecrets: !!opts.importSecrets, ui: opts.ui || {} }
        : { settings: file, importSecrets: !!opts.importSecrets, ui: opts.ui || {} };
    return req<SettingsImportResult>("POST", "/settings/import", wrapped);
  },

  // Chat
  getConversations: () => req<Conversation[]>("GET", "/chat"),
  createConversation: (provider: string, title: string) =>
    req<Conversation>("POST", "/chat", { provider, title }),
  getMessages: (id: number) => req<ChatMessage[]>("GET", `/chat/${id}/messages`),
  deleteConversation: (id: number) => req("DELETE", `/chat/${id}`),
  chatModels: (provider: string) =>
    req<string[]>("GET", `/chat/models?provider=${encodeURIComponent(provider)}`),
  chatUpdateConv: (id: number, patch: { title?: string; pinned?: boolean }) =>
    req<Conversation>("PATCH", `/chat/${id}`, patch),
  chatTruncateFrom: (id: number, msgId: number) =>
    req<{ ok: boolean }>("DELETE", `/chat/${id}/messages/${msgId}`),
  chatChoose: (id: number, text: string) =>
    req<{ ok: boolean }>("POST", `/chat/${id}/choose`, { text }),

  // Books / monitor / archives
  // Books — OPDS-фиды напрямую (без локального каталога) + избранное/закладки
  getBooks: (params?: string) => req<BooksFeedResult>("GET", `/books${params ? "?" + params : ""}`),
  getBookGenres: () => req<{ genres: BookGenre[] }>("GET", "/books/genres"),
  refreshBooks: () => req<{ ok: boolean }>("POST", "/books/refresh"),
  toggleBookFlag: (field: "fav" | "bm", bid: number, book: FlibustaBook) =>
    req<{ fav: boolean; bm: boolean }>("POST", "/books/toggle", { field, bid, book }),
  getBookFlags: (bids: number[]) =>
    req<Record<string, { fav: boolean; bm: boolean }>>(
      "GET",
      `/books/my-flags?bids=${bids.join(",")}`,
    ),

  getMonitor: () => req<MonitorSnapshot>("GET", "/monitor"),

  // Convert — страница конвертации файлов (нативный движок через FFmpeg)
  getConvertTools: () => req<ConvertTools>("GET", "/convert/tools"),
  getConvertInstall: () => req<ConvertInstallStatus>("GET", "/convert/install"),
  startConvertInstall: () => req<ConvertInstallStatus>("POST", "/convert/install/start"),
  uploadConvert: (file: File, to: string) =>
    multipart<ConvertResult>("/convert", toFormData(file, to)),

  // Video — страница загрузки видео через yt-dlp
  getVideoInfo: (url: string) =>
    req<VideoInfo>("GET", `/video/info?url=${encodeURIComponent(url)}`),
  startVideoDownload: (body: {
    url: string;
    info: VideoInfo;
    height?: number;
    container?: string;
    subs?: string[];
    thumb?: { embed: boolean };
  }) => req<VideoDownloadResult>("POST", "/video/download", body),
  getVideoJobStatus: (id: string) => req<VideoJobStatus>("GET", `/video/status/${id}`),
  getVideoInstall: () => req<YtdlpInstallStatus>("GET", "/video/install"),
  startVideoInstall: () => req<YtdlpInstallStatus>("POST", "/video/install/start"),

  // LibreHardwareMonitor — датчики температур/вентиляторов/напряжений
  getLhmStatus: () => req<LhmStatus>("GET", "/monitor/lhm"),
  startLhm: () =>
    req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/start"),
  stopLhm: () => req<{ ok: boolean }>("POST", "/monitor/lhm/stop"),

  // Backup
  createBackup: () => req("POST", "/backup"),
  listBackups: () => req<BackupInfo[]>("GET", "/backup"),

  // Catalog — пользовательский каталог загрузок
  getCatalog: () => req("GET", "/catalog"),
  addCatalog: (name: string, url: string, category: string) =>
    req("POST", "/catalog", { name, url, category }),
  deleteCatalog: (id: number) => req("DELETE", `/catalog/${id}`),
  installAllFavorites: () => req("POST", "/catalog/install-all", { onlyFavorites: true }),

  // Apps — объединённый каталог: winget + custom/comss
  getApps: () => req<{ ready: boolean; items: AppItem[] }>("GET", "/apps"),
  favoriteApp: (key: string) =>
    req<{ ok: boolean; favorite: boolean }>("POST", "/apps/favorite", { key }),
  installApp: (key: string) => req("POST", "/apps/install", { key }),

  // Диагностика: собрать файл со всеми логами (клики, навигация, ошибки).
  // Файл создаётся в корне storage — рядом с приложением у установленной сборки.
  collectLogs: () =>
    req<{ ok: boolean; file: string; size: number; events: number }>("POST", "/backup/logs"),

  // Proxy
  getProxyStatus: () => req<ProxyStatus>("GET", "/proxy/status"),
  startProxy: (vlessLink: string) => req<ProxyStatus>("POST", "/proxy/start", { vlessLink }),
  stopProxy: () => req<ProxyStatus>("POST", "/proxy/stop"),
  getProxyInstall: () =>
    req<{ state: string; progress: number; phase: string; error: string; installed: boolean }>(
      "GET",
      "/proxy/install",
    ),
  startProxyInstall: () =>
    req<{ state: string; progress: number; phase: string; error: string; installed: boolean }>(
      "POST",
      "/proxy/install/start",
    ),
  // Сохранённые VLESS-профили прокси
  getSavedVless: () => req<VlessProfile[]>("GET", "/proxy/vless"),
  saveVless: (link: string, name?: string) =>
    req<VlessProfile>("POST", "/proxy/vless/save", { link, name }),
  deleteVless: (id: string) => req<{ ok: boolean }>("DELETE", `/proxy/vless/${id}`),
  ...lectureApi,
  ...bypassApi,
  ...moviesApi,
  ...upscaleApi,
  ...ttsApi,
  ...myspaceApi,
  ...filesApi,
  ...systemApi,
  ...tuningApi,
  ...privacyApi,
  ...linutilApi,
  ...translateApi,
  ...llamaApi,
};
