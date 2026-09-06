/**
 * Типизированный API-клиент к Node-бэкенду (Express).
 *
 * Как это работает:
 *  - все запросы идут на `${BASE}/api/<путь>` (BASE пустой: фронт и API на одном
 *    origin — Vite-proxy в dev, раздача Express в prod);
 *  - каждый запрос несёт заголовок x-pa-token (токен генерирует Electron,
 *    см. electron/main.js → preload.js → window.appBridge.getToken);
 *  - streamChatSend/streamArena читают SSE-стрим через fetch + ReadableStream.
 */
import type {
  AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation,
  ConvertTools, ConvertResult, ConvertInstallStatus,
  VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus,
  LhmStatus, MonitorSnapshot, ProviderInfo, ProxyStatus, VlessProfile,
  FlibustaBook, BooksCatalogStats, BooksSearchResult, BooksSyncStatus, BooksImportStatus,
  BooksLiveSearchResult, BookDownloadResult, ImportLogEntry,
  GraphData, GraphNode, GraphEdge,
  MusicTrack, MusicSearchResult, MusicFormats, MusicDownloadStart, MusicJobStatus,
  VaultFile, VaultFileContent, VaultSearchResult, VaultTag, VaultBacklink,
  TaskItem, TaskCreatePayload,
  HolstFileEntry, HolstReadResult, HolstWriteResult,
} from "./types";

export type { AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation, ConvertTools, ConvertResult, ConvertInstallStatus, VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus, LhmStatus, MonitorSnapshot, ProviderInfo, ProxyStatus, VlessProfile, FlibustaBook, BooksCatalogStats, BooksSearchResult, BooksSyncStatus, BooksImportStatus, BooksLiveSearchResult, BookDownloadResult, ImportLogEntry, MusicTrack, MusicSearchResult, MusicFormats, MusicDownloadStart, MusicJobStatus, VaultFile, VaultFileContent, VaultSearchResult, VaultTag, VaultBacklink, TaskItem, TaskCreatePayload, HolstFileEntry, HolstReadResult, HolstWriteResult };

const BASE = ""; // тот же origin: фронт и API вместе (Vite-proxy или раздача Express)

function tokenHeaders(): Record<string, string> {
  const t = window.appBridge?.getToken?.();
  return t ? { "x-pa-token": t } : {};
}

async function req<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: {
      ...tokenHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
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
  const res = await fetch(`${BASE}/api${url}`, {
    method: "POST",
    headers: { ...tokenHeaders() },
    body: formData,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json() as T;
}

export const api = {
  // Health
  health: () => req<{ ok: boolean }>("GET", "/health"),

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
  // Books — поиск/фильтры/пагинация по локальному каталогу Флибусты
  getBooks: (params?: string) => req<BooksSearchResult>("GET", `/books${params ? '?' + params : ''}`),
  getBooksFacets: () => req<BooksCatalogStats>("GET", "/books/facets"),
  getBooksSyncStatus: () => req<BooksSyncStatus>("GET", "/books/sync"),
  startBooksSync: (mode: string) => req<{ ok: boolean; reason?: string; status: BooksSyncStatus }>("POST", "/books/sync", { mode }),
  startBooksImport: () => req<{ ok: boolean }>("POST", "/books/import-dumps"),
  getBooksImportStatus: () => req<BooksImportStatus>("GET", "/books/import-dumps"),
  getBooksImportLogs: (n?: number) => req<ImportLogEntry[]>("GET", "/books/import-logs" + (n ? `?n=${n}` : "")),
  resetBooksCatalog: () => req<{ ok: boolean }>("POST", "/books/reset-catalog"),
  /** Живой OPDS-поиск (мгновенно, без локального хранилища). */
  booksLiveSearch: (q: string, page?: number) =>
    req<BooksLiveSearchResult>("POST", "/books/live-search", { q, page }),
  /** Скачать книгу по bid+fmt. */
  downloadBook: (bid: number, fmt: string) =>
    req<BookDownloadResult>("POST", "/books/download", { bid, fmt }),

  getMonitor: () => req<MonitorSnapshot>("GET", "/monitor"),
  getArchives: () => req<ArchiveItem[]>("GET", "/archives"),


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
  wingetSearch: (q: string) => req<AppItem[]>("GET", `/apps/winget/search?q=${encodeURIComponent(q)}`),
  wingetStatus: () => req<{ state: string; cached: number }>("GET", "/apps/winget/status"),
  wingetIndex: () => req("POST", "/apps/winget/index"),
  comssCategories: () => req("GET", "/apps/comss/categories"),
  comssScrape: (categories: string[], limit: number) =>
    req<{ ok: boolean; jobId: string }>("POST", "/apps/comss/scrape", { categories, limit }),
  comssProgress: (jobId: string) => req("GET", `/apps/comss/progress?job=${encodeURIComponent(jobId)}`),
  comssImport: (items: unknown[]) => req<{ added: number; skipped: number }>("POST", "/apps/comss/import", { items }),

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

// Music / Audio
  musicSearch: (q: string) => req<MusicSearchResult>("GET", `/music/search?q=${encodeURIComponent(q)}`),
  musicDownload: (url: string, format?: string, quality?: number) =>
    req<MusicDownloadStart>("POST", "/music/download", { url, format, quality }),
  musicJobStatus: (id: string) => req<MusicJobStatus>("GET", `/music/status/${id}`),
  musicDownloadFile: (key: string) => {
    const t = window.appBridge?.getToken?.();
    return fetch(`/api/music/download/${key}`, {
      headers: t ? { "x-pa-token": t } : {},
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
    headers: { ...tokenHeaders(), "Content-Type": "application/json" },
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
    headers: { ...tokenHeaders(), "Content-Type": "application/json" },
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


