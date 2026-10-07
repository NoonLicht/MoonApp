/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req, BASE, pageHeaders, multipart } from "@/api/apiHttp";
import type {
  VaultFile,
  VaultFileContent,
  VaultSearchResult,
  VaultTag,
  VaultBacklink,
  NotesAiResult,
  NotesAiConfig,
  HolstFileEntry,
  HolstReadResult,
  HolstWriteResult,
  TaskItem,
  TaskCreatePayload,
  PasswordEntry,
  PasswordEntryFull,
  PasswordEntryInput,
  NotesGitConfig,
  NotesGitSyncResult,
  NotesGitTestResult,
  NotesGitLogEntry,
  NotesGitDiffResult,
  NotesGitRestoreResult,
  QuickNote,
  Bookmark,
  BookmarkInput,
} from "@/api/types";

export const myspaceApi = {
  // Логирование действий пользователя на бэкенде
  // MySpace / Vault
  myspaceTree: () => req<VaultFile[]>("GET", "/myspace/tree"),
  myspaceRead: (path: string) =>
    req<VaultFileContent>("GET", `/myspace/file?path=${encodeURIComponent(path)}`),
  myspaceWrite: (path: string, content: string, frontmatter?: Record<string, string>) =>
    req("POST", "/myspace/file", { path, content, frontmatter }),
  myspaceDelete: (path: string) => req("DELETE", `/myspace/file?path=${encodeURIComponent(path)}`),
  myspaceRename: (oldPath: string, newPath: string) =>
    req("PUT", "/myspace/rename", { oldPath, newPath }),
  myspaceCreateFolder: (path: string) => req("POST", "/myspace/folder", { path }),
  myspaceSearch: (q: string) =>
    req<VaultSearchResult[]>("GET", `/myspace/search?q=${encodeURIComponent(q)}`),
  myspaceTags: () => req<VaultTag[]>("GET", "/myspace/tags"),
  myspaceBacklinks: (path: string) =>
    req<VaultBacklink[]>("GET", `/myspace/backlinks?path=${encodeURIComponent(path)}`),
  // Вставка картинки в заметку (файл/буфер обмена) — грузим на сервер, получаем
  // id и вставляем ![...](url) со ссылкой на /api/myspace/assets/:id.
  myspaceUploadAsset: async (
    file: File | Blob,
    filename?: string,
  ): Promise<{ id: string; url: string }> => {
    const fd = new FormData();
    fd.append("file", file, filename || "image.png");
    const t = window.appBridge?.getToken?.();
    const res = await fetch(`${BASE}/api/myspace/assets`, {
      method: "POST",
      headers: { ...(t ? { "x-moonapp-token": t } : {}), ...pageHeaders() },
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  // ИИ-оформление заметок: «оформить» (сырой текст сохраняется в
  // storage/vault/notes/.ai/<имя>.txt) и «регенерировать» (заново из исходника,
  // текст заметки заменяется целиком). См. server/ts/notesAi.ts.
  myspaceAiFormat: (path: string) => req<NotesAiResult>("POST", "/myspace/ai/format", { path }),
  myspaceAiRegenerate: (path: string) =>
    req<NotesAiResult>("POST", "/myspace/ai/regenerate", { path }),
  // Провайдер и модель ИИ-оформления заметок: выбор сохраняется в настройках
  // (myspace.ai), поэтому задавать его заново в следующий раз не нужно.
  myspaceAiConfig: () => req<NotesAiConfig>("GET", "/myspace/ai/config"),
  myspaceAiSaveConfig: (patch: { providerId?: string; model?: string }) =>
    req<NotesAiConfig>("POST", "/myspace/ai/config", patch),
  myspaceAiModels: (provider: string) =>
    req<{ provider: string; models: string[] }>(
      "GET",
      `/myspace/ai/models?provider=${encodeURIComponent(provider)}`,
    ),
  // MySpace Canvas / Holst
  myspaceListHolsts: () => req<HolstFileEntry[]>("GET", "/myspace/holsts"),
  myspaceReadHolst: (name: string) =>
    req<HolstReadResult>("GET", `/myspace/holst?name=${encodeURIComponent(name)}`),
  myspaceWriteHolst: (name: string, data: any) =>
    req<HolstWriteResult>("POST", "/myspace/holst", { name, data }),
  myspaceDeleteHolst: (name: string) =>
    req<{ ok: boolean }>("DELETE", `/myspace/holst?name=${encodeURIComponent(name)}`),
  // MySpace Tasks
  tasksList: (params?: { status?: string; tag?: string; projectId?: string; search?: string }) =>
    req<TaskItem[]>("GET", `/myspace/tasks?${new URLSearchParams(params as any).toString()}`),
  tasksCreate: (payload: TaskCreatePayload) => req<TaskItem>("POST", "/myspace/tasks", payload),
  tasksUpdate: (id: string, data: Partial<TaskItem>) =>
    req<TaskItem>("PUT", `/myspace/tasks/${id}`, data),
  tasksDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/myspace/tasks/${id}`),
  tasksTimer: (id: string, action: "start" | "pause") =>
    req<TaskItem>("POST", `/myspace/tasks/${id}/timer`, { action }),

  // --- Менеджер паролей ---
  passwordsList: () => req<PasswordEntry[]>("GET", "/passwords"),
  passwordsReveal: (id: string) => req<PasswordEntryFull>("GET", `/passwords/${id}/reveal`),
  passwordsCreate: (payload: PasswordEntryInput) =>
    req<PasswordEntry>("POST", "/passwords", payload),
  passwordsUpdate: (id: string, payload: Partial<PasswordEntryInput>) =>
    req<PasswordEntry>("PUT", `/passwords/${id}`, payload),
  passwordsDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/passwords/${id}`),
  passwordsGenerate: (opts: {
    length?: number;
    digits?: boolean;
    symbols?: boolean;
    upper?: boolean;
    lower?: boolean;
  }) => req<{ password: string }>("POST", "/passwords/generate", opts),

  // --- Git-синхронизация заметок/canvas ---
  notesGitConfig: () => req<NotesGitConfig>("GET", "/notesgit/config"),
  notesGitSetConfig: (payload: {
    remoteUrl?: string;
    branch?: string;
    authorName?: string;
    authorEmail?: string;
    token?: string;
  }) => req<NotesGitConfig>("POST", "/notesgit/config", payload),
  notesGitStatus: () => req<{ dirty: boolean; files: number }>("GET", "/notesgit/status"),
  notesGitSync: () => req<NotesGitSyncResult>("POST", "/notesgit/sync"),
  notesGitTest: () => req<NotesGitTestResult>("POST", "/notesgit/test"),
  notesGitLog: (limit = 50) => req<NotesGitLogEntry[]>("GET", `/notesgit/log?limit=${limit}`),
  notesGitDiff: (oid: string) => req<NotesGitDiffResult>("GET", `/notesgit/diff/${oid}`),
  notesGitRestore: (oid: string) =>
    req<NotesGitRestoreResult>("POST", "/notesgit/restore", { oid }),

  // --- Быстрые голосовые заметки ---
  quickNotesList: () => req<QuickNote[]>("GET", "/quicknotes"),
  quickNotesCreate: (file: File, keepAudio: boolean) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("keepAudio", String(keepAudio));
    return multipart<QuickNote>("/quicknotes", fd);
  },
  quickNotesDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/quicknotes/${id}`),
  quickNotesAudioUrl: (id: string) => `${BASE}/api/quicknotes/${id}/audio`,
  quickNotesStructure: (id: string) => req<QuickNote>("POST", `/quicknotes/${id}/structure`),

  // --- Закладки ---
  bookmarksList: () => req<Bookmark[]>("GET", "/bookmarks"),
  bookmarksCreate: (payload: BookmarkInput) => req<Bookmark>("POST", "/bookmarks", payload),
  bookmarksUpdate: (id: string, payload: Partial<BookmarkInput>) =>
    req<Bookmark>("PUT", `/bookmarks/${id}`, payload),
  bookmarksDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/bookmarks/${id}`),
  bookmarksSaveArticle: (id: string) => req<Bookmark>("POST", `/bookmarks/${id}/save-article`),
  bookmarksSetReaderArchive: (id: string, archiveId: string) =>
    req<Bookmark>("POST", `/bookmarks/${id}/reader-archive`, { archiveId }),
};
