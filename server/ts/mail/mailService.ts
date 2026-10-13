/**
 * Почтовый клиент: учётные записи IMAP/SMTP (пароль или OAuth), синхронизация (в том числе
 * живая через IDLE), действия над письмами, черновики, правила, автоответчик, отправка с
 * отменой и отложенной отправкой, «отложить», напоминания, уведомления.
 *
 * Расширения «Pro» почтовых клиентов реализованы локально, без сервера:
 *  - отложенная отправка / отмена отправки — очередь outbox с таймером;
 *  - отложить письмо (snooze) — поле snooze_until, письмо возвращается во входящие;
 *  - напоминание «нет ответа» — поле remind_at, проверка по цепочке;
 *  - шаблоны, подписи и профили отправителя, единый ящик, поиск с операторами, цепочки;
 *  - отслеживание открытий/ссылок — через необязательный собственный endpoint (mailTracking.ts).
 */
import crypto from "crypto";
import dns from "dns";
import net from "net";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MailComposer = require("nodemailer/lib/mail-composer") as new (o: unknown) => {
  compile(): { build(cb: (err: Error | null, msg: Buffer) => void): void };
};
import logger from "../logger";
import { encryptSecret, decryptSecret } from "../security";
import { mailDb } from "./mailDb";
import { getSettings } from "./mailSettings";
import { attachmentText } from "./mailAttText";
import { parseIcs, buildReply, type IcsEvent } from "./mailIcs";
import {
  actionsFor,
  parseListUnsubscribe,
  type Rule,
  type RuleAction,
  type RuleSubject,
} from "./mailRules";
import { notifyNew, setBadge, type NewMailInfo } from "./mailNotify";
import {
  freshAccessToken,
  oauthServers,
  oauthStart,
  packTokens,
  type OAuthProvider,
  type OAuthTokens,
} from "./mailOAuth";
import { decorateOutgoing, pollTracking } from "./mailTracking";

/* ------------------------------- типы ------------------------------------- */

export interface Identity {
  name: string;
  address: string;
  signature?: string;
}

export interface AccountInput {
  name?: string;
  email: string;
  username?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  signature?: string;
}

export interface AccountView {
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
  aliases: Identity[];
  defaultSignature: string;
  pinned: boolean;
  color: string;
  lastSync: number;
  error: string;
  unread: number;
}

export interface Addr {
  name: string;
  address: string;
}

export interface AttachmentMeta {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface MessageRow {
  id: string;
  account: string;
  folder: string;
  uid: number;
  thread: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  to: Addr[];
  cc: Addr[];
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

export interface SendPayload {
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
  headers?: Record<string, string>;
  ical?: { method: string; content: string };
  attachments?: { filename: string; contentType?: string; content: string }[];
  /** Через сколько миллисекунд отправить (окно отмены или «отправить позже»). */
  delayMs?: number;
  sendAt?: number;
}

/* ----------------------------- автонастройка ------------------------------ */

const PRESETS: Record<string, { imap: [string, number]; smtp: [string, number] }> = {
  "gmail.com": { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465] },
  "googlemail.com": { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465] },
  "outlook.com": { imap: ["outlook.office365.com", 993], smtp: ["smtp.office365.com", 587] },
  "hotmail.com": { imap: ["outlook.office365.com", 993], smtp: ["smtp.office365.com", 587] },
  "live.com": { imap: ["outlook.office365.com", 993], smtp: ["smtp.office365.com", 587] },
  "yandex.ru": { imap: ["imap.yandex.ru", 993], smtp: ["smtp.yandex.ru", 465] },
  "yandex.com": { imap: ["imap.yandex.com", 993], smtp: ["smtp.yandex.com", 465] },
  "ya.ru": { imap: ["imap.yandex.ru", 993], smtp: ["smtp.yandex.ru", 465] },
  "mail.ru": { imap: ["imap.mail.ru", 993], smtp: ["smtp.mail.ru", 465] },
  "inbox.ru": { imap: ["imap.mail.ru", 993], smtp: ["smtp.mail.ru", 465] },
  "list.ru": { imap: ["imap.mail.ru", 993], smtp: ["smtp.mail.ru", 465] },
  "bk.ru": { imap: ["imap.mail.ru", 993], smtp: ["smtp.mail.ru", 465] },
  "yahoo.com": { imap: ["imap.mail.yahoo.com", 993], smtp: ["smtp.mail.yahoo.com", 465] },
  "icloud.com": { imap: ["imap.mail.me.com", 993], smtp: ["smtp.mail.me.com", 587] },
  "me.com": { imap: ["imap.mail.me.com", 993], smtp: ["smtp.mail.me.com", 587] },
  "fastmail.com": { imap: ["imap.fastmail.com", 993], smtp: ["smtp.fastmail.com", 465] },
  "proton.me": { imap: ["127.0.0.1", 1143], smtp: ["127.0.0.1", 1025] },
  "rambler.ru": { imap: ["imap.rambler.ru", 993], smtp: ["smtp.rambler.ru", 465] },
};

export function guessServers(email: string): {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  oauth: OAuthProvider | "";
} {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const p = PRESETS[domain];
  const oauth: OAuthProvider | "" = /^(gmail|googlemail)\.com$/.test(domain)
    ? "google"
    : /^(outlook|hotmail|live|msn)\.com$|\.onmicrosoft\.com$/.test(domain)
      ? "microsoft"
      : "";
  if (p) {
    return {
      imapHost: p.imap[0],
      imapPort: p.imap[1],
      imapSecure: p.imap[1] === 993,
      smtpHost: p.smtp[0],
      smtpPort: p.smtp[1],
      smtpSecure: p.smtp[1] === 465,
      oauth,
    };
  }
  return {
    imapHost: domain ? `imap.${domain}` : "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: domain ? `smtp.${domain}` : "",
    smtpPort: 465,
    smtpSecure: true,
    oauth,
  };
}

/* ------------------------------- аккаунты --------------------------------- */

interface AccountRow {
  id: string;
  name: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  pass_enc: string;
  signature: string;
  created: number;
  last_sync: number;
  error: string;
  auth_type: string;
  oauth_enc: string;
  aliases: string;
  default_signature: string;
  pinned: number;
  color: string;
}

