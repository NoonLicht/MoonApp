/**
 * Импорт и экспорт: настройки почты (правила, подписи, шаблоны, умные папки…) одним JSON
 * и выгрузка писем папки в mbox. Пароли и токены в файл не попадают.
 */
import { mailDb } from "./mailDb";
import { getSettings, setSettings, DEFAULTS, type MailSettings } from "./mailSettings";
import {
  fetchSource,
  listRules,
  listSignatures,
  listTemplates,
  saveRule,
  saveSignature,
  saveTemplate,
} from "./mailService";

interface Bundle {
  app: "moonapp-mail";
  version: 1;
  settings: Partial<MailSettings>;
  rules: ReturnType<typeof listRules>;
  signatures: ReturnType<typeof listSignatures>;
  templates: ReturnType<typeof listTemplates>;
}

export function exportBundle(): Bundle {
  const s = JSON.parse(JSON.stringify(getSettings())) as MailSettings;
  s.mcp.key = "";
  s.tracking.key = "";
  s.oauth.googleClientSecret = "";
  return {
    app: "moonapp-mail",
    version: 1,
    settings: s,
    rules: listRules(),
    signatures: listSignatures(),
    templates: listTemplates(),
  };
}

export function importBundle(b: Partial<Bundle>): { rules: number; signatures: number; templates: number } {
  if (!b || b.app !== "moonapp-mail") throw new Error("bad_bundle");
  if (b.settings) {
    const s = JSON.parse(JSON.stringify(b.settings)) as Partial<MailSettings>;
    // секреты и привязки к ящикам не переносим
    delete s.pinned;
    delete s.autoReply;
    delete s.smartFolders;
    if (s.mcp) delete (s.mcp as Partial<typeof DEFAULTS.mcp>).key;
    if (s.tracking) delete (s.tracking as Partial<typeof DEFAULTS.tracking>).key;
    if (s.oauth) delete (s.oauth as Partial<typeof DEFAULTS.oauth>).googleClientSecret;
    setSettings(s);
    if (b.settings.smartFolders) setSettings({ smartFolders: b.settings.smartFolders.map((x) => ({ ...x, account: "" })) });
  }
  let rules = 0;
  for (const r of b.rules ?? []) {
    saveRule({ ...r, id: undefined, account: "" });
    rules++;
  }
  let signatures = 0;
  for (const s of b.signatures ?? []) {
    saveSignature({ name: s.name, html: s.html });
    signatures++;
  }
  let templates = 0;
  for (const t of b.templates ?? []) {
    saveTemplate({ name: t.name, subject: t.subject, body: t.body });
    templates++;
  }
  return { rules, signatures, templates };
}

/** mbox из загруженных писем папки (по одному запросу источника на письмо; не более max). */
export async function exportMbox(account: string, folder: string, max = 500): Promise<Buffer> {
  const rows = mailDb()
    .prepare("SELECT id, date, from_addr FROM messages WHERE account = ? AND folder = ? ORDER BY date DESC LIMIT ?")
    .all(account, folder, max) as { id: string; date: number; from_addr: string }[];
  const parts: Buffer[] = [];
  for (const r of rows) {
    const src = await fetchSource(r.id).catch(() => null);
    if (!src) continue;
    const head = `From ${r.from_addr || "MAILER-DAEMON"} ${new Date(r.date).toUTCString()}\r\n`;
    const body = src.toString("latin1").replace(/^(>*From )/gm, ">$1");
    parts.push(Buffer.from(head, "latin1"), Buffer.from(body, "latin1"), Buffer.from("\r\n", "latin1"));
  }
  return Buffer.concat(parts);
}

/** Разбор mbox на отдельные письма (для импорта). */
export function splitMbox(buf: Buffer): Buffer[] {
  const text = buf.toString("latin1");
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^From \S+ .*\d{4}$/.test(line) && cur.length) {
      out.push(cur.join("\r\n"));
      cur = [];
      continue;
    }
    if (/^From \S+ .*\d{4}$/.test(line)) continue;
    cur.push(line.replace(/^>(>*From )/, "$1"));
  }
  if (cur.length) out.push(cur.join("\r\n"));
  return out.filter((s) => s.trim()).map((s) => Buffer.from(s, "latin1"));
}
