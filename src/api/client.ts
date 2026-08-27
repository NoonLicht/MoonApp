/**
 * Типизированный API-клиент к Node-бэкенду (Express).
 * Чаты со стримингом читаются через fetch + ReadableStream (SSE-пакет).
 * Все запросы несут заголовок x-pa-token (токен генерирует Electron,
 * см. electron/main.js → preload.js → window.appBridge.getToken).
 */
import type {
  AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation,
  ConvertTools, ConvertResult, ConvertInstallStatus,
  VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus,
  LhmStatus, MonitorSnapshot, ProviderInfo, Task, ProxyStatus, VlessProfile,
} from "./types";

export type { AppItem, ArchiveItem, BackupInfo, BooksItem, ChatMessage, Conversation, ConvertTools, ConvertResult, ConvertInstallStatus, VideoInfo, VideoDownloadResult, VideoJobStatus, YtdlpInstallStatus, LhmStatus, MonitorSnapshot, ProviderInfo, Task, ProxyStatus, VlessProfile };

const BASE = ""; // одно origin (Vite-proxy или раздача Express)

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
 * Multipart-запрос к бэкенду (загрузка файла). Прокидывается доступ к токену,
 * Content-Type задаёт сам браузер (boundary). Ошибки — как в req().
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

  // Tasks
  getTasks: () => req<Task[]>("GET", "/tasks"),
  addTask: (text: string, priority: string, tag: string) =>
    req<Task>("POST", "/tasks", { text, priority, tag }),
  toggleTask: (id: number, done: boolean) => req<Task>("PATCH", `/tasks/${id}`, { done }),
  reorderTasks: (ids: number[]) => req("PUT", "/tasks/order", { ids }),
  deleteTask: (id: number) => req("DELETE", `/tasks/${id}`),

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

  // Books / monitor / archives
  getBooks: () => req<BooksItem[]>("GET", "/books"),
  getMonitor: () => req<MonitorSnapshot>("GET", "/monitor"),
  getArchives: () => req<ArchiveItem[]>("GET", "/archives"),


  // Convert (страница конвертации файлов — нативный движок через FFmpeg)
  getConvertTools: () => req<ConvertTools>("GET", "/convert/tools"),
  getConvertInstall: () => req<ConvertInstallStatus>("GET", "/convert/install"),
  startConvertInstall: () => req<ConvertInstallStatus>("POST", "/convert/install/start"),
  uploadConvert: (file: File, to: string) =>
    multipart<ConvertResult>("/convert", toFormData(file, to)),
  /** Скачивает результат одним разом в виде blob (с токеном, обходит защиту /api). */
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

  // Video (страница загрузки видео через yt-dlp)
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

  // LibreHardwareMonitor (датчики температур/вентиляторов/напряжений)
  getLhmStatus: () => req<LhmStatus>("GET", "/monitor/lhm"),
  startLhm: () => req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/start"),
  downloadLhmEngine: () => req<{ ok: boolean; already?: boolean; error?: string }>("POST", "/monitor/lhm/download"),
  stopLhm: () => req<{ ok: boolean }>("POST", "/monitor/lhm/stop"),

  // Backup
  createBackup: () => req("POST", "/backup"),
  listBackups: () => req<BackupInfo[]>("GET", "/backup"),

  // Catalog (каталог загрузок)
  getCatalog: () => req("GET", "/catalog"),
  addCatalog: (name: string, url: string, category: string) =>
    req("POST", "/catalog", { name, url, category }),
  deleteCatalog: (id: number) => req("DELETE", `/catalog/${id}`),
  downloadCatalog: (id: number) => req("POST", `/catalog/${id}/download`),
  downloadAndInstall: (id: number) => req("POST", `/catalog/${id}/download-and-install`),
  installAllFavorites: () => req("POST", "/catalog/install-all", { onlyFavorites: true }),

  // Apps (объединённый каталог: winget + custom/comss)
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
  // Сохранённые VLESS
  getSavedVless: () => req<VlessProfile[]>("GET", "/proxy/vless"),
  saveVless: (link: string, name?: string) => req<VlessProfile>("POST", "/proxy/vless/save", { link, name }),
  deleteVless: (id: string) => req<{ ok: boolean }>("DELETE", `/proxy/vless/${id}`),

  // Логирование действий
  logAction: (event: string, data?: unknown) => req("POST", "/log", { event, data }),
};

/** Событие стрима чата. */
export interface StreamEvent {
  type: "token" | "done" | "error";
  text?: string;
  message?: string;
}

/** Потоковая отправка в чат. onEvent({type:'token'|'done'|'error'}). */
export async function streamChatSend(
  conversationId: number,
  body: { text: string; model?: string; temperature?: number; maxTokens?: number; stream?: boolean },
  onEvent: (ev: StreamEvent) => void
): Promise<void> {
  const res = await fetch(`${BASE}/api/chat/${conversationId}/send`, {
    method: "POST",
    headers: { ...tokenHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