function accountRow(id: string): AccountRow {
  const r = mailDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    AccountRow | undefined;
  if (!r) throw new Error("account_not_found");
  return r;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toView(r: AccountRow): AccountView {
  const unread = (
    mailDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder
         WHERE m.account = ? AND f.special = '\\Inbox' AND m.seen = 0 AND m.snooze_until = 0`,
      )
      .get(r.id) as { n: number }
  ).n;
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    username: r.username,
    authType: r.auth_type === "oauth" ? "oauth" : "password",
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: !!r.imap_secure,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: !!r.smtp_secure,
    aliases: parseJson<Identity[]>(r.aliases, []),
    defaultSignature: r.default_signature,
    pinned: !!r.pinned,
    color: r.color,
    lastSync: r.last_sync,
    error: r.error,
    unread,
  };
}

export function listAccounts(): AccountView[] {
  const rows = mailDb()
    .prepare("SELECT * FROM accounts ORDER BY pinned DESC, created")
    .all() as AccountRow[];
  return rows.map(toView);
}

async function imapAuth(
  r: AccountRow,
): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (r.auth_type === "oauth") {
    const accessToken = await freshAccessToken(r.oauth_enc, (enc) =>
      mailDb().prepare("UPDATE accounts SET oauth_enc = ? WHERE id = ?").run(enc, r.id),
    );
    return { user: r.email, accessToken };
  }
  return { user: r.username, pass: decryptSecret(r.pass_enc) };
}

async function clientFor(r: AccountRow): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: r.imap_host,
    port: r.imap_port,
    secure: !!r.imap_secure,
    auth: await imapAuth(r),
    logger: false,
    socketTimeout: 60_000,
  });
  // без обработчика «error» ошибка сокета роняет процесс
  c.on("error", () => undefined);
  return c;
}

async function verify(r: AccountRow): Promise<void> {
  const c = await clientFor(r);
  try {
    await c.connect();
  } catch (e) {
    throw new Error("imap_login_failed: " + (e as Error).message, { cause: e });
  } finally {
    try {
      await c.logout();
    } catch {
      /* соединения нет */
    }
  }
}

/** Проверка входа на SMTP: без неё ящик «подключается», а отправка потом падает. */
async function verifySmtp(r: AccountRow): Promise<void> {
  const t = nodemailer.createTransport({
    host: r.smtp_host,
    port: r.smtp_port,
    secure: !!r.smtp_secure,
    auth: { user: r.username, pass: decryptSecret(r.pass_enc) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  try {
    await t.verify();
  } catch (e) {
    throw new Error("smtp_login_failed: " + (e as Error).message, { cause: e });
  } finally {
    t.close();
  }
}

export async function addAccount(input: AccountInput): Promise<AccountView> {
  const email = String(input.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("bad_email");
  if (!input.password) throw new Error("password_required");
  const g = guessServers(email);
  const row: AccountRow = {
    id: crypto.randomUUID(),
    name: String(input.name || email).trim(),
    email,
    imap_host: input.imapHost || g.imapHost,
    imap_port: input.imapPort || g.imapPort,
    imap_secure: (input.imapSecure ?? g.imapSecure) ? 1 : 0,
    smtp_host: input.smtpHost || g.smtpHost,
    smtp_port: input.smtpPort || g.smtpPort,
    smtp_secure: (input.smtpSecure ?? g.smtpSecure) ? 1 : 0,
    username: String(input.username || email).trim(),
    pass_enc: encryptSecret(String(input.password)),
    signature: String(input.signature || ""),
    created: Date.now(),
    last_sync: 0,
    error: "",
    auth_type: "password",
    oauth_enc: "",
    aliases: "[]",
    default_signature: "",
    pinned: 0,
    color: "",
  };
  await verify(row);
  await verifySmtp(row);
  insertAccount(row);
  return toView(row);
}

function insertAccount(row: AccountRow): void {
  mailDb()
    .prepare(
      `INSERT INTO accounts (id,name,email,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username,pass_enc,signature,created,last_sync,error,auth_type,oauth_enc,aliases,default_signature,pinned,color)
       VALUES (@id,@name,@email,@imap_host,@imap_port,@imap_secure,@smtp_host,@smtp_port,@smtp_secure,@username,@pass_enc,@signature,@created,@last_sync,@error,@auth_type,@oauth_enc,@aliases,@default_signature,@pinned,@color)`,
    )
    .run(row);
  startLoops();
  void syncAccount(row.id).catch(() => undefined);
  startIdle(row.id);
}

/** Вход через аккаунт Google/Microsoft: возвращает адрес страницы авторизации и id сеанса. */
export async function startOAuthLogin(
  provider: OAuthProvider,
): Promise<{ id: string; url: string }> {
  return oauthStart(provider, async ({ email, name, tokens }) => {
    const exists = mailDb()
      .prepare("SELECT id FROM accounts WHERE lower(email) = ?")
      .get(email.toLowerCase()) as { id: string } | undefined;
    if (exists) {
      mailDb()
        .prepare("UPDATE accounts SET oauth_enc = ?, auth_type = 'oauth', error = '' WHERE id = ?")
        .run(packTokens(tokens as OAuthTokens), exists.id);
      return exists.id;
    }
    const s = oauthServers(provider);
    const row: AccountRow = {
      id: crypto.randomUUID(),
      name,
      email,
      imap_host: s.imap.host,
      imap_port: s.imap.port,
      imap_secure: 1,
      smtp_host: s.smtp.host,
      smtp_port: s.smtp.port,
      smtp_secure: s.smtp.port === 465 ? 1 : 0,
      username: email,
      pass_enc: "",
      signature: "",
      created: Date.now(),
      last_sync: 0,
      error: "",
      auth_type: "oauth",
      oauth_enc: packTokens(tokens as OAuthTokens),
      aliases: "[]",
      default_signature: "",
      pinned: 0,
      color: "",
    };
    insertAccount(row);
    return row.id;
  });
}

export function updateAccount(
  id: string,
  patch: {
    name?: string;
    signature?: string;
    aliases?: Identity[];
    defaultSignature?: string;
    pinned?: boolean;
    color?: string;
  },
): AccountView {
  const r = accountRow(id);
  mailDb()
    .prepare(
      "UPDATE accounts SET name = ?, signature = ?, aliases = ?, default_signature = ?, pinned = ?, color = ? WHERE id = ?",
    )
    .run(
      patch.name ?? r.name,
      patch.signature ?? r.signature,
      JSON.stringify(patch.aliases ?? parseJson<Identity[]>(r.aliases, [])),
      patch.defaultSignature ?? r.default_signature,
      (patch.pinned ?? !!r.pinned) ? 1 : 0,
      patch.color ?? r.color,
      id,
    );
  return toView(accountRow(id));
}

export function removeAccount(id: string): void {
  stopIdle(id);
  const d = mailDb();
  d.transaction(() => {
    d.prepare("DELETE FROM messages WHERE account = ?").run(id);
    d.prepare("DELETE FROM folders WHERE account = ?").run(id);
    d.prepare("DELETE FROM outbox WHERE account = ?").run(id);
    d.prepare("DELETE FROM drafts WHERE account = ?").run(id);
    d.prepare("DELETE FROM rules WHERE account = ?").run(id);
    d.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
  refreshBadge();
}

/* ------------------------------ синхронизация ----------------------------- */

const syncing = new Set<string>();
const INITIAL_COUNT = 200;
const OTHER_FOLDER_COUNT = 60;
const OLDER_PAGE = 100;

function addrList(a: AddressObject | AddressObject[] | undefined): Addr[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: Addr[] = [];
  for (const o of arr)
    for (const v of o.value) out.push({ name: v.name || "", address: v.address || "" });
  return out;
}

function normMsgId(s: string | undefined): string {
  return (s || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function bufToDataUri(content: Buffer, type: string): string {
  return `data:${type};base64,${content.toString("base64")}`;
}

function threadFor(
  account: string,
  msgid: string,
  inReplyTo: string,
  refs: string[],
  subject: string,
): string {
  const d = mailDb();
  const candidates = [inReplyTo, ...refs.slice().reverse()].map(normMsgId).filter(Boolean);
  for (const c of candidates) {
    const r = d
      .prepare("SELECT thread FROM messages WHERE account = ? AND msgid = ? LIMIT 1")
      .get(account, c) as { thread: string } | undefined;
    if (r?.thread) return r.thread;
  }
  if (refs.length) return `${account}:${normMsgId(refs[0])}`;
  if (inReplyTo) return `${account}:${normMsgId(inReplyTo)}`;
  // письмо без заголовков цепочки: «Re: тема» садится к существующей теме, иначе — своя
  const base = subject
    .replace(/^((re|fwd?|ответ|пересл)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
  if (base && base !== subject.toLowerCase()) {
    const r = d
      .prepare("SELECT thread FROM messages WHERE account = ? AND lower(subject) = ? LIMIT 1")
      .get(account, base) as { thread: string } | undefined;
    if (r?.thread) return r.thread;
  }
  return `${account}:${msgid || crypto.randomUUID()}`;
}

interface Stored {
  id: string;
  isNew: boolean;
  seen: boolean;
  subject: string;
  fromName: string;
  fromAddr: string;
  snippet: string;
  subjectInfo: RuleSubject;
  listUnsub: boolean;
  autoSubmitted: boolean;
}

async function storeParsed(
  account: string,
  folder: string,
  uid: number,
  flags: Set<string> | undefined,
  labels: Set<string> | undefined,
  source: Buffer,
): Promise<Stored> {
  const p: ParsedMail = await simpleParser(source);
  const html0 = typeof p.html === "string" ? p.html : "";
  let html = html0;
  const atts: AttachmentMeta[] = [];
  let ics = "";
  const textJobs: Promise<string>[] = [];
  (p.attachments || []).forEach((a, i) => {
    const inline = !!a.cid && a.contentDisposition !== "attachment";
    if (
      inline &&
      a.cid &&
      html &&
      a.content &&
      a.size < 1_500_000 &&
      a.contentType.startsWith("image/")
    ) {
      html = html.split(`cid:${a.cid}`).join(bufToDataUri(a.content, a.contentType));
    }
    if (
      !ics &&
      (a.contentType === "text/calendar" || /\.ics$/i.test(a.filename || "")) &&
      a.content
    ) {
      const ev = parseIcs(a.content.toString("utf8"));
      if (ev) ics = JSON.stringify(ev);
    }
    if (!inline && textJobs.length < 5 && a.content) {
      textJobs.push(attachmentText(a.filename || "", a.contentType, a.content).catch(() => ""));
    }
    atts.push({
      index: i,
      filename: a.filename || `attachment-${i + 1}`,
      contentType: a.contentType,
      size: a.size,
      inline,
    });
  });
  const attText = (await Promise.all(textJobs)).join(" ").slice(0, 40_000);
  const text = p.text || "";
  const from = p.from?.value?.[0];
  const msgid = normMsgId(p.messageId);
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const subject = p.subject || "";
  const id = `${account}|${folder}|${uid}`;
  const prev = mailDb()
    .prepare("SELECT thread, snooze_until, remind_at, track_id FROM messages WHERE id = ?")
    .get(id) as
    { thread: string; snooze_until: number; remind_at: number; track_id: string } | undefined;
  const thread = prev?.thread || threadFor(account, msgid, normMsgId(p.inReplyTo), refs, subject);
  // исходные строки заголовков: mailparser сворачивает List-* в объект, теряя детали
  const hdr = (k: string): string => {
    const line = p.headerLines.find((h) => h.key === k);
    return line
      ? line.line
          .replace(/^[^:]+:\s*/, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  };
  const listUnsub = hdr("list-unsubscribe");
  const oneClick = /one-click/i.test(hdr("list-unsubscribe-post"));
  const autoSubmitted = !!hdr("auto-submitted") && hdr("auto-submitted").toLowerCase() !== "no";
  const bulk = /bulk|list|junk/i.test(hdr("precedence"));
  const snippet = snippetOf(text || html0.replace(/<[^>]+>/g, " "));
  const seen = flags?.has("\\Seen") ? 1 : 0;
  const to = addrList(p.to);
  const cc = addrList(p.cc);
  mailDb()
    .prepare(
      `INSERT OR REPLACE INTO messages
       (id,account,folder,uid,msgid,in_reply_to,refs,thread,subject,from_name,from_addr,to_json,cc_json,date,seen,flagged,snippet,html,text,att_json,snooze_until,remind_at,labels,list_unsub,list_unsub_post,ics,att_text,size,track_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      account,
      folder,
      uid,
      msgid,
      normMsgId(p.inReplyTo),
      refs.map(normMsgId).join(" "),
      thread,
      subject,
      from?.name || "",
      (from?.address || "").toLowerCase(),
      JSON.stringify(to),
      JSON.stringify(cc),
      (p.date || new Date()).getTime(),
      seen,
      flags?.has("\\Flagged") ? 1 : 0,
      snippet,
      html,
      text,
      JSON.stringify(atts),
      prev?.snooze_until ?? 0,
      prev?.remind_at ?? 0,
      labels ? [...labels].filter((l) => !l.startsWith("\\")).join("\u0001") : "",
      listUnsub,
      oneClick ? 1 : 0,
      ics,
      attText,
      source.length,
      prev?.track_id ?? "",
    );
  const replyTo = p.replyTo?.value?.[0]?.address?.toLowerCase() ?? "";
  if (replyTo) mailDb().prepare("UPDATE messages SET reply_to = ? WHERE id = ?").run(replyTo, id);
  return {
    id,
    isNew: !prev,
    seen: !!seen,
    subject,
    fromName: from?.name || "",
    fromAddr: (from?.address || "").toLowerCase(),
    snippet,
    listUnsub: !!listUnsub || bulk,
    autoSubmitted,
    subjectInfo: {
      from: (from?.address || "").toLowerCase(),
      fromName: from?.name || "",
      to: to.map((a) => `${a.name} ${a.address}`).join(" "),
      cc: cc.map((a) => `${a.name} ${a.address}`).join(" "),
      subject,
      body: text.slice(0, 5000),
      hasAttachment: atts.some((a) => !a.inline),
      isList: !!listUnsub || bulk,
      size: source.length,
    },
  };
}

function specialOf(path: string, specialUse: string | undefined): string {
  if (path.toUpperCase() === "INBOX") return "\\Inbox";
  return specialUse || "";
}

function isGmail(r: AccountRow): boolean {
  return /(^|\.)(gmail|googlemail)\.com$/i.test(r.imap_host);
}

function rulesFor(account: string): Rule[] {
  const rows = mailDb()
    .prepare(
      "SELECT * FROM rules WHERE enabled = 1 AND (account = '' OR account = ?) ORDER BY position",
    )
    .all(account) as {
    id: string;
    account: string;
    name: string;
    enabled: number;
    match_all: number;
    conditions: string;
    actions: string;
    position: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.account,
    name: r.name,
    enabled: !!r.enabled,
    matchAll: !!r.match_all,
    conditions: parseJson(r.conditions, []),
    actions: parseJson(r.actions, []),
    position: r.position,
  }));
}

