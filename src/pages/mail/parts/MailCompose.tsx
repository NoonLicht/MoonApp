import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  Bold,
  ChevronDown,
  FileText,
  Italic,
  Link2,
  List,
  ListOrdered,
  Paperclip,
  Send,
  Underline,
  X,
} from "lucide-react";
import { Btn, Glass, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { MailAccount, MailTemplate } from "@/api/apiMail";
import { nextWeek, parseAddrs, toLocalInput, tomorrow } from "@/pages/mail/parts/mailUtil";

export interface ComposeInit {
  account?: string;
  to?: string;
  cc?: string;
  subject?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

interface Att {
  name: string;
  type: string;
  size: number;
  data: string;
}

/** Окно написания письма: форматирование, вложения, шаблоны, отложенная отправка. */
export function MailCompose({
  accounts,
  init,
  onClose,
  onQueued,
}: {
  accounts: MailAccount[];
  init: ComposeInit;
  onClose: () => void;
  onQueued: (id: string, sendAt: number, immediate: boolean) => void;
}) {
  const { t } = useI18n();
  const [account, setAccount] = useState(init.account || accounts[0]?.id || "");
  const [to, setTo] = useState(init.to ?? "");
  const [cc, setCc] = useState(init.cc ?? "");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(!!init.cc);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [atts, setAtts] = useState<Att[]>([]);
  const [receipt, setReceipt] = useState(false);
  const [remind, setRemind] = useState(0);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [menu, setMenu] = useState(false);
  const [custom, setCustom] = useState(toLocalInput(tomorrow()));
  const [sugg, setSugg] = useState<{ name: string; address: string }[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);

  const acc = accounts.find((a) => a.id === account);

  const startHtml = useMemo(() => {
    const sig = acc?.signature ? `<br><div class="mail-sig">-- <br>${acc.signature}</div>` : "";
    return `<p><br></p>${sig}${init.html ?? ""}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (editor.current) {
      editor.current.innerHTML = startHtml;
      editor.current.focus();
      const r = document.createRange();
      r.setStart(editor.current, 0);
      r.collapse(true);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    api.mailTemplates().then(setTemplates).catch(() => undefined);
  }, [startHtml]);

  const exec = (cmd: string, v?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, v);
  };

  const addLink = () => {
    const url = window.prompt(t("mail.linkPrompt"), "https://");
    if (url && /^(https?:|mailto:)/i.test(url)) exec("createLink", url);
  };

  const suggest = async (v: string) => {
    const last = v.split(/[,;]/).pop()?.trim() ?? "";
    if (last.length < 2) return setSugg([]);
    try {
      setSugg((await api.mailContacts(last)).slice(0, 5));
    } catch {
      setSugg([]);
    }
  };

  const pickSugg = (address: string) => {
    const parts = to.split(/[,;]/);
    parts.pop();
    setTo([...parts.map((p) => p.trim()).filter(Boolean), address].join(", ") + ", ");
    setSugg([]);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const out: Att[] = [];
    for (const f of Array.from(files)) {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      out.push({ name: f.name, type: f.type, size: f.size, data });
    }
    setAtts((a) => [...a, ...out]);
  };

  const applyTemplate = (id: string) => {
    const tpl = templates.find((x) => x.id === id);
    if (!tpl) return;
    if (tpl.subject && !subject) setSubject(tpl.subject);
    if (editor.current) editor.current.innerHTML = tpl.body + editor.current.innerHTML;
  };

  const saveTemplate = async () => {
    const name = window.prompt(t("mail.templateName"), subject || "");
    if (!name) return;
    const saved = await api.mailSaveTemplate({
      name,
      subject,
      body: editor.current?.innerHTML ?? "",
    });
    setTemplates((l) => [...l.filter((x) => x.id !== saved.id), saved]);
  };

  const send = async (at?: number) => {
    const toList = parseAddrs(to);
    if (!toList.length) return setErr(t("mail.needRecipient"));
    setBusy(true);
    setErr("");
    try {
      const immediate = !at;
      const r = await api.mailSend({
        account,
        to: toList,
        cc: parseAddrs(cc),
        bcc: parseAddrs(bcc),
        subject: subject.trim() || t("mail.noSubject"),
        html: editor.current?.innerHTML ?? "",
        inReplyTo: init.inReplyTo,
        references: init.references,
        readReceipt: receipt,
        remindAfterDays: remind || undefined,
        attachments: atts.map((a) => ({ filename: a.name, contentType: a.type, content: a.data })),
        ...(at ? { sendAt: at } : { delayMs: 8000 }),
      });
      onQueued(r.id, r.sendAt, immediate);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Glass
        className="modal-panel mail-compose"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="mail-modal-head">
          <div className="media-title">{t("mail.newMessage")}</div>
          <button className="mail-x" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        </div>

        {accounts.length > 1 && (
          <div className="mail-row">
            <span>{t("mail.from")}</span>
            <Select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              options={accounts.map((a) => ({ value: a.id, label: `${a.name} <${a.email}>` }))}
            />
          </div>
        )}
        <div className="mail-row mail-row-rel">
          <span>{t("mail.to")}</span>
          <input
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              void suggest(e.target.value);
            }}
            placeholder="name@example.com"
          />
          {!showCc && (
            <button className="mail-link" onClick={() => setShowCc(true)}>
              {t("mail.ccBcc")}
            </button>
          )}
          {sugg.length > 0 && (
            <div className="mail-sugg">
              {sugg.map((s) => (
                <button key={s.address} onClick={() => pickSugg(s.address)}>
                  <b>{s.name || s.address}</b>
                  <span>{s.address}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {showCc && (
          <>
            <div className="mail-row">
              <span>{t("mail.cc")}</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} />
            </div>
            <div className="mail-row">
              <span>{t("mail.bcc")}</span>
              <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </div>
          </>
        )}
        <div className="mail-row">
          <span>{t("mail.subject")}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div className="mail-fmt">
          <button onClick={() => exec("bold")} aria-label="bold">
            <Bold size={14} />
          </button>
          <button onClick={() => exec("italic")} aria-label="italic">
            <Italic size={14} />
          </button>
          <button onClick={() => exec("underline")} aria-label="underline">
            <Underline size={14} />
          </button>
          <button onClick={() => exec("insertUnorderedList")} aria-label="list">
            <List size={14} />
          </button>
          <button onClick={() => exec("insertOrderedList")} aria-label="ordered list">
            <ListOrdered size={14} />
          </button>
          <button onClick={addLink} aria-label="link">
            <Link2 size={14} />
          </button>
          <button onClick={() => fileIn.current?.click()} aria-label={t("mail.attach")}>
            <Paperclip size={14} />
          </button>
          <span className="mail-fmt-sep" />
          {templates.length > 0 && (
            <div className="mail-tpl">
              <FileText size={14} />
              <Select
                value=""
                onChange={(e) => applyTemplate(e.target.value)}
                options={[
                  { value: "", label: t("mail.templates") },
                  ...templates.map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
            </div>
          )}
          <button className="mail-link" onClick={() => void saveTemplate()}>
            {t("mail.saveTemplate")}
          </button>
        </div>
        <input
          ref={fileIn}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="mail-editor" ref={editor} contentEditable suppressContentEditableWarning />

        {atts.length > 0 && (
          <div className="mail-atts">
            {atts.map((a, i) => (
              <span key={i} className="mail-att">
                <Paperclip size={12} />
                {a.name}
                <button onClick={() => setAtts((l) => l.filter((_, j) => j !== i))} aria-label="remove">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mail-opts">
          <label className="mail-check">
            <input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} />
            {t("mail.readReceipt")}
          </label>
          <label className="mail-check">
            <AlarmClock size={13} />
            {t("mail.remindIfNoReply")}
            <Select
              value={String(remind)}
              onChange={(e) => setRemind(Number(e.target.value))}
              options={[
                { value: "0", label: t("mail.never") },
                { value: "1", label: t("mail.days", { n: 1 }) },
                { value: "3", label: t("mail.days", { n: 3 }) },
                { value: "7", label: t("mail.days", { n: 7 }) },
              ]}
            />
          </label>
        </div>

        {err && <div className="mail-err">{err}</div>}

        <div className="mail-actions">
          <div className="mail-send-wrap">
            <Btn variant="primary" icon={Send} disabled={busy} onClick={() => void send()}>
              {t("mail.send")}
            </Btn>
            <button
              className="mail-send-more"
              onClick={() => setMenu((v) => !v)}
              aria-label={t("mail.sendLater")}
            >
              <ChevronDown size={15} />
            </button>
            {menu && (
              <div className="mail-menu mail-menu-up">
                <button
                  onClick={() => {
                    const d = new Date();
                    d.setHours(d.getHours() + 1);
                    void send(d.getTime());
                  }}
                >
                  {t("mail.sendIn1h")}
                </button>
                <button onClick={() => void send(tomorrow(9))}>{t("mail.sendTomorrow")}</button>
                <button onClick={() => void send(nextWeek())}>{t("mail.sendNextWeek")}</button>
                <div className="mail-menu-custom">
                  <input
                    type="datetime-local"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <Btn
                    onClick={() => {
                      const ts = new Date(custom).getTime();
                      if (ts > Date.now()) void send(ts);
                    }}
                  >
                    {t("mail.sendAt")}
                  </Btn>
                </div>
              </div>
            )}
          </div>
          <Btn onClick={onClose}>{t("mail.discard")}</Btn>
        </div>
      </Glass>
    </div>
  );
}
