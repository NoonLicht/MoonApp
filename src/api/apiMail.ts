/**
 * API почты (server/ts/routes/mail.ts).
 */
import { req, BASE, tokenHeaders, filenameFromDisposition } from "@/api/apiHttp";

export interface MailIdentity {
  name: string;
  address: string;
  signature?: string;
}

export interface MailAccount {
  id: string;
  name: string;
  email: string;
  username: string;
  authType: "password" | "oauth";
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  aliases: MailIdentity[];
  defaultSignature: string;
  pinned: boolean;
  color: string;
  lastSync: number;
  error: string;
  unread: number;
}

export interface MailAddr {
  name: string;
  address: string;
}

export interface MailAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface MailMessage {
  id: string;
  account: string;
  folder: string;
  uid: number;
  thread: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  to: MailAddr[];
  cc: MailAddr[];
  date: number;
  seen: boolean;
  flagged: boolean;
  snippet: string;
  hasAttachments: boolean;
  snoozeUntil: number;
  remindAt: number;
  labels: string[];
  count?: number;
  unreadCount?: number;
}

export interface MailIcs {
  method: string;
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  description: string;
  organizer: string;
  organizerName: string;
  status: string;
}

export interface MailMessageFull extends MailMessage {
  html: string;
  text: string;
  attachments: MailAttachment[];
  messageId: string;
  references: string;
  unsubscribe: { https?: string; mailto?: string; oneClick: boolean } | null;
  ics: MailIcs | null;
  trackId: string;
  replyTo: string;
}

export interface MailFolder {
  path: string;
  name: string;
  special: string;
  unread: number;
  total: number;
}

export interface MailLabel {
  label: string;
  count: number;
  unread: number;
}

export interface MailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export interface MailSignature {
  id: string;
  name: string;
  html: string;
}

export interface MailRuleCondition {
  field: "from" | "to" | "cc" | "subject" | "body" | "hasAttachment" | "list" | "size";
  op:
    | "contains"
    | "notContains"
    | "equals"
    | "startsWith"
    | "endsWith"
    | "regex"
    | "gt"
    | "lt"
    | "is";
  value: string;
}

export interface MailRuleAction {
  type: "move" | "markRead" | "star" | "trash" | "spam" | "archive" | "snooze" | "label";
  value?: string;
}

export interface MailRule {
  id: string;
  account: string;
  name: string;
  enabled: boolean;
  matchAll: boolean;
  conditions: MailRuleCondition[];
  actions: MailRuleAction[];
  position: number;
}

export interface MailDraft {
  id: string;
  account: string;
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename: string; contentType?: string; content: string }[];
  updated: number;
}

export interface MailOutboxItem {
  id: string;
  account: string;
  to: string[];
  subject: string;
  sendAt: number;
  status: string;
  error: string;
}

export interface MailContactCard {
  address: string;
  name: string;
  received: number;
  first: number;
  last: number;
  recent: { id: string; subject: string; date: number }[];
}