async function applyAction(id: string, a: RuleAction): Promise<void> {
  switch (a.type) {
    case "markRead":
      await setFlags([id], { seen: true });
      break;
    case "star":
      await setFlags([id], { flagged: true });
      break;
    case "trash":
      await moveMessages([id], { special: "\\Trash" });
      break;
    case "spam":
      await moveMessages([id], { special: "\\Junk" });
      break;
    case "archive":
      await moveMessages([id], { special: "\\Archive" });
      break;
    case "move":
      if (a.value) await moveMessages([id], { path: a.value });
      break;
    case "snooze":
      snooze([id], Date.now() + (Number(a.value) || 1) * 3_600_000);
      break;
    case "label":
      if (a.value) await addGmailLabel(id, a.value);
      break;
    default:
  }
}

async function addGmailLabel(id: string, label: string): Promise<void> {
  const l = loc(id);
  if (!isGmail(accountRow(l.account))) return;
  await withMailbox(l.account, l.folder, async (c) => {
    await c.messageFlagsAdd(String(l.uid), [label], { uid: true, useLabels: true });
  });
}

/** Обработка действительно новых писем: правила, автоответчик, уведомления. */
async function processIncoming(r: AccountRow, fresh: Stored[]): Promise<void> {
  const rules = rulesFor(r.id);
  const settings = getSettings();
  const notify: NewMailInfo[] = [];
  for (const m of fresh) {
    let consumed = false;
    if (rules.length) {
      const acts = actionsFor(rules, m.subjectInfo);
      for (const a of acts) {
        try {
          await applyAction(m.id, a);
          if (["move", "trash", "spam", "archive", "snooze"].includes(a.type)) consumed = true;
        } catch (e) {
          logger.warn("mail.rule_failed", { error: (e as Error).message });
        }
      }
    }
    if (consumed) continue;
    await maybeAutoReply(r, m, settings.autoReply[r.id]).catch(() => undefined);
    if (!m.seen) {
      notify.push({
        account: r.id,
        accountLabel: r.email,
        from: m.fromName || m.fromAddr,
        subject: m.subject,
        snippet: m.snippet,
        id: m.id,
      });
    }
  }
  if (notify.length) notifyNew(notify);
}

async function maybeAutoReply(
  r: AccountRow,
  m: Stored,
  cfg:
    | {
        enabled: boolean;
        subject: string;
        body: string;
        from: number;
        to: number;
        onlyKnown: boolean;
      }
    | undefined,
): Promise<void> {
  if (!cfg?.enabled || !m.fromAddr || m.autoSubmitted || m.listUnsub) return;
  const now = Date.now();
  if ((cfg.from && now < cfg.from) || (cfg.to && now > cfg.to)) return;
  if (m.fromAddr === r.email.toLowerCase()) return;
  if (/(no-?reply|noreply|mailer-daemon|postmaster|notifications?@)/i.test(m.fromAddr)) return;
  const d = mailDb();
  const last = d
    .prepare("SELECT ts FROM replied WHERE account = ? AND addr = ?")
    .get(r.id, m.fromAddr) as { ts: number } | undefined;
  if (last && now - last.ts < 7 * 86_400_000) return;
  if (cfg.onlyKnown) {
    const known = d
      .prepare(
        `SELECT 1 FROM messages x JOIN folders f ON f.account = x.account AND f.path = x.folder
         WHERE x.account = ? AND f.special = '\\Sent' AND x.to_json LIKE ? LIMIT 1`,
      )
      .get(r.id, `%${m.fromAddr}%`);
    if (!known) return;
  }
  d.prepare("INSERT OR REPLACE INTO replied (account, addr, ts) VALUES (?,?,?)").run(
    r.id,
    m.fromAddr,
    now,
  );
  queueSend({
    account: r.id,
    to: [m.fromAddr],
    subject: cfg.subject || `Re: ${m.subject}`,
    html: cfg.body.replace(/\n/g, "<br>"),
    text: cfg.body,
    headers: { "Auto-Submitted": "auto-replied", Precedence: "bulk" },
    delayMs: 0,
  });
}

export async function syncAccount(id: string): Promise<{ added: number }> {
  if (syncing.has(id)) return { added: 0 };
  syncing.add(id);
  const d = mailDb();
  let added = 0;
  const r = accountRow(id);
  const firstSync = r.last_sync === 0;
  const fresh: Stored[] = [];
  const c = await clientFor(r).catch((e: Error) => {
    d.prepare("UPDATE accounts SET error = ? WHERE id = ?").run(e.message.slice(0, 300), id);
    syncing.delete(id);
    throw e;
  });
  try {
    await c.connect();
    const gmail = isGmail(r) || c.capabilities.has("X-GM-EXT-1");
    const boxes = await c.list();
    const upFolder = d.prepare(
      `INSERT INTO folders (account,path,name,special) VALUES (?,?,?,?)
       ON CONFLICT(account,path) DO UPDATE SET name = excluded.name, special = excluded.special`,
    );
    const keep: string[] = [];
    const seenPaths = new Set<string>();
    for (const b of boxes) {
      if (b.flags?.has("\\Noselect") || b.flags?.has("\\NonExistent")) continue;
      const sp = specialOf(b.path, b.specialUse);
      upFolder.run(id, b.path, b.name || b.path, sp);
      seenPaths.add(b.path);
      if (gmail) {
        // Gmail: ярлыки — это метки; синхронизируем почтовые ящики, не копии по каждой метке
        if (sp && sp !== "\\Flagged") keep.push(b.path);
      } else keep.push(b.path);
    }
    // папки, удалённые на сервере, убираем из кэша
    for (const f of d.prepare("SELECT path FROM folders WHERE account = ?").all(id) as {
      path: string;
    }[]) {
      if (!seenPaths.has(f.path)) {
        d.prepare("DELETE FROM folders WHERE account = ? AND path = ?").run(id, f.path);
        d.prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(id, f.path);
      }
    }
    for (const path of keep) {
      const f = d
        .prepare("SELECT special FROM folders WHERE account = ? AND path = ?")
        .get(id, path) as {
        special: string;
      };
      const limit = f.special ? INITIAL_COUNT : OTHER_FOLDER_COUNT;
      const lock = await c.getMailboxLock(path);
      try {
        const mb = c.mailbox;
        if (!mb || typeof mb === "boolean") continue;
        const have = d
          .prepare("SELECT uid FROM messages WHERE account = ? AND folder = ?")
          .all(id, path) as { uid: number }[];
        const haveSet = new Set(have.map((x) => x.uid));
        const maxUid = have.reduce((m, x) => Math.max(m, x.uid), 0);
        const toFetch: number[] = [];
        if (mb.exists > 0) {
          const serverUids = (await c.search({ all: true }, { uid: true })) || [];
          const alive = new Set(serverUids);
          const del = d.prepare(
            "DELETE FROM messages WHERE account = ? AND folder = ? AND uid = ?",
          );
          for (const u of haveSet) if (!alive.has(u)) del.run(id, path, u);
          const freshUids = serverUids.filter((u) => !haveSet.has(u));
          // уже загруженные «старые» письма не перекачиваем: берём только новее максимума
          const picked = maxUid ? freshUids.filter((u) => u > maxUid) : freshUids.slice(-limit);
          toFetch.push(...picked);
          if (haveSet.size) {
            const minUid = Math.min(...haveSet);
            const up = d.prepare(
              "UPDATE messages SET seen = ?, flagged = ? WHERE account = ? AND folder = ? AND uid = ?",
            );
            for await (const m of c.fetch(
              `${minUid}:*`,
              { uid: true, flags: true },
              { uid: true },
            )) {
              if (haveSet.has(m.uid)) {
                up.run(
                  m.flags?.has("\\Seen") ? 1 : 0,
                  m.flags?.has("\\Flagged") ? 1 : 0,
                  id,
                  path,
                  m.uid,
                );
              }
            }
          }
        } else {
          d.prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(id, path);
        }
        const q = { uid: true, flags: true, source: true, ...(gmail ? { labels: true } : {}) };
        for (let i = 0; i < toFetch.length; i += 50) {
          const chunk = toFetch.slice(i, i + 50);
          for await (const m of c.fetch(chunk.join(","), q, { uid: true })) {
            if (!m.source) continue;
            try {
              const st = await storeParsed(id, path, m.uid, m.flags, m.labels, m.source);
              added++;
              if (!firstSync && st.isNew && f.special === "\\Inbox") fresh.push(st);
            } catch (e) {
              logger.warn("mail.parse_failed", { uid: m.uid, error: (e as Error).message });
            }
          }
        }
      } finally {
        lock.release();
      }
    }
    d.prepare("UPDATE accounts SET last_sync = ?, error = '' WHERE id = ?").run(Date.now(), id);
  } catch (e) {
    d.prepare("UPDATE accounts SET error = ? WHERE id = ?").run(
      (e as Error).message.slice(0, 300),
      id,
    );
    throw e;
  } finally {
    syncing.delete(id);
    try {
      await c.logout();
    } catch {
      /* соединение уже закрыто */
    }
  }
  if (fresh.length) await processIncoming(r, fresh).catch(() => undefined);
  refreshBadge();
  return { added };
}

