/**
 * Почтовый клиент: учётные записи IMAP/SMTP, синхронизация, действия над письмами,
 * отправка (с отменой и отложенной отправкой), «отложить» и напоминания.
 *
 * «Платные» функции почтовых клиентов реализованы локально, без сервера:
 *  - отложенная отправка и отмена отправки — очередь outbox, обрабатывается таймером;
 *  - отложить письмо (snooze) — поле snooze_until, письмо возвращается во входящие;
 *  - напоминание «нет ответа» — поле remind_at, проверка по цепочке;
 *  - шаблоны, подписи, единый ящик, поиск с операторами, цепочки;
 *  - запрос уведомления о прочтении — заголовок Disposition-Notification-To.
 * Отслеживание открытий и ссылок требует внешнего сервера и не делается; вместо
 * этого блокируются удалённые картинки (трекер-пиксели) на стороне интерфейса.
 */
import crypto from "crypto";
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

/* ------------------------------- типы ------------------------------------- */

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
  count?: number;
  unreadCount?: number;
}

export interface SendPayload {
  account: string;
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
} {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const p = PRESETS[domain];
  if (p) {
    return {
      imapHost: p.imap[0],
      imapPort: p.imap[1],
      imapSecure: p.imap[1] === 993,
      smtpHost: p.smtp[0],
      smtpPort: p.smtp[1],
      smtpSecure: p.smtp[1] === 465,
    };
  }
  return {
    imapHost: domain ? `imap.${domain}` : "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: domain ? `smtp.${domain}` : "",
    smtpPort: 465,
    smtpSecure: true,
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
}

function accountRow(id: string): AccountRow {
  const r = mailDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!r) throw new Error("account_not_found");
  return r;
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
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: !!r.imap_secure,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: !!r.smtp_secure,
    signature: r.signature,
    lastSync: r.last_sync,
    error: r.error,
    unread,
  };
}

export function listAccounts(): AccountView[] {
  const rows = mailDb().prepare("SELECT * FROM accounts ORDER BY created").all() as AccountRow[];
  return rows.map(toView);
}

function clientFor(r: AccountRow): ImapFlow {
  return new ImapFlow({
    host: r.imap_host,
    port: r.imap_port,
    secure: !!r.imap_secure,
    auth: { user: r.username, pass: decryptSecret(r.pass_enc) },
    logger: false,
    socketTimeout: 60_000,
  });
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
  };
  // проверка входа до сохранения — чтобы не плодить нерабочие записи
  const c = clientFor(row);
  try {
    await c.connect();
  } catch (e) {
    throw new Error("imap_login_failed: " + (e as Error).message);
  } finally {
    try {
      await c.logout();
    } catch {
      /* соединения нет */
    }
  }
  mailDb()
    .prepare(
      `INSERT INTO accounts (id,name,email,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username,pass_enc,signature,created,last_sync,error)
       VALUES (@id,@name,@email,@imap_host,@imap_port,@imap_secure,@smtp_host,@smtp_port,@smtp_secure,@username,@pass_enc,@signature,@created,@last_sync,@error)`,
    )
    .run(row);
  startLoops();
  void syncAccount(row.id).catch(() => undefined);
  return toView(row);
}

export function updateAccount(id: string, patch: { name?: string; signature?: string }): AccountView {
  const r = accountRow(id);
  mailDb()
    .prepare("UPDATE accounts SET name = ?, signature = ? WHERE id = ?")
    .run(patch.name ?? r.name, patch.signature ?? r.signature, id);
  return toView(accountRow(id));
}

