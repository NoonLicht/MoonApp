import { useEffect, useState } from "react";
import {
  AlarmClock,
  Archive,
  Calendar,
  ChevronDown,
  Download,
  Forward,
  Languages,
  ListChecks,
  MoreHorizontal,
  Printer,
  ShieldCheck,
  Tag,
  Filter,
  Loader2,
  Mail as MailIcon,
  MailOpen,
  MailX,
  MapPin,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Btn, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  MailContactCard,
  MailFolder,
  MailLabel,
  MailMessageFull,
  MailSettings,
} from "@/api/apiMail";
import { MailBody } from "@/pages/mail/parts/MailBody";
import { MailAvatar } from "@/pages/mail/parts/MailAvatar";
import { canPreview, MailAttachmentPreview } from "@/pages/mail/parts/MailAttachmentPreview";
import {
  addrLabel,
  fmtDate,
  fmtSize,
  laterToday,
  nextWeek,
  tomorrow,
  toLocalInput,
  weekend,
} from "@/pages/mail/parts/mailUtil";

function openExternal(url: string): void {
  if (window.appBridge?.openExternal) void window.appBridge.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

interface Props {
  thread: MailMessageFull[];
  settings: MailSettings | null;
  dark: boolean;
  lang: string;
  inTrash: boolean;
  inSpam: boolean;
  folders: MailFolder[];
  labels: MailLabel[];
  onMovePath: (path: string) => void;
  onLabel: (label: string, add: boolean) => void;
  onRuleFromSender: () => void;
  onReply: (all: boolean, text?: string) => void;
  onForward: () => void;
  onMove: (special: string) => void;
  onDeleteForever: () => void;
  onStar: () => void;
  onUnread: () => void;
  onSnooze: (until: number) => void;
  onToast: (text: string) => void;
}

/** Чтение цепочки: действия, ИИ (сводка, задачи, быстрые ответы), перевод, приглашения, вложения. */
export function MailReader(p: Props) {
  const { t } = useI18n();
  const last = p.thread[p.thread.length - 1];
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [custom, setCustom] = useState(toLocalInput(tomorrow()));
  const [summary, setSummary] = useState<{
    kind: "summary" | "tasks";
    text: string;
    list?: string[];
  } | null>(null);
  const [aiBusy, setAiBusy] = useState("");
  const [quick, setQuick] = useState<string[]>([]);
  const [card, setCard] = useState<MailContactCard | null>(null);

  const id = last?.id;
  useEffect(() => {
    setSummary(null);
    setQuick([]);
    setCard(null);
    setSnoozeMenu(false);
    setMoreMenu(false);
  }, [id]);

  if (!last)
    return (
      <section className="mail-read">
        <EmptyHint icon={MailIcon} text={t("mail.selectMessage")} />
      </section>
    );

  const aiOn = p.settings?.ai.enabled !== false;
  const isSnoozed = last.snoozeUntil > 0;
  const aiLang = p.settings?.ai.language || p.lang;

  const runAi = async (kind: "summarize" | "tasks" | "quick") => {
    setAiBusy(kind);
    try {
      const r = await api.mailAi({ action: kind, id: last.id, lang: aiLang });
      if (kind === "summarize") setSummary({ kind: "summary", text: r.text ?? "" });
      else if (kind === "tasks") setSummary({ kind: "tasks", text: "", list: r.list ?? [] });
      else setQuick(r.list ?? []);
    } catch (e) {
      p.onToast((e as Error).message);
    } finally {
      setAiBusy("");
    }
  };

  const openCard = async (address: string) => {
    if (card?.address === address.toLowerCase()) return setCard(null);
    try {
      setCard(await api.mailContact(address));
    } catch {
      /* карточка необязательна */
    }
  };

  const unsub = last.unsubscribe;
  const doUnsubscribe = async () => {
    try {
      const r = await api.mailUnsubscribe(last.id);
      if (r.method === "link" && r.url) openExternal(r.url);
      else p.onToast(r.done ? t("mail.unsubscribed") : t("mail.unsubscribeFailed"));
    } catch (e) {
      p.onToast((e as Error).message);
    }
  };

  return (
    <section className="mail-read">
      <div className="mail-read-head">
        <h2>{last.subject || t("mail.noSubject")}</h2>
        {last.labels.length > 0 && (
          <div className="mail-item-labels">
            {last.labels.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
        <div className="mail-toolbar">
          <button className="mail-ic" onClick={() => p.onReply(false)} title={t("mail.reply")}>
            <Reply size={16} />
          </button>
          <button className="mail-ic" onClick={() => p.onReply(true)} title={t("mail.replyAll")}>
            <ReplyAll size={16} />
          </button>
          <button className="mail-ic" onClick={p.onForward} title={t("mail.forward")}>
            <Forward size={16} />
          </button>
          <span className="mail-fmt-sep" />
          <button
            className="mail-ic"
            onClick={() => p.onMove("\\Archive")}
            title={t("mail.toArchive")}
          >
            <Archive size={16} />
          </button>
          <button className="mail-ic" onClick={() => p.onMove("\\Junk")} title={t("mail.toSpam")}>
            <ShieldAlert size={16} />
          </button>
          <button
            className="mail-ic"
            onClick={() => (p.inTrash ? p.onDeleteForever() : p.onMove("\\Trash"))}
            title={p.inTrash ? t("mail.deleteForever") : t("mail.toTrash")}
          >
            <Trash2 size={16} />
          </button>
          <span className="mail-fmt-sep" />
          <button
            className={`mail-ic ${last.flagged ? "is-on" : ""}`}
            onClick={p.onStar}
            title={t("mail.star")}
          >
            <Star size={16} />
          </button>
          <button className="mail-ic" onClick={p.onUnread} title={t("mail.markUnread")}>
            <MailOpen size={16} />
          </button>
          <div className="mail-pop-wrap">
            <button
              className={`mail-ic ${isSnoozed ? "is-on" : ""}`}
              onClick={() => (isSnoozed ? p.onSnooze(0) : setSnoozeMenu((v) => !v))}
              title={t("mail.snooze")}
            >
              <AlarmClock size={16} />
            </button>
            {snoozeMenu && (
              <div className="mail-menu">
                <button onClick={() => p.onSnooze(laterToday())}>{t("mail.snoozeLater")}</button>
                <button onClick={() => p.onSnooze(tomorrow())}>{t("mail.snoozeTomorrow")}</button>
                <button onClick={() => p.onSnooze(weekend())}>{t("mail.snoozeWeekend")}</button>
                <button onClick={() => p.onSnooze(nextWeek())}>{t("mail.snoozeNextWeek")}</button>
                <div className="mail-menu-custom">
                  <input
                    type="datetime-local"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <Btn
                    onClick={() => {
                      const ts = new Date(custom).getTime();
                      if (ts > Date.now()) p.onSnooze(ts);
                    }}
                  >
                    OK
                  </Btn>
                </div>
              </div>
            )}
          </div>
          <button
            className="mail-ic"
            onClick={() => void api.mailDownloadEml(last.id)}
            title={t("mail.saveEml")}
          >
            <Download size={16} />
          </button>
          <button className="mail-ic" onClick={() => window.print()} title={t("mail.print")}>
            <Printer size={16} />
          </button>
          <div className="mail-pop-wrap">
            <button
              className={`mail-ic ${moreMenu ? "is-on" : ""}`}
              onClick={() => setMoreMenu((v) => !v)}
              title={t("mail.more")}
            >
              <MoreHorizontal size={16} />
            </button>
            {moreMenu && (
              <div className="mail-menu mail-menu-wide">
                {(p.inSpam || p.inTrash) && (
                  <button
                    onClick={() => {
                      setMoreMenu(false);
                      p.onMove("\\Inbox");
                    }}
                  >
                    <ShieldCheck size={14} /> {p.inSpam ? t("mail.notSpam") : t("mail.restore")}
                  </button>
                )}
                <button
                  onClick={() => {
                    setMoreMenu(false);
                    p.onRuleFromSender();
                  }}
                >
                  <Filter size={14} /> {t("mail.ruleFromSender")}
                </button>
                {p.folders.length > 0 && (
                  <>
                    <div className="mail-menu-title">{t("mail.moveTo")}</div>
                    <div className="mail-menu-scroll">
                      {p.folders.map((f) => (
                        <button
                          key={f.path}
                          onClick={() => {
                            setMoreMenu(false);
                            p.onMovePath(f.path);
                          }}
                        >
                          {f.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {p.labels.length > 0 && (
                  <>
                    <div className="mail-menu-title">{t("mail.labels")}</div>
                    <div className="mail-menu-scroll">
                      {p.labels.map((l) => {
                        const on = last.labels.includes(l.label);
                        return (
                          <button key={l.label} onClick={() => p.onLabel(l.label, !on)}>
                            <Tag size={14} /> {on ? "✓ " : ""}
                            {l.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          {aiOn && (
            <>
              <span className="mail-fmt-sep" />
              <button
                className="mail-ic"
                onClick={() => void runAi("summarize")}
                title={t("mail.aiSummary")}
                disabled={!!aiBusy}
              >
                {aiBusy === "summarize" ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Sparkles size={16} />
                )}
              </button>
              <button
                className="mail-ic"
                onClick={() => void runAi("tasks")}
                title={t("mail.aiTasks")}
                disabled={!!aiBusy}
              >
                {aiBusy === "tasks" ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <ListChecks size={16} />
                )}
              </button>
            </>
          )}
        </div>
        {aiOn && (
          <div className="mail-quick">
            {quick.length === 0 ? (
              <button className="mail-chip" onClick={() => void runAi("quick")} disabled={!!aiBusy}>
                {aiBusy === "quick" ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Sparkles size={12} />
                )}{" "}
                {t("mail.aiQuick")}
              </button>
            ) : (
              quick.map((q) => (
                <button key={q} className="mail-chip" onClick={() => p.onReply(false, q)}>
                  {q}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="mail-read-scroll">
        {summary && (
          <div className="mail-ai-card">
            <div className="mail-ai-card-head">
              <Sparkles size={14} />
              <b>{summary.kind === "summary" ? t("mail.aiSummary") : t("mail.aiTasks")}</b>
              <button className="mail-x" onClick={() => setSummary(null)} aria-label="close">
                <X size={14} />
              </button>
            </div>
            {summary.kind === "summary" ? (
              <p>{summary.text}</p>
            ) : summary.list && summary.list.length ? (
              <ul>
                {summary.list.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : (
              <p>{t("mail.aiNoTasks")}</p>
            )}
          </div>
        )}

        {unsub && (
          <div className="mail-banner">
            <MailX size={15} />
            <span>{t("mail.unsubscribeBanner")}</span>
            <Btn onClick={() => void doUnsubscribe()}>{t("mail.unsubscribe")}</Btn>
          </div>
        )}

        {p.thread.map((m, i) => (
          <MessageCard
            key={m.id}
            m={m}
            open={i === p.thread.length - 1 || p.thread.length === 1}
            settings={p.settings}
            dark={p.dark}
            lang={p.lang}
            card={card && card.address === m.fromAddr ? card : null}
            onCard={() => void openCard(m.fromAddr)}
            onToast={p.onToast}
          />
        ))}
      </div>
    </section>
  );
}

function MessageCard({
  m,
  open: openInit,
  settings,
  dark,
  lang,
  card,
  onCard,
  onToast,
}: {
  m: MailMessageFull;
  open: boolean;
  settings: MailSettings | null;
  dark: boolean;
  lang: string;
  card: MailContactCard | null;
  onCard: () => void;
  onToast: (t: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(openInit);
  const [tr, setTr] = useState<string[] | null>(null);
  const [trBusy, setTrBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [invite, setInvite] = useState("");
  const avatars = settings?.appearance.avatars ?? "initials";
  const files = m.attachments.filter((a) => !a.inline);

  const translate = async () => {
    if (tr) return setTr(null);
    setTrBusy(true);
    try {
      const r = await api.mailAi({
        action: "translate",
        id: m.id,
        lang: lang.slice(0, 2),
      });
      setTr(r.blocks ?? (r.text ? r.text.split(/\n+/) : []));
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setTrBusy(false);
    }
  };

  const rsvp = async (ps: "ACCEPTED" | "DECLINED" | "TENTATIVE") => {
    try {
      await api.mailInvite(m.id, ps);
      setInvite(ps);
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const ics = m.ics;
  return (
    <div className={`mail-msg ${open ? "is-open" : ""}`}>
      <div className="mail-msg-head" onClick={() => setOpen((v) => !v)}>
        <MailAvatar
          address={m.fromAddr}
          name={m.fromName}
          size={34}
          mode={avatars === "off" ? "initials" : avatars}
        />
        <div className="mail-msg-who">
          <b
            onClick={(e) => {
              e.stopPropagation();
              onCard();
            }}
          >
            {m.fromName || m.fromAddr}
          </b>
          {open ? (
            <span>
              {m.fromAddr} → {m.to.map(addrLabel).join(", ")}
              {m.cc.length > 0 && ` · cc: ${m.cc.map(addrLabel).join(", ")}`}
            </span>
          ) : (
            <span>{m.snippet}</span>
          )}
        </div>
        <span className="mail-msg-date">{fmtDate(m.date, lang, true)}</span>
        <ChevronDown size={14} className={open ? "mail-rot" : ""} />
      </div>
      {card && (
        <div className="mail-card">
          <User size={16} />
          <div>
            <b>{card.name || card.address}</b>
            <span>{card.address}</span>
            <span>
              {t("mail.cardStats", { n: card.received, since: fmtDate(card.first, lang, true) })}
            </span>
            {card.recent.length > 0 && (
              <span className="mail-dim">
                {card.recent
                  .map((r) => r.subject)
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(" · ")}
              </span>
            )}
          </div>
        </div>
      )}
      {open && (
        <>
          {ics && (
            <div className="mail-invite">
              <Calendar size={18} />
              <div className="mail-invite-main">
                <b>{ics.summary || t("mail.noSubject")}</b>
                <span>
                  {ics.allDay
                    ? new Date(ics.start).toLocaleDateString(lang, { dateStyle: "full" })
                    : `${fmtDate(ics.start, lang, true)} — ${new Date(ics.end).toLocaleTimeString(lang, { timeStyle: "short" })}`}
                </span>
                {ics.location && (
                  <span>
                    <MapPin size={12} /> {ics.location}
                  </span>
                )}
                {(ics.organizerName || ics.organizer) && (
                  <span className="mail-dim">{ics.organizerName || ics.organizer}</span>
                )}
              </div>
              {ics.method === "REQUEST" && (
                <div className="mail-invite-btns">
                  {invite ? (
                    <em className="mail-dim">{t(`mail.rsvp_${invite}`)}</em>
                  ) : (
                    <>
                      <Btn variant="primary" onClick={() => void rsvp("ACCEPTED")}>
                        {t("mail.rsvp_accept")}
                      </Btn>
                      <Btn onClick={() => void rsvp("TENTATIVE")}>{t("mail.rsvp_maybe")}</Btn>
                      <Btn onClick={() => void rsvp("DECLINED")}>{t("mail.rsvp_decline")}</Btn>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mail-msg-tools">
            <button className="mail-chip" onClick={() => void translate()} disabled={trBusy}>
              {trBusy ? <Loader2 size={12} className="spin" /> : <Languages size={12} />}{" "}
              {tr ? t("mail.showOriginal") : t("mail.translate")}
            </button>
          </div>

          {tr ? (
            <div className="mail-translated">
              {tr.map((b, i) => (
                <p key={i}>{b}</p>
              ))}
            </div>
          ) : (
            <MailBody
              html={m.html}
              text={m.text}
              dark={dark}
              fontSize={settings?.appearance.fontSize ?? 14}
              autoLoad={settings?.appearance.loadImages}
            />
          )}

          {files.length > 0 && (
            <div className="mail-atts">
              {files.map((a) => (
                <button
                  key={a.index}
                  className="mail-att"
                  onClick={() =>
                    canPreview(a)
                      ? setPreview(a.index)
                      : void api.mailDownloadAttachment(m.id, a.index)
                  }
                  title={canPreview(a) ? t("mail.preview") : t("mail.download")}
                >
                  <Paperclip size={12} />
                  {a.filename}
                  <em>{fmtSize(a.size)}</em>
                </button>
              ))}
            </div>
          )}
          {preview !== null && (
            <MailAttachmentPreview
              messageId={m.id}
              att={m.attachments[preview]}
              onClose={() => setPreview(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