/** Подгрузка более старых писем папки (после первых 200). */
export async function loadOlder(
  account: string,
  folder: string,
): Promise<{ added: number; hasMore: boolean }> {
  const d = mailDb();
  const r = accountRow(account);
  const gmail = isGmail(r);
  return withMailbox(account, folder, async (c) => {
    const have = d
      .prepare("SELECT uid FROM messages WHERE account = ? AND folder = ?")
      .all(account, folder) as { uid: number }[];
    const haveSet = new Set(have.map((x) => x.uid));
    const all = ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b);
    const older = all.filter((u) => !haveSet.has(u));
    const minHave = haveSet.size ? Math.min(...haveSet) : Infinity;
    const candidates = older.filter((u) => u < minHave);
    const picked = candidates.slice(-OLDER_PAGE);
    let added = 0;
    if (picked.length) {
      const q = { uid: true, flags: true, source: true, ...(gmail ? { labels: true } : {}) };
      for await (const m of c.fetch(picked.join(","), q, { uid: true })) {
        if (!m.source) continue;
        try {
          await storeParsed(account, folder, m.uid, m.flags, m.labels, m.source);
          added++;
        } catch {
          /* битое письмо пропускаем */
        }
      }
    }
    return { added, hasMore: candidates.length > picked.length };
  });
}

export async function syncAll(): Promise<void> {
  for (const a of listAccounts()) {
    try {
      await syncAccount(a.id);
    } catch (e) {
      logger.warn("mail.sync_failed", { account: a.email, error: (e as Error).message });
    }
  }
}

/* --------------------------- живая синхронизация -------------------------- */

interface Idler {
  stop: boolean;
  client: ImapFlow | null;
}
const idlers = new Map<string, Idler>();

export function startIdle(id: string): void {
  if (idlers.has(id)) return;
  const st: Idler = { stop: false, client: null };
  idlers.set(id, st);
  const run = async () => {
    let backoff = 5_000;
    while (!st.stop) {
      try {
        const c = await clientFor(accountRow(id));
        st.client = c;
        await c.connect();
        await c.mailboxOpen("INBOX");
        backoff = 5_000;
        let t: NodeJS.Timeout | null = null;
        const kick = () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => void syncAccount(id).catch(() => undefined), 1_500);
        };
        c.on("exists", kick);
        c.on("expunge", kick);
        c.on("flags", kick);
        await new Promise<void>((resolve) => {
          c.once("close", () => resolve());
        });
        if (t) clearTimeout(t);
      } catch (e) {
        logger.warn("mail.idle_failed", { error: (e as Error).message });
      }
      st.client = null;
      if (st.stop) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 300_000);
    }
  };
  void run();
}

export function stopIdle(id: string): void {
  const st = idlers.get(id);
  if (!st) return;
  st.stop = true;
  try {
    void st.client?.logout();
  } catch {
    /* уже закрыто */
  }
  idlers.delete(id);
}

/* ------------------------------ чтение ------------------------------------ */

export interface ListQuery {
  account?: string;
  /** inbox | sent | drafts | trash | spam | archive | starred | snoozed | all */
  box?: string;
  folder?: string;
  label?: string;
  q?: string;
  unread?: boolean;
  threads?: boolean;
  limit?: number;
  offset?: number;
}

const SPECIAL: Record<string, string> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  spam: "\\Junk",
  archive: "\\Archive",
};

interface Raw {
  id: string;
  account: string;
  folder: string;
  uid: number;
  thread: string;
  subject: string;
  from_name: string;
  from_addr: string;
  to_json: string;
  cc_json: string;
  date: number;
  seen: number;
  flagged: number;
  snippet: string;
  att_json: string;
  snooze_until: number;
  remind_at: number;
  labels: string;
  cnt?: number;
  unread_cnt?: number;
}

function mapRow(r: Raw): MessageRow {
  let hasAtt = false;
  try {
    hasAtt = (JSON.parse(r.att_json) as AttachmentMeta[]).some((a) => !a.inline);
  } catch {
    /* повреждённый JSON — считаем, что вложений нет */
  }
  return {
    id: r.id,
    account: r.account,
    folder: r.folder,
    uid: r.uid,
    thread: r.thread,
    subject: r.subject,
    fromName: r.from_name,
    fromAddr: r.from_addr,
    to: parseJson<Addr[]>(r.to_json, []),
    cc: parseJson<Addr[]>(r.cc_json, []),
    date: r.date,
    seen: !!r.seen,
    flagged: !!r.flagged,
    snippet: r.snippet,
    hasAttachments: hasAtt,
    snoozeUntil: r.snooze_until,
    remindAt: r.remind_at,
    labels: r.labels ? r.labels.split("\u0001").filter(Boolean) : [],
    count: r.cnt,
    unreadCount: r.unread_cnt,
  };
}

/** Разбор строки поиска: from:, to:, subject:, has:attachment, is:unread, is:starred, label:, in:attachment, before:/after: + текст. */
export function parseSearch(q: string): { where: string[]; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const free: string[] = [];
  const tokens = q.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) ?? [];
  for (const raw of tokens) {
    const m = /^(from|to|subject|has|is|label|in|before|after|filename)(:)(.*)$/i.exec(raw);
    if (!m) {
      free.push(raw.replace(/^"|"$/g, ""));
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[3].replace(/^"|"$/g, "").toLowerCase();
    if (key === "from") {
      where.push("(lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ?)");
      args.push(`%${val}%`, `%${val}%`);
    } else if (key === "to") {
      where.push("lower(m.to_json) LIKE ?");
      args.push(`%${val}%`);
    } else if (key === "subject") {
      where.push("lower(m.subject) LIKE ?");
      args.push(`%${val}%`);
    } else if (key === "label") {
      where.push("lower(m.labels) LIKE ?");
      args.push(`%${val}%`);
    } else if (key === "filename") {
      where.push("lower(m.att_json) LIKE ?");
      args.push(`%"filename":"%${val}%`);
    } else if (key === "in" && val.startsWith("attach")) {
      where.push("lower(m.att_text) LIKE ?");
      args.push(`%${free.join(" ").toLowerCase() || ""}%`);
    } else if (key === "has" && val.startsWith("attach")) {
      where.push("m.att_json LIKE '%\"inline\":false%'");
    } else if (key === "is" && val === "unread") where.push("m.seen = 0");
    else if (key === "is" && val === "read") where.push("m.seen = 1");
    else if (key === "is" && val === "starred") where.push("m.flagged = 1");
    else if (key === "before" || key === "after") {
      const t = Date.parse(val);
      if (Number.isFinite(t)) {
        where.push(key === "before" ? "m.date < ?" : "m.date >= ?");
        args.push(t);
      }
    } else free.push(raw);
  }
  for (const f of free) {
    where.push(
      "(lower(m.subject) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ? OR lower(m.text) LIKE ? OR lower(m.att_text) LIKE ?)",
    );
    const like = `%${f.toLowerCase()}%`;
    args.push(like, like, like, like, like);
  }
  return { where, args };
}

export function listMessages(q: ListQuery): MessageRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const now = Date.now();
  if (q.account && q.account !== "all") {
    where.push("m.account = ?");
    args.push(q.account);
  }
  if (q.folder) {
    where.push("m.folder = ?");
    args.push(q.folder);
  } else if (q.label) {
    where.push("(m.labels = ? OR m.labels LIKE ? OR m.labels LIKE ? OR m.labels LIKE ?)");
    args.push(q.label, `${q.label}\u0001%`, `%\u0001${q.label}`, `%\u0001${q.label}\u0001%`);
  } else if (q.box === "starred") {
    where.push("m.flagged = 1");
    where.push("f.special NOT IN ('\\Trash','\\Junk')");
  } else if (q.box === "snoozed") {
    where.push("m.snooze_until > ?");
    args.push(now);
  } else if (q.box === "archive") {
    // Gmail: «Вся почта»; обычные серверы: папка Archive
    where.push("f.special IN ('\\Archive','\\All')");
  } else if (q.box && SPECIAL[q.box]) {
    where.push("f.special = ?");
    args.push(SPECIAL[q.box]);
  }
  if (q.box !== "snoozed") {
    where.push("m.snooze_until <= ?");
    args.push(now);
  }
  if (q.unread) where.push("m.seen = 0");
  if (q.q) {
    const s = parseSearch(q.q);
    where.push(...s.where);
    args.push(...s.args);
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const cols =
    "m.id,m.account,m.folder,m.uid,m.thread,m.subject,m.from_name,m.from_addr,m.to_json,m.cc_json,m.date,m.seen,m.flagged,m.snippet,m.att_json,m.snooze_until,m.remind_at,m.labels";
  const cond = where.length ? "WHERE " + where.join(" AND ") : "";
  const from = "FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder";
  const dedupe = "COALESCE(NULLIF(m.msgid,''), m.id)";
  let rows: Raw[];
  if (q.threads !== false) {
    rows = mailDb()
      .prepare(
        `SELECT * FROM (
           SELECT ${cols},
             ROW_NUMBER() OVER (PARTITION BY m.thread ORDER BY m.date DESC) AS rn,
             COUNT(*) OVER (PARTITION BY m.thread) AS cnt,
             SUM(1 - m.seen) OVER (PARTITION BY m.thread) AS unread_cnt
           ${from} ${cond}
         ) WHERE rn = 1 ORDER BY date DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Raw[];
  } else {
    rows = mailDb()
      .prepare(
        `SELECT * FROM (
           SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY m.account, ${dedupe} ORDER BY m.date DESC) AS rn
           ${from} ${cond}
         ) WHERE rn = 1 ORDER BY date DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Raw[];
  }
  return rows.map(mapRow);
}