export interface MailServers {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface MailAutoReply {
  enabled: boolean;
  subject: string;
  body: string;
  from: number;
  to: number;
  onlyKnown: boolean;
}

export interface MailSettings {
  notify: {
    enabled: boolean;
    preview: boolean;
    sound: boolean;
    onlyInbox: boolean;
    badge: boolean;
    quietEnabled: boolean;
    quietFrom: string;
    quietTo: string;
    muted: string[];
  };
  appearance: {
    bodyTheme: "auto" | "light" | "dark";
    density: "cozy" | "compact";
    fontSize: number;
    avatars: "initials" | "gravatar" | "off";
    threads: boolean;
    sendDelaySec: number;
    refreshOnFocus: boolean;
    markReadOnOpen: boolean;
    composeMarkdown: boolean;
    loadImages: boolean;
    accountTags: boolean;
  };
  tracking: { enabled: boolean; base: string; key: string; opens: boolean; clicks: boolean };
  ai: {
    enabled: boolean;
    language: string;
    tone: string;
    engine: "embedding" | "provider" | "llamacpp";
    providerId: string;
    model: string;
    translateEngine: string;
  };
  mcp: { enabled: boolean; key: string; allowSend: boolean; port: number };
  oauth: { googleClientId: string; googleClientSecret: string; microsoftClientId: string };
  smartFolders: { id: string; name: string; query: string; account: string }[];
  pinned: { account: string; path: string; name: string }[];
  autoReply: Record<string, MailAutoReply>;
}

export interface MailAccountInput extends Partial<MailServers> {
  name?: string;
  email: string;
  username?: string;
  password: string;
}

export interface MailSendInput {
  account: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  readReceipt?: boolean;
  remindAfterDays?: number;
  track?: boolean;
  draftId?: string;
  attachments?: { filename: string; contentType?: string; content: string }[];
  delayMs?: number;
  sendAt?: number;
}

export interface MailListQuery {
  account?: string;
  box?: string;
  folder?: string;
  label?: string;
  q?: string;
  unread?: boolean;
  threads?: boolean;
  limit?: number;
  offset?: number;
}

export interface MailAiRequest {
  action:
    | "summarize"
    | "reply"
    | "compose"
    | "improve"
    | "subject"
    | "quick"
    | "tasks"
    | "translate"
    | "digest";
  period?: "day" | "week";
  account?: string;
  id?: string;
  text?: string;
  instruction?: string;
  tone?: string;
  mode?: string;
  lang?: string;
  engine?: string;
}

export interface MailTrackItem {
  trackId: string;
  subject: string;
  to: string[];
  sent: number;
  opens: number;
  clicks: number;
  lastOpen: number;
  events: { id: string; kind: "open" | "click"; url: string; ts: number }[];
}

async function blobFetch(url: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(`${BASE}/api${url}`, { headers: tokenHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { blob: await res.blob(), name: filenameFromDisposition(res) };
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "file";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const mailApi = {
  mailAccounts: () => req<MailAccount[]>("GET", "/mail/accounts"),
  mailGuess: (email: string) =>
    req<MailServers & { oauth: "google" | "microsoft" | ""; oauthReady: boolean }>(
      "GET",
      `/mail/guess?email=${encodeURIComponent(email)}`,
    ),
  mailAddAccount: (a: MailAccountInput) => req<MailAccount>("POST", "/mail/accounts", a),
  mailUpdateAccount: (
    id: string,
    p: Partial<Pick<MailAccount, "name" | "aliases" | "defaultSignature" | "pinned" | "color">>,
  ) => req<MailAccount>("PATCH", `/mail/accounts/${id}`, p),
  mailRemoveAccount: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/accounts/${id}`),
  mailOAuthStart: (provider: "google" | "microsoft") =>
    req<{ id: string; url: string }>("POST", "/mail/oauth/start", { provider }),
  mailOAuthStatus: (id: string) =>
    req<{ status: "pending" | "done" | "error"; email?: string; error?: string }>(
      "GET",
      `/mail/oauth/${id}`,
    ),
  mailSync: (account?: string) => req<{ added?: number }>("POST", "/mail/sync", { account }),
  mailLoadOlder: (account: string, folder: string) =>
    req<{ added: number; hasMore: boolean }>("POST", "/mail/load-older", { account, folder }),
  mailFolders: (account: string) =>
    req<MailFolder[]>("GET", `/mail/folders?account=${encodeURIComponent(account)}`),
  mailLabels: (account: string) =>
    req<MailLabel[]>("GET", `/mail/labels?account=${encodeURIComponent(account)}`),
  mailSetLabel: (ids: string[], label: string, add: boolean) =>
    req<{ ok: boolean }>("POST", "/mail/label", { ids, label, add }),
  mailCreateFolder: (account: string, path: string) =>
    req<{ ok: boolean }>("POST", "/mail/folders", { account, path }),
  mailRenameFolder: (account: string, path: string, rename: string) =>
    req<{ ok: boolean }>("POST", "/mail/folders", { account, path, rename }),
  mailDeleteFolder: (account: string, path: string) =>
    req<{ ok: boolean }>(
      "DELETE",
      `/mail/folders?account=${encodeURIComponent(account)}&path=${encodeURIComponent(path)}`,
    ),
  mailMarkAllRead: (account: string, folder: string) =>
    req<{ count: number }>("POST", "/mail/mark-all-read", { account, folder }),
  mailEmptyFolder: (account: string, special: "\\Trash" | "\\Junk") =>
    req<{ count: number }>("POST", "/mail/empty", { account, special }),
  mailCounts: () => req<Record<string, number>>("GET", "/mail/counts"),
  mailMessages: (q: MailListQuery) => {
    const p = new URLSearchParams();
    if (q.account) p.set("account", q.account);
    if (q.box) p.set("box", q.box);
    if (q.folder) p.set("folder", q.folder);
    if (q.label) p.set("label", q.label);
    if (q.q) p.set("q", q.q);
    if (q.unread) p.set("unread", "1");
    if (q.threads === false) p.set("threads", "0");
    if (q.limit) p.set("limit", String(q.limit));
    if (q.offset) p.set("offset", String(q.offset));
    return req<MailMessage[]>("GET", `/mail/messages?${p.toString()}`);
  },
  mailMessage: (id: string) =>
    req<MailMessageFull>("GET", `/mail/messages/${encodeURIComponent(id)}`),
  mailThread: (id: string) =>
    req<MailMessageFull[]>("GET", `/mail/messages/${encodeURIComponent(id)}/thread`),
  mailFlags: (ids: string[], p: { seen?: boolean; flagged?: boolean }) =>
    req<{ ok: boolean }>("POST", "/mail/flags", { ids, ...p }),
  mailMove: (ids: string[], dest: { special?: string; path?: string }) =>
    req<{ ok: boolean }>("POST", "/mail/move", { ids, ...dest }),
  mailDelete: (ids: string[]) => req<{ ok: boolean }>("POST", "/mail/delete", { ids }),
  mailSnooze: (ids: string[], until: number) =>
    req<{ ok: boolean }>("POST", "/mail/snooze", { ids, until }),
  mailReminder: (id: string, at: number) =>
    req<{ ok: boolean }>("POST", "/mail/reminder", { id, at }),
  mailReminders: () => req<MailMessage[]>("GET", "/mail/reminders"),
  mailUnsubscribe: (id: string) =>
    req<{ done: boolean; method: "oneclick" | "mailto" | "link" | "none"; url?: string }>(
      "POST",
      "/mail/unsubscribe",
      { id },
    ),
  mailInvite: (id: string, partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE") =>
    req<{ id: string }>("POST", "/mail/invite", { id, partstat }),
  mailSend: (p: MailSendInput) => req<{ id: string; sendAt: number }>("POST", "/mail/send", p),
  mailOutbox: () => req<MailOutboxItem[]>("GET", "/mail/outbox"),
  mailCancelSend: (id: string) =>
    req<{ ok: boolean; payload: MailSendInput | null }>("POST", `/mail/outbox/${id}/cancel`, {}),
  mailRetrySend: (id: string) => req<{ ok: boolean }>("POST", `/mail/outbox/${id}/retry`, {}),
  mailDrafts: () => req<MailDraft[]>("GET", "/mail/drafts"),
  mailSaveDraft: (d: Partial<MailDraft> & { account: string; server?: boolean }) =>
    req<MailDraft>("POST", "/mail/drafts", d),
  mailDeleteDraft: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/drafts/${id}`),
  mailTemplates: () => req<MailTemplate[]>("GET", "/mail/templates"),
  mailSaveTemplate: (t: Partial<MailTemplate> & { name: string }) =>
    req<MailTemplate>("POST", "/mail/templates", t),
  mailRemoveTemplate: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/templates/${id}`),
  mailSignatures: () => req<MailSignature[]>("GET", "/mail/signatures"),
  mailSaveSignature: (s: Partial<MailSignature> & { name: string }) =>
    req<MailSignature>("POST", "/mail/signatures", s),
  mailRemoveSignature: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/signatures/${id}`),
  mailRules: () => req<MailRule[]>("GET", "/mail/rules"),
  mailSaveRule: (r: Partial<MailRule> & { name: string }) =>
    req<MailRule>("POST", "/mail/rules", r),
  mailRemoveRule: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/rules/${id}`),
  mailRunRules: (account?: string) =>
    req<{ matched: number }>("POST", "/mail/rules/run", { account }),
  mailSettings: () => req<MailSettings>("GET", "/mail/settings"),
  mailSaveSettings: (
    p: Partial<{ [K in keyof MailSettings]: Partial<MailSettings[K]> }> | Record<string, unknown>,
  ) => req<MailSettings>("PUT", "/mail/settings", p),
  mailGenerateKey: (which: "mcp" | "tracking") =>
    req<{ key: string }>("POST", "/mail/settings/generate-key", { which }),
  mailMcpStatus: () => req<{ running: boolean; port: number }>("GET", "/mail/mcp/status"),
  mailContacts: (q: string) =>
    req<{ name: string; address: string; count: number; last: number }[]>(
      "GET",
      `/mail/contacts?q=${encodeURIComponent(q)}`,
    ),
  mailContact: (address: string) =>
    req<MailContactCard>("GET", `/mail/contact?address=${encodeURIComponent(address)}`),
  mailAi: (r: MailAiRequest) =>
    req<{ text?: string; html?: string; list?: string[]; blocks?: string[] }>(
      "POST",
      "/mail/ai",
      r,
    ),
  mailTracking: () => req<MailTrackItem[]>("GET", "/mail/tracking"),
  mailTrackingWorker: () => req<{ code: string }>("GET", "/mail/tracking/worker"),
  mailBackupExport: () => req<Record<string, unknown>>("GET", "/mail/backup"),
  mailBackupImport: (b: unknown) =>
    req<{ rules: number; signatures: number; templates: number }>("POST", "/mail/backup", b),
  mailImportEml: (account: string, folder: string, data: string) =>
    req<{ imported: number }>("POST", "/mail/import/eml", { account, folder, data }),
  /** Картинка-аватар (Gravatar через сервер); null — нет аватара. */
  mailAvatar: async (address: string): Promise<string | null> => {
    try {
      const res = await fetch(`${BASE}/api/mail/avatar?address=${encodeURIComponent(address)}`, {
        headers: tokenHeaders(),
      });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  },
  /** Картинка из письма через сервер приложения (blob-адрес); null — не удалось. */
  mailRemoteImage: async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(`${BASE}/api/mail/img?u=${encodeURIComponent(url)}`, {
        headers: tokenHeaders(),
      });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  },
  mailAttachmentBlob: async (id: string, index: number): Promise<{ url: string; type: string }> => {
    const { blob } = await blobFetch(
      `/mail/attachment/${encodeURIComponent(id)}/${index}?inline=1`,
    );
    return { url: URL.createObjectURL(blob), type: blob.type };
  },
  mailDownloadAttachment: async (id: string, index: number): Promise<void> => {
    const { blob, name } = await blobFetch(`/mail/attachment/${encodeURIComponent(id)}/${index}`);
    saveBlob(blob, name || "attachment");
  },
  mailDownloadEml: async (id: string): Promise<void> => {
    const { blob } = await blobFetch(`/mail/eml/${encodeURIComponent(id)}`);
    saveBlob(blob, "message.eml");
  },
  mailExportMbox: async (account: string, folder: string): Promise<void> => {
    const { blob } = await blobFetch(
      `/mail/export/mbox?account=${encodeURIComponent(account)}&folder=${encodeURIComponent(folder)}`,
    );
    saveBlob(blob, "mail.mbox");
  },
};
