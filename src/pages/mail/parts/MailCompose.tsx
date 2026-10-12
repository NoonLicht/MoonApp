import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AlarmClock,
  Bold,
  ChevronDown,
  FileText,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Underline,
  X,
} from "lucide-react";
import { Btn, Glass, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { MailAccount, MailSettings, MailSignature, MailTemplate } from "@/api/apiMail";
import { nextWeek, parseAddrs, toLocalInput, tomorrow } from "@/pages/mail/parts/mailUtil";

export interface ComposeInit {
  draftId?: string;
  account?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Первая строка ответа (быстрый ответ ИИ). */
  lead?: string;
  /** Цитата исходного письма / пересланное — добавляется после подписи. */
  quoted?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename: string; contentType?: string; content: string }[];
}

interface Att {
  name: string;
  type: string;
  size: number;
  data: string;
}

function html2text(h: string): string {
  const d = document.createElement("div");
  d.innerHTML = DOMPurify.sanitize(h);
  return (d.innerText || d.textContent || "").trim();
}

/** Окно написания: черновик сохраняется сам, подписи и профили отправителя, Markdown и ИИ-помощник. */
export function MailCompose({
  accounts,
  init,
  settings,
  signatures,
  onClose,
  onQueued,
}: {
  accounts: MailAccount[];
  init: ComposeInit;
  settings: MailSettings;
  signatures: MailSignature[];
  onClose: () => void;
  onQueued: (id: string, sendAt: number, immediate: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const [account, setAccount] = useState(init.account || accounts[0]?.id || "");
  const acc = accounts.find((a) => a.id === account) ?? accounts[0];
  const identities = useMemo(() => {
    if (!acc) return [];
    return [
      { name: acc.name, address: acc.email, signature: acc.defaultSignature },
      ...acc.aliases.map((a) => ({ name: a.name || acc.name, address: a.address, signature: a.signature })),
    ];
  }, [acc]);
  const [fromAddr, setFromAddr] = useState(init.from || acc?.email || "");
  const [to, setTo] = useState(init.to ?? "");
  const [cc, setCc] = useState(init.cc ?? "");
  const [bcc, setBcc] = useState(init.bcc ?? "");
  const [showCc, setShowCc] = useState(!!init.cc || !!init.bcc);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [atts, setAtts] = useState<Att[]>(
    (init.attachments ?? []).map((a) => ({
      name: a.filename,
      type: a.contentType || "",
      size: Math.round((a.content.length * 3) / 4),
      data: a.content,
    })),
  );
  const [receipt, setReceipt] = useState(false);
  const [track, setTrack] = useState(settings.tracking.enabled);
  const [remind, setRemind] = useState(0);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [menu, setMenu] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInstr, setAiInstr] = useState("");
  const [aiSubjects, setAiSubjects] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState(settings.appearance.composeMarkdown);
  const [md, setMd] = useState("");
  const [custom, setCustom] = useState(toLocalInput(tomorrow()));
  const [sugg, setSugg] = useState<{ name: string; address: string }[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sigId, setSigId] = useState("");
  const [saved, setSaved] = useState(0);
  const draftId = useRef(init.draftId || crypto.randomUUID());
  const editor = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const closed = useRef(false);

  const sigHtml = (id: string): string => {
    if (id === "none") return "";
    const s = signatures.find((x) => x.id === id);
    if (s) return s.html;
    return "";
  };

  /** Подпись по умолчанию для адреса: профиль → ящик. */
  const defaultSig = (addr: string): string => {
    const idn = identities.find((i) => i.address === addr);
    return idn?.signature || acc?.defaultSignature || "";
  };

  const buildInitial = (): string => {
    if (init.html !== undefined && init.draftId) return init.html;
    const sig = sigHtml(defaultSig(fromAddr));
    const sigBlock = sig ? `<div class="mail-sig" data-sig="1">-- <br>${sig}</div>` : "";
    const lead = init.lead ? `<p>${init.lead.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p><br></p>` : "<p><br></p>";
    return `${lead}${sigBlock}${init.quoted ?? ""}${init.html ?? ""}`;
  };

  useEffect(() => {
    if (editor.current) {
      editor.current.innerHTML = DOMPurify.sanitize(buildInitial(), { ADD_ATTR: ["data-sig"] });
      editor.current.focus();
      const r = document.createRange();
      r.setStart(editor.current, 0);
      r.collapse(true);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    api.mailTemplates().then(setTemplates).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Текущее тело письма в HTML. */
  const bodyHtml = (): string => {
    if (markdown) {
      const src = md;
      const sig = sigHtml(sigId || defaultSig(fromAddr));
      const out = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
      return out + (sig ? `<div class="mail-sig">-- <br>${sig}</div>` : "") + (init.quoted ?? "");
    }
    return editor.current?.innerHTML ?? "";
  };

  const bodyText = (): string => (markdown ? md : html2text(editor.current?.innerHTML ?? ""));

  const hasContent = (): boolean =>
    !!(to.trim() || subject.trim() || bodyText().replace(/--\s*$/m, "").trim() || atts.length);

  const persist = async (server: boolean) => {
    if (!account) return;
    try {
      const d = await api.mailSaveDraft({
        id: draftId.current,
        account,
        from: fromAddr,
        to,
        cc,
        bcc,
        subject,
        html: bodyHtml(),
        inReplyTo: init.inReplyTo,
        references: init.references,
        attachments: atts.map((a) => ({ filename: a.name, contentType: a.type, content: a.data })),
        server,
      });
      setSaved(d.updated);
    } catch {
      /* автосохранение не должно мешать писать */
    }
  };

  // автосохранение: через 2.5 с после последней правки
  const timer = useRef<number | null>(null);
  const touch = () => {
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(false), 2500);
  };

  useEffect(() => {
    touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, atts, fromAddr, account, md]);

  const close = async (discard = false) => {
    if (closed.current) return;
    closed.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    if (discard) {
      await api.mailDeleteDraft(draftId.current).catch(() => undefined);
    } else if (dirty.current && hasContent()) {
      await persist(true);
    }
    onClose();
  };

  const exec = (cmd: string, v?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, v);
    touch();
  };

  const addLink = () => {
    const url = window.prompt(t("mail.linkPrompt"), "https://");
    if (url && /^(https?:|mailto:)/i.test(url)) exec("createLink", url);
  };

  const changeSignature = (id: string) => {
    setSigId(id);
    if (markdown || !editor.current) return;
    const html = sigHtml(id);
    const el = editor.current.querySelector<HTMLElement>(".mail-sig");
    if (!html) el?.remove();
    else if (el) el.innerHTML = `-- <br>${html}`;
    else {
      const div = document.createElement("div");
      div.className = "mail-sig";
      div.dataset.sig = "1";
      div.innerHTML = `-- <br>${html}`;
      const q = editor.current.querySelector(".mail-quote");
      if (q) editor.current.insertBefore(div, q);
      else editor.current.appendChild(div);
    }
    touch();
  };

  const changeFrom = (addr: string) => {
    setFromAddr(addr);
    if (!sigId) {
      // подпись следует профилю, пока пользователь не выбрал свою
      const idn = identities.find((i) => i.address === addr);
      const sid = idn?.signature || acc?.defaultSignature || "";
      if (!markdown && sid) changeSignature(sid);
    }
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
    if (markdown) setMd((m) => tpl.body + "\n\n" + m);
    else if (editor.current) {
      editor.current.innerHTML = DOMPurify.sanitize(tpl.body) + editor.current.innerHTML;
      touch();
    }
  };

  const saveTemplate = async () => {
    const name = window.prompt(t("mail.templateName"), subject || "");
    if (!name) return;
    const saved2 = await api.mailSaveTemplate({ name, subject, body: bodyHtml() });
    setTemplates((l) => [...l.filter((x) => x.id !== saved2.id), saved2]);
  };

  /** Вставляет текст ИИ в начало письма, не трогая подпись и цитату. */
  const putAi = (html: string, text: string) => {
    if (markdown) {
      setMd(text);
      return;
    }
    const ed = editor.current;
    if (!ed) return;
    const stop = ed.querySelector(".mail-sig, .mail-quote");
    const tail: string[] = [];
    if (stop) {
      let n: ChildNode | null = stop;
      while (n) {
        tail.push(n.nodeType === 1 ? (n as HTMLElement).outerHTML : (n.textContent ?? ""));
        n = n.nextSibling;
      }
    }
    ed.innerHTML = DOMPurify.sanitize(html + tail.join(""), { ADD_ATTR: ["data-sig"] });
    touch();
  };

  const aiRun = async (action: "compose" | "improve" | "subject" | "reply", mode?: string) => {
    setAiBusy(true);
    setErr("");
    try {
      const cur = bodyText().split(/\n--\s*\n/)[0];
      const r = await api.mailAi({
        action,
        text: cur,
        instruction: aiInstr || undefined,
        mode,
        tone: settings.ai.tone,
        lang: settings.ai.language || lang,
        id: action === "reply" ? init.inReplyTo : undefined,
      });
      if (action === "subject") setAiSubjects(r.list ?? []);
      else if (r.html) putAi(r.html, r.text ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAiBusy(false);
    }
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
        from: fromAddr && acc && fromAddr !== acc.email ? `"${(identities.find((i) => i.address === fromAddr)?.name || acc.name).replace(/"/g, "")}" <${fromAddr}>` : undefined,
        to: toList,
        cc: parseAddrs(cc),
        bcc: parseAddrs(bcc),
        subject: subject.trim() || t("mail.noSubject"),
        html: bodyHtml(),
        text: bodyText(),
        inReplyTo: init.inReplyTo,
        references: init.references,
        readReceipt: receipt,
        remindAfterDays: remind || undefined,
        track: track || undefined,
        draftId: draftId.current,
        attachments: atts.map((a) => ({ filename: a.name, contentType: a.type, content: a.data })),
        ...(at ? { sendAt: at } : { delayMs: settings.appearance.sendDelaySec * 1000 }),
      });
      closed.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      onQueued(r.id, r.sendAt, immediate);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleMarkdown = () => {
    if (!markdown) {
      // из визуального режима берём простой текст как исходник Markdown
      const sigEl = editor.current?.querySelector(".mail-sig, .mail-quote");
      const clone = editor.current?.cloneNode(true) as HTMLElement | undefined;
      if (clone && sigEl) clone.querySelectorAll(".mail-sig, .mail-quote").forEach((n) => n.remove());
      setMd((clone?.innerText ?? "").trim());
    }
    setMarkdown((v) => !v);
  };

  return (
    <div className="modal-overlay" onClick={() => void close()}>
      <Glass className="modal-panel mail-compose" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="mail-modal-head">
          <div className="media-title">{t("mail.newMessage")}</div>
          <div className="mail-row-gap">
            {saved > 0 && <span className="mail-dim">{t("mail.draftSaved")}</span>}
            <button className="mail-x" onClick={() => void close()} aria-label="close">
              <X size={16} />
            </button>
          </div>
        </div>

        {(accounts.length > 1 || identities.length > 1) && (
          <div className="mail-row">
            <span>{t("mail.from")}</span>
            <Select
              value={`${account}|${fromAddr}`}
              onChange={(e) => {
                const [a, ...rest] = e.target.value.split("|");
                const addr = rest.join("|");
                setAccount(a);
                changeFrom(addr);
              }}
              options={accounts.flatMap((a) => [
                { value: `${a.id}|${a.email}`, label: `${a.name} <${a.email}>` },
                ...a.aliases.map((al) => ({
                  value: `${a.id}|${al.address}`,
                  label: `${al.name || a.name} <${al.address}>`,
                })),
              ])}
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
        {aiSubjects.length > 0 && (
          <div className="mail-ai-subjects">
            {aiSubjects.map((s) => (
              <button
                key={s}
                className="mail-chip"
                onClick={() => {
                  setSubject(s);
                  setAiSubjects([]);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="mail-fmt">
          {!markdown && (
            <>
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
            </>
          )}
          <button onClick={() => fileIn.current?.click()} aria-label={t("mail.attach")}>
            <Paperclip size={14} />
          </button>
          <button className={`mail-md-btn ${markdown ? "is-on" : ""}`} onClick={toggleMarkdown}>
            Markdown
          </button>
          <button
            className={`mail-md-btn ${aiOpen ? "is-on" : ""}`}
            onClick={() => setAiOpen((v) => !v)}
          >
            <Sparkles size={13} /> {t("mail.aiAssistant")}
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
          {signatures.length > 0 && (
            <div className="mail-tpl">
              <Select
                value={sigId}
                onChange={(e) => changeSignature(e.target.value)}
                options={[
                  { value: "", label: t("mail.signature") },
                  { value: "none", label: t("mail.noSignature") },
                  ...signatures.map((x) => ({ value: x.id, label: x.name })),
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

        {aiOpen && (
          <div className="mail-ai-panel">
            <input
              value={aiInstr}
              onChange={(e) => setAiInstr(e.target.value)}
              placeholder={t("mail.aiInstruction")}
            />
            <div className="mail-ai-btns">
              <Btn icon={aiBusy ? Loader2 : Sparkles} disabled={aiBusy} onClick={() => void aiRun("compose")}>
                {t("mail.aiWrite")}
              </Btn>
              {init.inReplyTo && (
                <Btn disabled={aiBusy} onClick={() => void aiRun("reply")}>
                  {t("mail.aiReply")}
                </Btn>
              )}
              {(["fix", "shorten", "formal", "friendly"] as const).map((m) => (
                <Btn key={m} disabled={aiBusy} onClick={() => void aiRun("improve", m)}>
                  {t(`mail.ai_${m}`)}
                </Btn>
              ))}
              <Btn disabled={aiBusy} onClick={() => void aiRun("subject")}>
                {t("mail.aiSubject")}
              </Btn>
            </div>
          </div>
        )}

        {markdown ? (
          <div className="mail-md">
            <textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              placeholder={t("mail.markdownHint")}
            />
            <div
              className="mail-md-preview"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(marked.parse(md || "", { async: false }) as string),
              }}
            />
          </div>
        ) : (
          <div
            className="mail-editor"
            ref={editor}
            contentEditable
            suppressContentEditableWarning
            onInput={touch}
          />
        )}

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
          {settings.tracking.enabled && (
            <label className="mail-check">
              <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
              {t("mail.trackOpens")}
            </label>
          )}
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
          <Btn onClick={() => void close(true)}>{t("mail.discard")}</Btn>
        </div>
      </Glass>
    </div>
  );
}