export interface MessageFull extends MessageRow {
  html: string;
  text: string;
  attachments: AttachmentMeta[];
  messageId: string;
  references: string;
  unsubscribe: { https?: string; mailto?: string; oneClick: boolean } | null;
  ics: IcsEvent | null;
  trackId: string;
  /** Адрес из заголовка Reply-To (пусто — отвечать отправителю). */
  replyTo: string;
}

export function getMessage(id: string): MessageFull | null {
  const r = mailDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | (Raw & {
        html: string;
        text: string;
        msgid: string;
        refs: string;
        list_unsub: string;
        list_unsub_post: number;
        ics: string;
        track_id: string;
        reply_to: string;
      })
    | undefined;
  if (!r) return null;
  return {
    ...mapRow(r),
    html: r.html,
    text: r.text,
    attachments: parseJson<AttachmentMeta[]>(r.att_json, []),
    messageId: r.msgid,
    references: [r.refs, r.msgid].filter(Boolean).join(" "),
    unsubscribe: r.list_unsub ? parseListUnsubscribe(r.list_unsub, !!r.list_unsub_post) : null,
    ics: r.ics ? parseJson<IcsEvent | null>(r.ics, null) : null,
    trackId: r.track_id,
    replyTo: r.reply_to,
  };
}

/** Все письма цепочки по возрастанию даты. */
export function getThread(id: string): MessageFull[] {
  const m = mailDb().prepare("SELECT thread FROM messages WHERE id = ?").get(id) as
    { thread: string } | undefined;
  if (!m) return [];
  const ids = mailDb()
    .prepare("SELECT id FROM messages WHERE thread = ? ORDER BY date ASC")
    .all(m.thread) as { id: string }[];
  return ids.map((x) => getMessage(x.id)).filter((x): x is MessageFull => !!x);
}

export function listFolders(
  account: string,
): { path: string; name: string; special: string; unread: number; total: number }[] {
  return mailDb()
    .prepare(
      `SELECT f.path, f.name, f.special,
         (SELECT COUNT(*) FROM messages m WHERE m.account = f.account AND m.folder = f.path AND m.seen = 0) AS unread,
         (SELECT COUNT(*) FROM messages m WHERE m.account = f.account AND m.folder = f.path) AS total
       FROM folders f WHERE f.account = ? ORDER BY (f.special = '') , f.special, f.name`,
    )
    .all(account) as {
    path: string;
    name: string;
    special: string;
    unread: number;
    total: number;
  }[];
}

/** Метки (Gmail): уникальные пользовательские метки с числом писем. */
export function listLabels(account: string): { label: string; count: number; unread: number }[] {
  const rows = mailDb()
    .prepare("SELECT labels, seen FROM messages WHERE account = ? AND labels != ''")
    .all(account) as { labels: string; seen: number }[];
  const map = new Map<string, { count: number; unread: number }>();
  for (const r of rows) {
    for (const l of r.labels.split("\u0001")) {
      if (!l) continue;
      const e = map.get(l) ?? { count: 0, unread: 0 };
      e.count++;
      if (!r.seen) e.unread++;
      map.set(l, e);
    }
  }
  return [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function boxCounts(): Record<string, number> {
  const d = mailDb();
  const now = Date.now();
  const n = (sql: string, ...a: (string | number)[]) =>
    (d.prepare(sql).get(...a) as { n: number }).n;
  const base =
    "SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder";
  return {
    inbox: n(`${base} WHERE f.special = '\\Inbox' AND m.seen = 0 AND m.snooze_until <= ?`, now),
    drafts: n("SELECT COUNT(*) AS n FROM drafts") + n(`${base} WHERE f.special = '\\Drafts'`),
    starred: n(`${base} WHERE m.flagged = 1 AND f.special NOT IN ('\\Trash','\\Junk')`),
    snoozed: n(`${base} WHERE m.snooze_until > ?`, now),
    outbox: n("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
  };
}

export function refreshBadge(): void {
  try {
    const c = boxCounts().inbox ?? 0;
    setBadge(c);
  } catch {
    /* база закрыта */
  }
}

/** Контакты из переписки: частота и последний контакт. */
export function contacts(
  query: string,
): { name: string; address: string; count: number; last: number }[] {
  const like = `%${query.toLowerCase()}%`;
  return mailDb()
    .prepare(
      `SELECT from_addr AS address, MAX(from_name) AS name, COUNT(*) AS count, MAX(date) AS last
       FROM messages WHERE from_addr != '' AND (lower(from_addr) LIKE ? OR lower(from_name) LIKE ?)
       GROUP BY from_addr ORDER BY count DESC LIMIT 12`,
    )
    .all(like, like) as { address: string; name: string; count: number; last: number }[];
}

export function contactCard(address: string): {
  address: string;
  name: string;
  received: number;
  first: number;
  last: number;
  recent: { id: string; subject: string; date: number }[];
} {
  const a = address.toLowerCase();
  const d = mailDb();
  const s = d
    .prepare(
      "SELECT MAX(from_name) AS name, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM messages WHERE from_addr = ?",
    )
    .get(a) as { name: string | null; n: number; first: number | null; last: number | null };
  const recent = d
    .prepare(
      "SELECT id, subject, date FROM messages WHERE from_addr = ? ORDER BY date DESC LIMIT 5",
    )
    .all(a) as { id: string; subject: string; date: number }[];
  return {
    address: a,
    name: s.name || "",
    received: s.n,
    first: s.first ?? 0,
    last: s.last ?? 0,
    recent,
  };
}

/* ------------------------------ действия ---------------------------------- */

interface MsgLoc {
  account: string;
  folder: string;
  uid: number;
}

function loc(id: string): MsgLoc {
  const r = mailDb().prepare("SELECT account, folder, uid FROM messages WHERE id = ?").get(id) as
    MsgLoc | undefined;
  if (!r) throw new Error("message_not_found");
  return r;
}

/** «t:<id>» — все письма цепочки, лежащие в той же папке, что и указанное письмо. */
export function expandIds(ids: string[]): string[] {
  const out = new Set<string>();
  const d = mailDb();
  for (const raw of ids) {
    if (!raw.startsWith("t:")) {
      out.add(raw);
      continue;
    }
    const id = raw.slice(2);
    const m = d.prepare("SELECT thread, account, folder FROM messages WHERE id = ?").get(id) as
      { thread: string; account: string; folder: string } | undefined;
    if (!m) continue;
    const rows = d
      .prepare("SELECT id FROM messages WHERE thread = ? AND account = ? AND folder = ?")
      .all(m.thread, m.account, m.folder) as { id: string }[];
    for (const r of rows) out.add(r.id);
  }
  return [...out];
}

async function withMailbox<T>(
  account: string,
  folder: string,
  fn: (c: ImapFlow) => Promise<T>,
): Promise<T> {
  const c = await clientFor(accountRow(account));
  await c.connect();
  try {
    const lock = await c.getMailboxLock(folder);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  } finally {
    try {
      await c.logout();
    } catch {
      /* уже закрыто */
    }
  }
}

function folderBySpecial(account: string, special: string): string | null {
  const r = mailDb()
    .prepare("SELECT path FROM folders WHERE account = ? AND special = ? LIMIT 1")
    .get(account, special) as { path: string } | undefined;
  return r?.path ?? null;
}

export async function setFlags(
  rawIds: string[],
  patch: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  const ids = expandIds(rawIds);
  const d = mailDb();
  const groups = new Map<string, MsgLoc[]>();
  for (const id of ids) {
    let l: MsgLoc;
    try {
      l = loc(id);
    } catch {
      continue;
    }
    if (patch.seen !== undefined)
      d.prepare("UPDATE messages SET seen = ? WHERE id = ?").run(patch.seen ? 1 : 0, id);
    if (patch.flagged !== undefined)
      d.prepare("UPDATE messages SET flagged = ? WHERE id = ?").run(patch.flagged ? 1 : 0, id);
    const k = `${l.account}|${l.folder}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  refreshBadge();
  for (const [k, locs] of groups) {
    const sep = k.indexOf("|");
    const account = k.slice(0, sep);
    const folder = k.slice(sep + 1);
    const range = locs.map((x) => x.uid).join(",");
    try {
      await withMailbox(account, folder, async (c) => {
        if (patch.seen !== undefined) {
          if (patch.seen) await c.messageFlagsAdd(range, ["\\Seen"], { uid: true });
          else await c.messageFlagsRemove(range, ["\\Seen"], { uid: true });
        }
        if (patch.flagged !== undefined) {
          if (patch.flagged) await c.messageFlagsAdd(range, ["\\Flagged"], { uid: true });
          else await c.messageFlagsRemove(range, ["\\Flagged"], { uid: true });
        }
      });
    } catch (e) {
      logger.warn("mail.flags_failed", { error: (e as Error).message });
    }
  }
}

/** Переместить: dest — путь папки либо special (\\Trash / \\Archive / \\Junk). */
export async function moveMessages(
  rawIds: string[],
  dest: { path?: string; special?: string },
): Promise<void> {
  const ids = expandIds(rawIds);
  const d = mailDb();
  const groups = new Map<string, MsgLoc[]>();
  for (const id of ids) {
    let l: MsgLoc;
    try {
      l = loc(id);
    } catch {
      continue;
    }
    const k = `${l.account}|${l.folder}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const touched = new Set<string>();
  for (const [k, locs] of groups) {
    const sep = k.indexOf("|");
    const account = k.slice(0, sep);
    const folder = k.slice(sep + 1);
    const target =
      dest.path ??
      (dest.special
        ? (folderBySpecial(account, dest.special) ??
          (dest.special === "\\Archive" ? folderBySpecial(account, "\\All") : null))
        : null);
    if (!target) throw new Error("folder_not_found");
    if (target === folder) continue;
    const range = locs.map((x) => x.uid).join(",");
    await withMailbox(account, folder, async (c) => {
      await c.messageMove(range, target, { uid: true });
    });
    const del = d.prepare("DELETE FROM messages WHERE account = ? AND folder = ? AND uid = ?");
    for (const l of locs) del.run(account, folder, l.uid);
    touched.add(account);
  }
  refreshBadge();
  // новое положение подхватит синхронизация
  for (const a of touched) void syncAccount(a).catch(() => undefined);
}

export async function deleteForever(rawIds: string[]): Promise<void> {
  const d = mailDb();
  for (const id of expandIds(rawIds)) {
    let l: MsgLoc;
    try {
      l = loc(id);
    } catch {
      continue;
    }
    try {
      await withMailbox(l.account, l.folder, async (c) => {
        await c.messageDelete(String(l.uid), { uid: true });
      });
    } catch (e) {
      logger.warn("mail.delete_failed", { error: (e as Error).message });
    }
    d.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }
  refreshBadge();
}

export function snooze(rawIds: string[], until: number): void {
  const st = mailDb().prepare("UPDATE messages SET snooze_until = ? WHERE id = ?");
  for (const id of expandIds(rawIds)) st.run(until > Date.now() ? until : 0, id);
  refreshBadge();
}

export function setReminder(id: string, at: number): void {
  mailDb()
    .prepare("UPDATE messages SET remind_at = ? WHERE id = ?")
    .run(at > 0 ? at : 0, id);
}

export async function fetchSource(id: string): Promise<Buffer | null> {
  const l = loc(id);
  return withMailbox(l.account, l.folder, async (c) => {
    const m = await c.fetchOne(String(l.uid), { source: true }, { uid: true });
    return m && m.source ? m.source : null;
  });
}

export async function fetchAttachment(
  id: string,
  index: number,
): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  const src = await fetchSource(id);
  if (!src) return null;
  const p = await simpleParser(src);
  const a = p.attachments?.[index];
  if (!a) return null;
  return {
    filename: a.filename || `attachment-${index + 1}`,
    contentType: a.contentType,
    content: a.content,
  };
}

/** Импорт .eml в папку: письмо кладётся на сервер и появляется после синхронизации. */
export async function importEml(account: string, folder: string, raw: Buffer): Promise<void> {
  const c = await clientFor(accountRow(account));
  await c.connect();
  try {
    await c.append(folder, raw, []);
  } finally {
    await c.logout().catch(() => undefined);
  }
  void syncAccount(account).catch(() => undefined);
}

/** Адрес из письма нельзя использовать для запросов во внутреннюю сеть (SSRF). */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === "::1" ||
      l === "::" ||
      l.startsWith("fc") ||
      l.startsWith("fd") ||
      l.startsWith("fe80") ||
      l.startsWith("::ffff:")
    );
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return true;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad_url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new Error("private_address_blocked");
  return u;
}

/** Отписка: one-click POST (RFC 8058), иначе письмо на mailto; ссылку без one-click открывает клиент. */
export async function unsubscribe(
  id: string,
): Promise<{ done: boolean; method: "oneclick" | "mailto" | "link" | "none"; url?: string }> {
  const m = getMessage(id);
  if (!m?.unsubscribe) return { done: false, method: "none" };
  const u = m.unsubscribe;
  if (u.https && u.oneClick) {
    const target = await assertPublicUrl(u.https);
    try {
      const res = await fetch(target, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 MoonApp",
        },
        body: "List-Unsubscribe=One-Click",
        signal: AbortSignal.timeout(15_000),
      });
      // 2xx — отписано; 3xx — сервис принял запрос и перенаправил на страницу подтверждения
      if (res.ok || (res.status >= 300 && res.status < 400))
        return { done: true, method: "oneclick" };
    } catch {
      /* сервер недоступен — пробуем остальные способы ниже */
    }
  }
  if (u.mailto) {
    const url = new URL(u.mailto);
    queueSend({
      account: m.account,
      to: [decodeURIComponent(url.pathname)],
      subject: url.searchParams.get("subject") || "unsubscribe",
      html: url.searchParams.get("body") || "unsubscribe",
      delayMs: 0,
    });
    return { done: true, method: "mailto" };
  }
  if (u.https) return { done: false, method: "link", url: u.https };
  return { done: false, method: "none" };
}