export function removeAccount(id: string): void {
  const d = mailDb();
  d.transaction(() => {
    d.prepare("DELETE FROM messages WHERE account = ?").run(id);
    d.prepare("DELETE FROM folders WHERE account = ?").run(id);
    d.prepare("DELETE FROM outbox WHERE account = ?").run(id);
    d.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
}

/* ------------------------------ синхронизация ----------------------------- */

const syncing = new Set<string>();
const INITIAL_COUNT = 200;
const OTHER_FOLDER_COUNT = 60;

function addrList(a: AddressObject | AddressObject[] | undefined): Addr[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: Addr[] = [];
  for (const o of arr) for (const v of o.value) out.push({ name: v.name || "", address: v.address || "" });
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

function threadFor(account: string, msgid: string, inReplyTo: string, refs: string[], subject: string): string {
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
  const base = subject.replace(/^((re|fwd?|ответ|пересл)\s*:\s*)+/i, "").trim().toLowerCase();
  if (base && base !== subject.toLowerCase()) {
    const r = d
      .prepare("SELECT thread FROM messages WHERE account = ? AND lower(subject) = ? LIMIT 1")
      .get(account, base) as { thread: string } | undefined;
    if (r?.thread) return r.thread;
  }
  return `${account}:${msgid || crypto.randomUUID()}`;
}

async function storeParsed(
  account: string,
  folder: string,
  uid: number,
  flags: Set<string> | undefined,
  source: Buffer,
): Promise<void> {
  const p: ParsedMail = await simpleParser(source);
  const html0 = typeof p.html === "string" ? p.html : "";
  let html = html0;
  const atts: AttachmentMeta[] = [];
  (p.attachments || []).forEach((a, i) => {
    const inline = !!a.cid && a.contentDisposition !== "attachment";
    if (inline && a.cid && html && a.content && a.size < 1_500_000 && a.contentType.startsWith("image/")) {
      html = html.split(`cid:${a.cid}`).join(bufToDataUri(a.content, a.contentType));
    }
    atts.push({
      index: i,
      filename: a.filename || `attachment-${i + 1}`,
      contentType: a.contentType,
      size: a.size,
      inline,
    });
  });
  const text = p.text || "";
  const from = p.from?.value?.[0];
  const msgid = normMsgId(p.messageId);
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const subject = p.subject || "";
  const id = `${account}|${folder}|${uid}`;
  const prev = mailDb().prepare("SELECT thread, snooze_until, remind_at FROM messages WHERE id = ?").get(id) as
    | { thread: string; snooze_until: number; remind_at: number }
    | undefined;
  const thread = prev?.thread || threadFor(account, msgid, normMsgId(p.inReplyTo), refs, subject);
  mailDb()
    .prepare(
      `INSERT OR REPLACE INTO messages
       (id,account,folder,uid,msgid,in_reply_to,refs,thread,subject,from_name,from_addr,to_json,cc_json,date,seen,flagged,snippet,html,text,att_json,snooze_until,remind_at,labels)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'')`,
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
      JSON.stringify(addrList(p.to)),
      JSON.stringify(addrList(p.cc)),
      (p.date || new Date()).getTime(),
      flags?.has("\\Seen") ? 1 : 0,
      flags?.has("\\Flagged") ? 1 : 0,
      snippetOf(text || html0.replace(/<[^>]+>/g, " ")),
      html,
      text,
      JSON.stringify(atts),
      prev?.snooze_until ?? 0,
      prev?.remind_at ?? 0,
    );
}

function specialOf(path: string, specialUse: string | undefined): string {
  if (path.toUpperCase() === "INBOX") return "\\Inbox";
  return specialUse || "";
}

export async function syncAccount(id: string): Promise<{ added: number }> {
  if (syncing.has(id)) return { added: 0 };
  syncing.add(id);
  const d = mailDb();
  let added = 0;
  const r = accountRow(id);
  const c = clientFor(r);
  try {
    await c.connect();
    const boxes = await c.list();
    const upFolder = d.prepare(
      `INSERT INTO folders (account,path,name,special) VALUES (?,?,?,?)
       ON CONFLICT(account,path) DO UPDATE SET name = excluded.name, special = excluded.special`,
    );
    const keep: string[] = [];
    for (const b of boxes) {
      if (b.flags?.has("\\Noselect") || b.flags?.has("\\NonExistent")) continue;
      const sp = specialOf(b.path, b.specialUse);
      upFolder.run(id, b.path, b.name || b.path, sp);
      // «Вся почта» (Gmail) — только цель архивации: письма уже лежат в других папках
      if (sp !== "\\All") keep.push(b.path);
    }
    for (const path of keep) {
      const f = d.prepare("SELECT special FROM folders WHERE account = ? AND path = ?").get(id, path) as {
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
          // удалённые на сервере письма убираем из кэша
          const del = d.prepare("DELETE FROM messages WHERE account = ? AND folder = ? AND uid = ?");
          for (const u of haveSet) if (!alive.has(u)) del.run(id, path, u);
          // новые письма (для первой загрузки — только последние limit)
          const fresh = serverUids.filter((u) => !haveSet.has(u));
          const picked = maxUid ? fresh : fresh.slice(-limit);
          toFetch.push(...picked);
          // флаги уже известных писем
          if (haveSet.size) {
            const minUid = Math.min(...haveSet);
            const up = d.prepare(
              "UPDATE messages SET seen = ?, flagged = ? WHERE account = ? AND folder = ? AND uid = ?",
            );
            for await (const m of c.fetch(`${minUid}:*`, { uid: true, flags: true }, { uid: true })) {
              if (haveSet.has(m.uid)) {
                up.run(m.flags?.has("\\Seen") ? 1 : 0, m.flags?.has("\\Flagged") ? 1 : 0, id, path, m.uid);
              }
            }
          }
        } else {
          d.prepare("DELETE FROM messages WHERE account = ? AND folder = ?").run(id, path);
        }
        // загрузка пачками, чтобы не держать огромный диапазон
        for (let i = 0; i < toFetch.length; i += 50) {
          const chunk = toFetch.slice(i, i + 50);
          for await (const m of c.fetch(chunk.join(","), { uid: true, flags: true, source: true }, { uid: true })) {
            if (!m.source) continue;
            try {
              await storeParsed(id, path, m.uid, m.flags, m.source);
              added++;
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
    d.prepare("UPDATE accounts SET error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), id);
    throw e;
  } finally {
    syncing.delete(id);
    try {
      await c.logout();
    } catch {
      /* соединение уже закрыто */
    }
  }
  return { added };
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

/* ------------------------------ чтение ------------------------------------ */

export interface ListQuery {
  account?: string;
  /** inbox | sent | drafts | trash | spam | archive | starred | snoozed | all */
  box?: string;
  folder?: string;
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
    to: safeJson(r.to_json),
    cc: safeJson(r.cc_json),
    date: r.date,
    seen: !!r.seen,
    flagged: !!r.flagged,
    snippet: r.snippet,
    hasAttachments: hasAtt,
    snoozeUntil: r.snooze_until,
    remindAt: r.remind_at,
    count: r.cnt,
    unreadCount: r.unread_cnt,
  };
}

function safeJson<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Разбор строки поиска: from:, to:, subject:, has:attachment, is:unread, is:starred + свободный текст. */
export function parseSearch(q: string): { where: string[]; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const free: string[] = [];
  const tokens = q.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) ?? [];
  for (const raw of tokens) {
    const m = /^(from|to|subject|has|is):(.*)$/i.exec(raw);
    if (!m) {
      free.push(raw.replace(/^"|"$/g, ""));
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^"|"$/g, "").toLowerCase();
    if (key === "from") {
      where.push("(lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ?)");
      args.push(`%${val}%`, `%${val}%`);
    } else if (key === "to") {
      where.push("lower(m.to_json) LIKE ?");
      args.push(`%${val}%`);
    } else if (key === "subject") {
      where.push("lower(m.subject) LIKE ?");
      args.push(`%${val}%`);
    } else if (key === "has" && val.startsWith("attach")) {
      where.push("m.att_json LIKE '%\"inline\":false%'");
    } else if (key === "is" && val === "unread") where.push("m.seen = 0");
    else if (key === "is" && val === "starred") where.push("m.flagged = 1");
    else free.push(raw);
  }
  for (const f of free) {
    where.push("(lower(m.subject) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ? OR lower(m.text) LIKE ?)");
    const like = `%${f.toLowerCase()}%`;
    args.push(like, like, like, like);
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
  } else if (q.box === "starred") {
    where.push("m.flagged = 1");
    where.push("f.special NOT IN ('\\Trash','\\Junk')");
  } else if (q.box === "snoozed") {
    where.push("m.snooze_until > ?");
    args.push(now);
  } else if (q.box && SPECIAL[q.box]) {
    where.push("f.special = ?");
    args.push(SPECIAL[q.box]);
  }
  // отложенные письма скрыты из обычных папок до наступления срока
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
    "m.id,m.account,m.folder,m.uid,m.thread,m.subject,m.from_name,m.from_addr,m.to_json,m.cc_json,m.date,m.seen,m.flagged,m.snippet,m.att_json,m.snooze_until,m.remind_at";
  const cond = where.length ? "WHERE " + where.join(" AND ") : "";
  const from = "FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder";
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
      .prepare(`SELECT ${cols} ${from} ${cond} ORDER BY m.date DESC LIMIT ? OFFSET ?`)
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
}

export function getMessage(id: string): MessageFull | null {
  const r = mailDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | (Raw & { html: string; text: string; msgid: string; refs: string; in_reply_to: string })
    | undefined;
  if (!r) return null;
  return {
    ...mapRow(r),
    html: r.html,
    text: r.text,
    attachments: safeJson<AttachmentMeta>(r.att_json),
    messageId: r.msgid,
    references: [r.refs, r.msgid].filter(Boolean).join(" "),
  };
}

/** Все письма цепочки по возрастанию даты. */
export function getThread(id: string): MessageFull[] {
  const m = mailDb().prepare("SELECT thread FROM messages WHERE id = ?").get(id) as
    | { thread: string }
    | undefined;
  if (!m) return [];
  const ids = mailDb()
    .prepare("SELECT id FROM messages WHERE thread = ? ORDER BY date ASC")
    .all(m.thread) as { id: string }[];
  return ids.map((x) => getMessage(x.id)).filter((x): x is MessageFull => !!x);
}

export function listFolders(account: string): { path: string; name: string; special: string; unread: number; total: number }[] {
  return mailDb()
    .prepare(
      `SELECT f.path, f.name, f.special,
         (SELECT COUNT(*) FROM messages m WHERE m.account = f.account AND m.folder = f.path AND m.seen = 0) AS unread,
         (SELECT COUNT(*) FROM messages m WHERE m.account = f.account AND m.folder = f.path) AS total
       FROM folders f WHERE f.account = ? ORDER BY (f.special = '') , f.special, f.name`,
    )
    .all(account) as { path: string; name: string; special: string; unread: number; total: number }[];
}

export function boxCounts(): Record<string, number> {
  const d = mailDb();
  const now = Date.now();
  const n = (sql: string, ...a: (string | number)[]) => (d.prepare(sql).get(...a) as { n: number }).n;
  const base =
    "SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder";
  return {
    inbox: n(`${base} WHERE f.special = '\\Inbox' AND m.seen = 0 AND m.snooze_until <= ?`, now),
    drafts: n(`${base} WHERE f.special = '\\Drafts'`),
    starred: n(`${base} WHERE m.flagged = 1 AND f.special NOT IN ('\\Trash','\\Junk')`),
    snoozed: n(`${base} WHERE m.snooze_until > ?`, now),
    outbox: n("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
  };
}

/** Контакты из переписки: частота и последний контакт. */
export function contacts(query: string): { name: string; address: string; count: number; last: number }[] {
  const like = `%${query.toLowerCase()}%`;
  const rows = mailDb()
    .prepare(
      `SELECT from_addr AS address, MAX(from_name) AS name, COUNT(*) AS count, MAX(date) AS last
       FROM messages WHERE from_addr != '' AND (lower(from_addr) LIKE ? OR lower(from_name) LIKE ?)
       GROUP BY from_addr ORDER BY count DESC LIMIT 12`,
    )
    .all(like, like) as { address: string; name: string; count: number; last: number }[];
  return rows;
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
    .prepare("SELECT id, subject, date FROM messages WHERE from_addr = ? ORDER BY date DESC LIMIT 5")
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
    | MsgLoc
    | undefined;
  if (!r) throw new Error("message_not_found");
  return r;
}

async function withMailbox<T>(account: string, folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = clientFor(accountRow(account));
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
  ids: string[],
  patch: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  const d = mailDb();
  const groups = new Map<string, MsgLoc[]>();
  for (const id of ids) {
    const l = loc(id);
    if (patch.seen !== undefined) d.prepare("UPDATE messages SET seen = ? WHERE id = ?").run(patch.seen ? 1 : 0, id);
    if (patch.flagged !== undefined)
      d.prepare("UPDATE messages SET flagged = ? WHERE id = ?").run(patch.flagged ? 1 : 0, id);
    const k = `${l.account}|${l.folder}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const [k, locs] of groups) {
    const [account, folder] = k.split("|");
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
export async function moveMessages(ids: string[], dest: { path?: string; special?: string }): Promise<void> {
  const d = mailDb();
  const groups = new Map<string, MsgLoc[]>();
  for (const id of ids) {
    const l = loc(id);
    const k = `${l.account}|${l.folder}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const [k, locs] of groups) {
    const [account, folder] = k.split("|");
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
    // новое положение подхватит следующая синхронизация
    void syncAccount(account).catch(() => undefined);
  }
}

export async function deleteForever(ids: string[]): Promise<void> {
  const d = mailDb();
  for (const id of ids) {
    const l = loc(id);
    try {
      await withMailbox(l.account, l.folder, async (c) => {
        await c.messageDelete(String(l.uid), { uid: true });
      });
    } catch (e) {
      logger.warn("mail.delete_failed", { error: (e as Error).message });
    }
    d.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }
}

export function snooze(ids: string[], until: number): void {
  const st = mailDb().prepare("UPDATE messages SET snooze_until = ? WHERE id = ?");
  for (const id of ids) st.run(until > Date.now() ? until : 0, id);
}

export function setReminder(id: string, at: number): void {
  mailDb().prepare("UPDATE messages SET remind_at = ? WHERE id = ?").run(at > 0 ? at : 0, id);
}

export async function fetchAttachment(
  id: string,
  index: number,
): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  const l = loc(id);
  const src = await withMailbox(l.account, l.folder, async (c) => {
    const m = await c.fetchOne(String(l.uid), { source: true }, { uid: true });
    return m && m.source ? m.source : null;
  });
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
  const sendAt = p.sendAt && p.sendAt > Date.now() ? p.sendAt : Date.now() + Math.max(0, p.delayMs ?? 0);
  mailDb()
    .prepare("INSERT INTO outbox (id,account,payload,send_at,status,error,created) VALUES (?,?,?,?, 'pending','',?)")
    .run(id, p.account, JSON.stringify(p), sendAt, Date.now());
  // с нулевой задержкой уходит сразу, без ожидания таймера
  if (sendAt <= Date.now() + 50) void processOutbox().catch(() => undefined);
  return { id, sendAt };
}

export function cancelSend(id: string): boolean {
  const r = mailDb().prepare("DELETE FROM outbox WHERE id = ? AND status = 'pending'").run(id);
  return r.changes > 0;
}

export function listOutbox(): OutboxItem[] {
  const rows = mailDb()
    .prepare("SELECT id, account, payload, send_at, status, error FROM outbox ORDER BY send_at")
    .all() as { id: string; account: string; payload: string; send_at: number; status: string; error: string }[];
  return rows.map((r) => {
    let p: Partial<SendPayload> = {};
    try {
      p = JSON.parse(r.payload) as SendPayload;
    } catch {
      /* пустая полезная нагрузка */
    }
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
  const transport = nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: !!acc.smtp_secure,
    auth: { user: acc.username, pass: decryptSecret(acc.pass_enc) },
  });
  const from = acc.name && acc.name !== acc.email ? `"${acc.name.replace(/"/g, "")}" <${acc.email}>` : acc.email;
  const headers: Record<string, string> = {};
  if (p.readReceipt) headers["Disposition-Notification-To"] = acc.email;
  const mail = {
    from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    html: p.html,
    text: p.text ?? p.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
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
  const raw: Buffer = await new Promise((resolve, reject) =>
    new MailComposer(mail).compile().build((err, msg) => (err ? reject(err) : resolve(msg))),
  );
  await transport.sendMail({
    envelope: {
      from: acc.email,
      to: [...p.to, ...(p.cc ?? []), ...(p.bcc ?? [])],
    },
    raw,
  });
  transport.close();
  // копия в «Отправленных»
  try {
    const sent = folderBySpecial(acc.id, "\\Sent");
    if (sent) {
      const c = clientFor(acc);
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
        if (p.remindAfterDays && p.remindAfterDays > 0) {
          // напоминание привязываем к письму после синхронизации «Отправленных»
          pendingReminders.push({ account: p.account, subject: p.subject, at: Date.now() + p.remindAfterDays * 86_400_000 });
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
  mailDb().prepare("UPDATE outbox SET status = 'pending', error = '', send_at = ? WHERE id = ?").run(Date.now(), id);
  void processOutbox().catch(() => undefined);
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
      `SELECT m.id,m.account,m.folder,m.uid,m.thread,m.subject,m.from_name,m.from_addr,m.to_json,m.cc_json,m.date,m.seen,m.flagged,m.snippet,m.att_json,m.snooze_until,m.remind_at
       FROM messages m WHERE m.remind_at > 0 AND m.remind_at <= ?
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread = m.thread AND r.date > m.date AND r.from_addr != m.from_addr)
       ORDER BY m.remind_at`,
    )
    .all(Date.now()) as Raw[];
  return rows.map(mapRow);
}

function wakeSnoozed(): void {
  mailDb()
    .prepare("UPDATE messages SET snooze_until = 0, seen = 0 WHERE snooze_until > 0 AND snooze_until <= ?")
    .run(Date.now());
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
  const slow = setInterval(() => void syncAll(), 120_000);
  fast.unref();
  slow.unref();
  timers = [fast, slow];
}

export function stopLoops(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

/** Запускается при старте сервера: фон включается, только если уже есть аккаунты. */
export function init(): void {
  try {
    if (listAccounts().length) startLoops();
  } catch (e) {
    logger.warn("mail.init_failed", { error: (e as Error).message });
  }
}
