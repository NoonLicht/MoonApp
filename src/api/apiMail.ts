/**
 * API почты (server/ts/routes/mail.ts).
 */
import { req, BASE, tokenHeaders, filenameFromDisposition } from "@/api/apiHttp";

export interface MailAccount {
  id: string;
  name: string;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  signature: string;
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
  count?: number;
  unreadCount?: number;
}

export interface MailMessageFull extends MailMessage {
  html: string;
  text: string;
  attachments: MailAttachment[];
  messageId: string;
  references: string;
}

export interface MailFolder {
  path: string;
  name: string;
  special: string;
  unread: number;
  total: number;
}

export interface MailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
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

export interface MailAccountInput extends Partial<MailServers> {
  name?: string;
  email: string;
  username?: string;
  password: string;
}

export interface MailSendInput {
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string;
  readReceipt?: boolean;
  remindAfterDays?: number;
  attachments?: { filename: string; contentType?: string; content: string }[];
  delayMs?: number;
  sendAt?: number;
}

export interface MailListQuery {
  account?: string;
  box?: string;
  folder?: string;
  q?: string;
  unread?: boolean;
  threads?: boolean;
  limit?: number;
  offset?: number;
}

export const mailApi = {
  mailAccounts: () => req<MailAccount[]>("GET", "/mail/accounts"),
  mailGuess: (email: string) =>
    req<MailServers>("GET", `/mail/guess?email=${encodeURIComponent(email)}`),
  mailAddAccount: (a: MailAccountInput) => req<MailAccount>("POST", "/mail/accounts", a),
  mailUpdateAccount: (id: string, p: { name?: string; signature?: string }) =>
    req<MailAccount>("PATCH", `/mail/accounts/${id}`, p),
  mailRemoveAccount: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/accounts/${id}`),
  mailSync: (account?: string) => req<{ added?: number }>("POST", "/mail/sync", { account }),
  mailFolders: (account: string) =>
    req<MailFolder[]>("GET", `/mail/folders?account=${encodeURIComponent(account)}`),
  mailCounts: () => req<Record<string, number>>("GET", "/mail/counts"),
  mailMessages: (q: MailListQuery) => {
    const p = new URLSearchParams();
    if (q.account) p.set("account", q.account);
    if (q.box) p.set("box", q.box);
    if (q.folder) p.set("folder", q.folder);
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
  mailReminder: (id: string, at: number) => req<{ ok: boolean }>("POST", "/mail/reminder", { id, at }),
  mailReminders: () => req<MailMessage[]>("GET", "/mail/reminders"),
  mailSend: (p: MailSendInput) => req<{ id: string; sendAt: number }>("POST", "/mail/send", p),
  mailOutbox: () => req<MailOutboxItem[]>("GET", "/mail/outbox"),
  mailCancelSend: (id: string) => req<{ ok: boolean }>("POST", `/mail/outbox/${id}/cancel`, {}),
  mailRetrySend: (id: string) => req<{ ok: boolean }>("POST", `/mail/outbox/${id}/retry`, {}),
  mailTemplates: () => req<MailTemplate[]>("GET", "/mail/templates"),
  mailSaveTemplate: (t: Partial<MailTemplate> & { name: string }) =>
    req<MailTemplate>("POST", "/mail/templates", t),
  mailRemoveTemplate: (id: string) => req<{ ok: boolean }>("DELETE", `/mail/templates/${id}`),
  mailContacts: (q: string) =>
    req<{ name: string; address: string; count: number; last: number }[]>(
      "GET",
      `/mail/contacts?q=${encodeURIComponent(q)}`,
    ),
  mailContact: (address: string) =>
    req<MailContactCard>("GET", `/mail/contact?address=${encodeURIComponent(address)}`),
  /** Скачивает вложение: запрос с токеном → blob → сохранение через ссылку. */
  mailDownloadAttachment: async (id: string, index: number): Promise<void> => {
    const res = await fetch(`${BASE}/api/mail/attachment/${encodeURIComponent(id)}/${index}`, {
      headers: tokenHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = filenameFromDisposition(res) || "attachment";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