/** Картинка из письма через сервер: приложение не пускает «чужие» адреса напрямую (CSP). */
export async function fetchRemoteImage(raw: string): Promise<{ type: string; data: Buffer }> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const target = await assertPublicUrl(url);
    const res = await fetch(target, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 MoonApp", Accept: "image/*,*/*;q=0.5" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, target).toString();
      continue;
    }
    if (!res.ok) throw new Error("image_http_" + res.status);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\//.test(type) || type === "image/svg+xml") throw new Error("not_an_image");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) throw new Error("image_too_large");
    return { type, data };
  }
  throw new Error("image_unreachable");
}

/* --------------------- метки, папки, массовые операции -------------------- */

/** Gmail: поставить/снять метку (X-GM-LABELS). */
export async function setLabel(rawIds: string[], label: string, add: boolean): Promise<void> {
  const groups = new Map<string, MsgLoc[]>();
  for (const id of expandIds(rawIds)) {
    let l: MsgLoc;
    try {
      l = loc(id);
    } catch {
      continue;
    }
    const k = `${l.account}|${l.folder}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const d = mailDb();
  for (const [k, locs] of groups) {
    const sep = k.indexOf("|");
    const account = k.slice(0, sep);
    const folder = k.slice(sep + 1);
    if (!isGmail(accountRow(account))) throw new Error("labels_gmail_only");
    await withMailbox(account, folder, async (c) => {
      const range = locs.map((x) => x.uid).join(",");
      if (add) await c.messageFlagsAdd(range, [label], { uid: true, useLabels: true });
      else await c.messageFlagsRemove(range, [label], { uid: true, useLabels: true });
    });
    // локальная копия меток обновляется сразу
    for (const l of locs) {
      const r = d
        .prepare("SELECT labels FROM messages WHERE account = ? AND folder = ? AND uid = ?")
        .get(account, folder, l.uid) as { labels: string } | undefined;
      if (!r) continue;
      const set = new Set(r.labels.split("\u0001").filter(Boolean));
      if (add) set.add(label);
      else set.delete(label);
      d.prepare("UPDATE messages SET labels = ? WHERE account = ? AND folder = ? AND uid = ?").run(
        [...set].join("\u0001"),
        account,
        folder,
        l.uid,
      );
    }
  }
}

async function withClient<T>(account: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = await clientFor(accountRow(account));
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

export async function createFolder(account: string, path: string): Promise<void> {
  const name = path.trim();
  if (!name) throw new Error("name_required");
  await withClient(account, (c) => c.mailboxCreate(name));
  mailDb()
    .prepare("INSERT OR IGNORE INTO folders (account, path, name, special) VALUES (?,?,?, '')")
    .run(account, name, name.split(/[/.]/).pop() || name);
}

export async function renameFolder(account: string, path: string, next: string): Promise<void> {
  const name = next.trim();
  if (!name) throw new Error("name_required");
  await withClient(account, (c) => c.mailboxRename(path, name));
  const d = mailDb();
  d.transaction(() => {
    d.prepare("UPDATE folders SET path = ?, name = ? WHERE account = ? AND path = ?").run(
      name,
      name.split(/[/.]/).pop() || name,
      account,
      path,
    );
    d.prepare(
      "UPDATE messages SET folder = ?, id = account || '|' || ? || '|' || uid WHERE account = ? AND folder = ?",
    ).run(name, name, account, path);
  })();
}

export async function deleteFolder(account: string, path: string): Promise<void> {
  const f = mailDb()
    .prepare("SELECT special FROM folders WHERE account = ? AND path = ?")
    .get(account, path) as { special: string } | undefined;
  if (f?.special) throw new Error("system_folder");
  await withClient(account, (c) => c.mailboxDelete(path));
  mailDb().prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(account, path);
  mailDb().prepare("DELETE FROM folders WHERE account = ? AND path = ?").run(account, path);
}

/** Отметить прочитанными всё в папке (или во входящих всех ящиков). */
export async function markAllRead(account: string, folder: string): Promise<number> {
  const d = mailDb();
  const rows = d
    .prepare("SELECT id FROM messages WHERE account = ? AND folder = ? AND seen = 0")
    .all(account, folder) as { id: string }[];
  if (!rows.length) return 0;
  await setFlags(
    rows.map((r) => r.id),
    { seen: true },
  );
  return rows.length;
}

/** Очистить «Корзину» или «Спам»: письма удаляются на сервере навсегда. */
export async function emptyFolder(account: string, special: string): Promise<number> {
  if (special !== "\\Trash" && special !== "\\Junk") throw new Error("not_allowed");
  const path = folderBySpecial(account, special);
  if (!path) return 0;
  const rows = mailDb()
    .prepare("SELECT id FROM messages WHERE account = ? AND folder = ?")
    .all(account, path) as { id: string }[];
  if (!rows.length) return 0;
  await withMailbox(account, path, async (c) => {
    const uids = (await c.search({ all: true }, { uid: true })) || [];
    if (uids.length) await c.messageDelete(uids.join(","), { uid: true });
  });
  mailDb().prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(account, path);
  refreshBadge();
  return rows.length;
}

/* ------------------------------- шаблоны ---------------------------------- */

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export function listTemplates(): Template[] {
  return mailDb().prepare("SELECT * FROM templates ORDER BY name").all() as Template[];
}

export function saveTemplate(t: Partial<Template> & { name: string }): Template {
  const id = t.id || crypto.randomUUID();
  mailDb()
    .prepare("INSERT OR REPLACE INTO templates (id,name,subject,body) VALUES (?,?,?,?)")
    .run(id, t.name, t.subject ?? "", t.body ?? "");
  return { id, name: t.name, subject: t.subject ?? "", body: t.body ?? "" };
}

export function removeTemplate(id: string): void {
  mailDb().prepare("DELETE FROM templates WHERE id = ?").run(id);
}

/* -------------------------------- подписи --------------------------------- */

export interface Signature {
  id: string;
  name: string;
  html: string;
}

export function listSignatures(): Signature[] {
  return mailDb().prepare("SELECT * FROM signatures ORDER BY name").all() as Signature[];
}

export function saveSignature(s: Partial<Signature> & { name: string }): Signature {
  const id = s.id || crypto.randomUUID();
  mailDb()
    .prepare("INSERT OR REPLACE INTO signatures (id,name,html) VALUES (?,?,?)")
    .run(id, s.name, s.html ?? "");
  return { id, name: s.name, html: s.html ?? "" };
}

export function removeSignature(id: string): void {
  mailDb().prepare("DELETE FROM signatures WHERE id = ?").run(id);
  mailDb()
    .prepare("UPDATE accounts SET default_signature = '' WHERE default_signature = ?")
    .run(id);
}

/* -------------------------------- правила --------------------------------- */

export function listRules(): Rule[] {
  const rows = mailDb().prepare("SELECT * FROM rules ORDER BY position, name").all() as {
    id: string;
    account: string;
    name: string;
    enabled: number;
    match_all: number;
    conditions: string;
    actions: string;
    position: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.account,
    name: r.name,
    enabled: !!r.enabled,
    matchAll: !!r.match_all,
    conditions: parseJson(r.conditions, []),
    actions: parseJson(r.actions, []),
    position: r.position,
  }));
}

export function saveRule(r: Partial<Rule> & { name: string }): Rule {
  const id = r.id || crypto.randomUUID();
  const pos =
    r.position ??
    (mailDb().prepare("SELECT COALESCE(MAX(position),0)+1 AS p FROM rules").get() as { p: number })
      .p;
  mailDb()
    .prepare(
      "INSERT OR REPLACE INTO rules (id,account,name,enabled,match_all,conditions,actions,position) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      r.account ?? "",
      r.name,
      (r.enabled ?? true) ? 1 : 0,
      (r.matchAll ?? true) ? 1 : 0,
      JSON.stringify(r.conditions ?? []),
      JSON.stringify(r.actions ?? []),
      pos,
    );
  return listRules().find((x) => x.id === id) as Rule;
}

export function removeRule(id: string): void {
  mailDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
}

/** Прогон правил по уже загруженным письмам папки «Входящие». */
export async function runRulesNow(account?: string): Promise<{ matched: number }> {
  const rows = mailDb()
    .prepare(
      `SELECT m.id, m.account, m.from_addr, m.from_name, m.to_json, m.cc_json, m.subject, m.text, m.att_json, m.list_unsub, m.size
       FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder
       WHERE f.special = '\\Inbox' ${account ? "AND m.account = ?" : ""} ORDER BY m.date DESC LIMIT 500`,
    )
    .all(...(account ? [account] : [])) as {
    id: string;
    account: string;
    from_addr: string;
    from_name: string;
    to_json: string;
    cc_json: string;
    subject: string;
    text: string;
    att_json: string;
    list_unsub: string;
    size: number;
  }[];
  let matched = 0;
  const cache = new Map<string, Rule[]>();
  for (const m of rows) {
    const rules = cache.get(m.account) ?? rulesFor(m.account);
    cache.set(m.account, rules);
    const subj: RuleSubject = {
      from: m.from_addr,
      fromName: m.from_name,
      to: parseJson<Addr[]>(m.to_json, [])
        .map((a) => `${a.name} ${a.address}`)
        .join(" "),
      cc: parseJson<Addr[]>(m.cc_json, [])
        .map((a) => `${a.name} ${a.address}`)
        .join(" "),
      subject: m.subject,
      body: m.text.slice(0, 5000),
      hasAttachment: parseJson<AttachmentMeta[]>(m.att_json, []).some((a) => !a.inline),
      isList: !!m.list_unsub,
      size: m.size,
    };
    const acts = actionsFor(rules, subj);
    if (!acts.length) continue;
    matched++;
    for (const a of acts) {
      try {
        await applyAction(m.id, a);
      } catch {
        /* следующее действие */
      }
    }
  }
  return { matched };
}

/* ------------------------------- черновики -------------------------------- */

export interface DraftInput {
  id?: string;
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
  /** true — отправить копию на сервер в «Черновики» (при закрытии окна). */
  server?: boolean;
}

export interface DraftView extends DraftInput {
  id: string;
  updated: number;
}

export function listDrafts(): DraftView[] {
  const rows = mailDb()
    .prepare("SELECT id, payload, updated FROM drafts ORDER BY updated DESC")
    .all() as {
    id: string;
    payload: string;
    updated: number;
  }[];
  return rows.map((r) => ({
    ...parseJson<DraftInput>(r.payload, {} as DraftInput),
    id: r.id,
    updated: r.updated,
  }));
}

export function getDraft(id: string): DraftView | null {
  return listDrafts().find((d) => d.id === id) ?? null;
}

export async function saveDraft(d: DraftInput): Promise<DraftView> {
  const id = d.id || crypto.randomUUID();
  const now = Date.now();
  const { server, ...payload } = d;
  const empty =
    !payload.to?.trim() &&
    !payload.subject?.trim() &&
    !(payload.html || "").replace(/<[^>]+>|&nbsp;|\s/g, "").length &&
    !(payload.attachments?.length ?? 0);
  if (empty) {
    mailDb().prepare("DELETE FROM drafts WHERE id = ?").run(id);
    return { ...d, id, updated: now };
  }
  mailDb()
    .prepare(
      `INSERT INTO drafts (id, account, payload, updated) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET account = excluded.account, payload = excluded.payload, updated = excluded.updated`,
    )
    .run(id, d.account || "", JSON.stringify({ ...payload, id }), now);
  if (server && d.account) {
    try {
      await pushDraftToServer(id);
    } catch (e) {
      logger.warn("mail.draft_push_failed", { error: (e as Error).message });
    }
  }
  return { ...payload, id, updated: now };
}

async function buildRaw(p: SendPayload, acc: AccountRow, draft = false): Promise<Buffer> {
  const from =
    p.from && p.from.includes("@")
      ? p.from
      : acc.name && acc.name !== acc.email
        ? `"${acc.name.replace(/"/g, "")}" <${acc.email}>`
        : acc.email;
  const headers: Record<string, string> = { ...(p.headers ?? {}) };
  if (p.readReceipt) headers["Disposition-Notification-To"] = acc.email;
  const mail: Record<string, unknown> = {
    from,
    to: p.to,
    cc: p.cc,
    bcc: draft ? undefined : p.bcc,
    subject: p.subject,
    html: p.html,
    text:
      p.text ??
      p.html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    inReplyTo: p.inReplyTo ? `<${p.inReplyTo.replace(/^<|>$/g, "")}>` : undefined,
    references: p.references
      ? p.references
          .split(/\s+/)
          .filter(Boolean)
          .map((x) => `<${x.replace(/^<|>$/g, "")}>`)
      : undefined,
    headers,
    attachments: (p.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.content, "base64"),
    })),
  };
  if (p.ical) mail.icalEvent = { method: p.ical.method, content: p.ical.content };
  return new Promise<Buffer>((resolve, reject) =>
    new MailComposer(mail).compile().build((err, msg) => (err ? reject(err) : resolve(msg))),
  );
}

async function pushDraftToServer(id: string): Promise<void> {
  const d = mailDb()
    .prepare("SELECT account, payload, server_folder, server_uid FROM drafts WHERE id = ?")
    .get(id) as
    { account: string; payload: string; server_folder: string; server_uid: number } | undefined;
  if (!d || !d.account) return;
  const acc = accountRow(d.account);
  const folder = folderBySpecial(acc.id, "\\Drafts");
  if (!folder) return;
  const p = parseJson<DraftInput>(d.payload, {} as DraftInput);
  const raw = await buildRaw(
    {
      account: acc.id,
      from: p.from,
      to: (p.to || "")
        .split(/[,;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      cc: (p.cc || "")
        .split(/[,;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      subject: p.subject || "",
      html: p.html || "",
      inReplyTo: p.inReplyTo,
      references: p.references,
      attachments: p.attachments,
    },
    acc,
    true,
  );
  const c = await clientFor(acc);
  await c.connect();
  try {
    if (d.server_uid && d.server_folder) {
      const lock = await c.getMailboxLock(d.server_folder);
      try {
        await c.messageDelete(String(d.server_uid), { uid: true });
      } catch {
        /* старая копия уже удалена */
      } finally {
        lock.release();
      }
    }
    const res = await c.append(folder, raw, ["\\Draft", "\\Seen"]);
    const uid =
      res && typeof res === "object" && "uid" in res
        ? Number((res as { uid?: number }).uid) || 0
        : 0;
    mailDb()
      .prepare("UPDATE drafts SET server_folder = ?, server_uid = ? WHERE id = ?")
      .run(folder, uid, id);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

export async function deleteDraft(id: string): Promise<void> {
  const d = mailDb()
    .prepare("SELECT account, server_folder, server_uid FROM drafts WHERE id = ?")
    .get(id) as { account: string; server_folder: string; server_uid: number } | undefined;
  mailDb().prepare("DELETE FROM drafts WHERE id = ?").run(id);
  if (d?.server_uid && d.server_folder && d.account) {
    try {
      await withMailbox(d.account, d.server_folder, async (c) => {
        await c.messageDelete(String(d.server_uid), { uid: true });
      });
    } catch {
      /* копии на сервере уже нет */
    }
  }
}

/* ------------------------------- отправка --------------------------------- */

export interface OutboxItem {
  id: string;
  account: string;
  to: string[];
  subject: string;
  sendAt: number;
  status: string;
  error: string;
}

export function queueSend(p: SendPayload): { id: string; sendAt: number } {
  accountRow(p.account);
  if (!p.to?.length) throw new Error("recipient_required");
  const id = crypto.randomUUID();
  const sendAt =
    p.sendAt && p.sendAt > Date.now() ? p.sendAt : Date.now() + Math.max(0, p.delayMs ?? 0);
  mailDb()
    .prepare(
      "INSERT INTO outbox (id,account,payload,send_at,status,error,created) VALUES (?,?,?,?, 'pending','',?)",
    )
    .run(id, p.account, JSON.stringify(p), sendAt, Date.now());
  if (sendAt <= Date.now() + 50) void processOutbox().catch(() => undefined);
  return { id, sendAt };
}

export function cancelSend(id: string): SendPayload | null {
  const r = mailDb()
    .prepare("SELECT payload FROM outbox WHERE id = ? AND status = 'pending'")
    .get(id) as { payload: string } | undefined;
  if (!r) return null;
  mailDb().prepare("DELETE FROM outbox WHERE id = ?").run(id);
  return parseJson<SendPayload>(r.payload, null as unknown as SendPayload);
}

export function listOutbox(): OutboxItem[] {
  const rows = mailDb()
    .prepare("SELECT id, account, payload, send_at, status, error FROM outbox ORDER BY send_at")
    .all() as {
    id: string;
    account: string;
    payload: string;
    send_at: number;
    status: string;
    error: string;
  }[];
  return rows.map((r) => {
    const p = parseJson<Partial<SendPayload>>(r.payload, {});
    return {
      id: r.id,
      account: r.account,
      to: p.to ?? [],
      subject: p.subject ?? "",
      sendAt: r.send_at,
      status: r.status,
      error: r.error,
    };
  });
}

let sendingNow = false;

async function sendOne(p: SendPayload): Promise<void> {
  const acc = accountRow(p.account);
  const auth =
    acc.auth_type === "oauth"
      ? {
          type: "OAuth2" as const,
          user: acc.email,
          accessToken: await freshAccessToken(acc.oauth_enc, (enc) =>
            mailDb().prepare("UPDATE accounts SET oauth_enc = ? WHERE id = ?").run(enc, acc.id),
          ),
        }
      : { user: acc.username, pass: decryptSecret(acc.pass_enc) };
  const transport = nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: !!acc.smtp_secure,
    auth,
  });
  const toAll = [...p.to, ...(p.cc ?? []), ...(p.bcc ?? [])];
  const decorated = decorateOutgoing(p);
  const raw = await buildRaw(decorated.payload, acc);
  await transport.sendMail({ envelope: { from: acc.email, to: toAll }, raw });
  transport.close();
  if (decorated.trackId) {
    mailDb()
      .prepare(
        "INSERT OR REPLACE INTO tracked (track_id, account, subject, to_json, sent) VALUES (?,?,?,?,?)",
      )
      .run(decorated.trackId, acc.id, p.subject, JSON.stringify(p.to), Date.now());
  }
  try {
    const sent = folderBySpecial(acc.id, "\\Sent");
    // Gmail сам кладёт отправленное в «Sent»; дублировать append не нужно
    if (sent && !isGmail(acc)) {
      const c = await clientFor(acc);
      await c.connect();
      try {
        await c.append(sent, raw, ["\\Seen"]);
      } finally {
        await c.logout().catch(() => undefined);
      }
    }
  } catch (e) {
    logger.warn("mail.append_sent_failed", { error: (e as Error).message });
  }
}

export async function processOutbox(): Promise<void> {
  if (sendingNow) return;
  sendingNow = true;
  try {
    const due = mailDb()
      .prepare("SELECT id, payload FROM outbox WHERE status = 'pending' AND send_at <= ?")
      .all(Date.now()) as { id: string; payload: string }[];
    for (const row of due) {
      const p = JSON.parse(row.payload) as SendPayload;
      try {
        await sendOne(p);
        mailDb().prepare("DELETE FROM outbox WHERE id = ?").run(row.id);
        if (p.draftId) await deleteDraft(p.draftId).catch(() => undefined);
        if (p.remindAfterDays && p.remindAfterDays > 0) {
          pendingReminders.push({
            account: p.account,
            subject: p.subject,
            at: Date.now() + p.remindAfterDays * 86_400_000,
          });
        }
        void syncAccount(p.account).catch(() => undefined);
      } catch (e) {
        mailDb()
          .prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?")
          .run((e as Error).message.slice(0, 300), row.id);
        logger.warn("mail.send_failed", { error: (e as Error).message });
      }
    }
  } finally {
    sendingNow = false;
  }
}

export function retryOutbox(id: string): void {
  mailDb()
    .prepare("UPDATE outbox SET status = 'pending', error = '', send_at = ? WHERE id = ?")
    .run(Date.now(), id);
  void processOutbox().catch(() => undefined);
}

/** Ответ на приглашение календаря (iMIP). */
export function replyInvite(
  id: string,
  partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE",
): { id: string } {
  const m = getMessage(id);
  if (!m?.ics) throw new Error("no_invite");
  const acc = accountRow(m.account);
  const ics = buildReply(m.ics, acc.email, acc.name, partstat);
  const to = m.ics.organizer || m.fromAddr;
  const label = { ACCEPTED: "Accepted", DECLINED: "Declined", TENTATIVE: "Tentative" }[partstat];
  return queueSend({
    account: m.account,
    to: [to],
    subject: `${label}: ${m.ics.summary}`,
    html: `<p>${label}: ${m.ics.summary.replace(/</g, "&lt;")}</p>`,
    ical: { method: "REPLY", content: ics },
    delayMs: 0,
  });
}

/* ----------------------- напоминания и «вернуть письмо» ------------------- */

const pendingReminders: { account: string; subject: string; at: number }[] = [];

function attachPendingReminders(): void {
  if (!pendingReminders.length) return;
  const d = mailDb();
  for (let i = pendingReminders.length - 1; i >= 0; i--) {
    const r = pendingReminders[i];
    const m = d
      .prepare(
        `SELECT m.id FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder
         WHERE m.account = ? AND f.special = '\\Sent' AND m.subject = ? AND m.remind_at = 0
         ORDER BY m.date DESC LIMIT 1`,
      )
      .get(r.account, r.subject) as { id: string } | undefined;
    if (m) {
      setReminder(m.id, r.at);
      pendingReminders.splice(i, 1);
    } else if (r.at < Date.now() - 86_400_000) pendingReminders.splice(i, 1);
  }
}

/** Письма, отправленные нами, на которые не пришло ответа к назначенному сроку. */
export function dueReminders(): MessageRow[] {
  const rows = mailDb()
    .prepare(
      `SELECT m.id,m.account,m.folder,m.uid,m.thread,m.subject,m.from_name,m.from_addr,m.to_json,m.cc_json,m.date,m.seen,m.flagged,m.snippet,m.att_json,m.snooze_until,m.remind_at,m.labels
       FROM messages m WHERE m.remind_at > 0 AND m.remind_at <= ?
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread = m.thread AND r.date > m.date AND r.from_addr != m.from_addr)
       ORDER BY m.remind_at`,
    )
    .all(Date.now()) as Raw[];
  return rows.map(mapRow);
}

function wakeSnoozed(): void {
  const r = mailDb()
    .prepare(
      "UPDATE messages SET snooze_until = 0, seen = 0 WHERE snooze_until > 0 AND snooze_until <= ?",
    )
    .run(Date.now());
  if (r.changes) refreshBadge();
}

/* ------------------------------- фон -------------------------------------- */

let timers: NodeJS.Timeout[] = [];

export function startLoops(): void {
  if (timers.length) return;
  const fast = setInterval(() => {
    try {
      wakeSnoozed();
      attachPendingReminders();
    } catch {
      /* база ещё не готова */
    }
    void processOutbox().catch(() => undefined);
  }, 10_000);
  // IDLE ловит новое почти мгновенно; опрос раз в 5 минут — страховка и обновление флагов
  const slow = setInterval(() => void syncAll(), 300_000);
  const track = setInterval(() => void pollTracking().catch(() => 0), 180_000);
  fast.unref();
  slow.unref();
  track.unref();
  timers = [fast, slow, track];
}

export function stopLoops(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const id of [...idlers.keys()]) stopIdle(id);
}

/** Запускается при старте сервера: фон включается, только если уже есть аккаунты. */
export function init(): void {
  try {
    const list = listAccounts();
    if (list.length) {
      startLoops();
      for (const a of list) startIdle(a.id);
      void syncAll();
      refreshBadge();
    }
  } catch (e) {
    logger.warn("mail.init_failed", { error: (e as Error).message });
  }
}
