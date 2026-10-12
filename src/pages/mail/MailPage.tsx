import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  Archive,
  BellRing,
  ChevronDown,
  Clock,
  FileText,
  Folder,
  Forward,
  Inbox,
  Loader2,
  Mail as MailIcon,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Btn, EmptyHint, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { usePageActive } from "@/components/Toolbar";
import type {
  MailAccount,
  MailContactCard,
  MailFolder,
  MailMessage,
  MailMessageFull,
  MailOutboxItem,
} from "@/api/apiMail";
import { MailAccountForm } from "@/pages/mail/parts/MailAccountForm";
import { MailCompose, type ComposeInit } from "@/pages/mail/parts/MailCompose";
import { MailBody } from "@/pages/mail/parts/MailBody";
import {
  addrLabel,
  addrShort,
  escapeHtml,
  fmtDate,
  fmtSize,
  initials,
  laterToday,
  nextWeek,
  prefixSubject,
  prepareHtml,
  tomorrow,
  toLocalInput,
  weekend,
} from "@/pages/mail/parts/mailUtil";

const BOXES: { id: string; icon: React.ElementType; key: string }[] = [
  { id: "inbox", icon: Inbox, key: "mail.inbox" },
  { id: "starred", icon: Star, key: "mail.starred" },
  { id: "snoozed", icon: Clock, key: "mail.snoozed" },
  { id: "sent", icon: Send, key: "mail.sentBox" },
  { id: "drafts", icon: FileText, key: "mail.drafts" },
  { id: "archive", icon: Archive, key: "mail.archive" },
  { id: "spam", icon: ShieldAlert, key: "mail.spam" },
  { id: "trash", icon: Trash2, key: "mail.trash" },
];

const SPECIAL_TO_BOX: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Archive": "archive",
};

/** Служебная папка «Вся почта» (Gmail): в списке папок не показывается. */
const SPECIAL_ALL = "\\All";

interface Toast {
  text: string;
  undoId?: string;
}

export default function MailPage() {
  const { t, lang } = useI18n();
  const active = usePageActive();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [account, setAccount] = useState("all");
  const [box, setBox] = useState("inbox");
  const [folderPath, setFolderPath] = useState("");
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [list, setList] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<MailMessageFull[]>([]);
  const [outbox, setOutbox] = useState<MailOutboxItem[]>([]);
  const [reminders, setReminders] = useState<MailMessage[]>([]);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const [card, setCard] = useState<MailContactCard | null>(null);
  const [customSnooze, setCustomSnooze] = useState(toLocalInput(tomorrow()));
  const [loaded, setLoaded] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((tt: Toast, ms = 6000) => {
    setToast(tt);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const own = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts]);

  /* ------------------------------ загрузка ------------------------------ */

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.mailAccounts());
    } catch {
      /* сервер недоступен */
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadSide = useCallback(async () => {
    try {
      setCounts(await api.mailCounts());
      setReminders(await api.mailReminders());
      if (account !== "all") setFolders(await api.mailFolders(account));
      else setFolders([]);
    } catch {
      /* обновится при следующем опросе */
    }
  }, [account]);

  const loadList = useCallback(
    async (silent = false) => {
      if (box === "outbox") {
        try {
          setOutbox(await api.mailOutbox());
        } catch {
          /* ignore */
        }
        return;
      }
      if (!silent) setLoading(true);
      try {
        const r = await api.mailMessages({
          account: account === "all" ? undefined : account,
          box: folderPath ? undefined : box,
          folder: folderPath || undefined,
          q: query.trim() || undefined,
          unread: unreadOnly,
          limit: 200,
        });
        setList(r);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    },
    [account, box, folderPath, query, unreadOnly],
  );

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadList(), query ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [loadList, query]);

  useEffect(() => {
    void loadSide();
  }, [loadSide]);

  // фоновый опрос: пока страница открыта
  useEffect(() => {
    if (!active || !accounts.length) return;
    const id = window.setInterval(() => {
      void loadList(true);
      void loadSide();
      void loadAccounts();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [active, accounts.length, loadList, loadSide, loadAccounts]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await api.mailSync(account === "all" ? undefined : account);
    } catch (e) {
      showToast({ text: (e as Error).message });
    } finally {
      setSyncing(false);
      void loadAccounts();
      void loadList(true);
      void loadSide();
    }
  }, [account, loadAccounts, loadList, loadSide, showToast]);

  // первая синхронизация после добавления ящика
  useEffect(() => {
    if (loaded && accounts.length && accounts.every((a) => a.lastSync === 0)) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, accounts.length]);

  /* ------------------------------ чтение -------------------------------- */

  const openMessage = useCallback(
    async (m: MailMessage) => {
      setSelected(m.id);
      setSnoozeMenu(false);
      setCard(null);
      try {
        const th = await api.mailThread(m.id);
        setThread(th);
        const unseen = th.filter((x) => !x.seen).map((x) => x.id);
        if (unseen.length) {
          await api.mailFlags(unseen, { seen: true });
          setList((l) => l.map((x) => (x.thread === m.thread ? { ...x, seen: true, unreadCount: 0 } : x)));
          void loadSide();
        }
      } catch {
        setThread([]);
      }
    },
    [loadSide],
  );

  const threadIds = useCallback(() => thread.map((x) => x.id), [thread]);

  const afterAction = useCallback(
    (removeFromList: boolean) => {
      if (removeFromList) {
        const idx = list.findIndex((x) => x.id === selected);
        const next = list[idx + 1] ?? list[idx - 1];
        setList((l) => l.filter((x) => x.id !== selected));
        setThread([]);
        setSelected(null);
        if (next) void openMessage(next);
      }
      void loadSide();
    },
    [list, selected, openMessage, loadSide],
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>, removeFromList: boolean) => {
      try {
        await fn();
        afterAction(removeFromList);
      } catch (e) {
        showToast({ text: (e as Error).message });
      }
    },
    [afterAction, showToast],
  );

  const toggleStar = () => {
    const last = thread[thread.length - 1];
    if (!last) return;
    const v = !last.flagged;
    setThread((th) => th.map((x) => ({ ...x, flagged: v })));
    setList((l) => l.map((x) => (x.id === selected ? { ...x, flagged: v } : x)));
    void run(() => api.mailFlags(threadIds(), { flagged: v }), false);
  };

  const markUnread = () =>
    void run(async () => {
      await api.mailFlags(threadIds(), { seen: false });
      setList((l) => l.map((x) => (x.id === selected ? { ...x, seen: false } : x)));
    }, false);

  const moveTo = (special: string) => void run(() => api.mailMove(threadIds(), { special }), true);

  const delForever = () => {
    if (!window.confirm(t("mail.deleteConfirm"))) return;
    void run(() => api.mailDelete(threadIds()), true);
  };

  const snoozeTo = (until: number) => {
    setSnoozeMenu(false);
    void run(() => api.mailSnooze(threadIds(), until), true);
    showToast({ text: t("mail.snoozedUntil", { when: fmtDate(until, lang, true) }) });
  };

  const unsnooze = () => void run(() => api.mailSnooze(threadIds(), 0), true);

  /* ------------------------------ написание ----------------------------- */

  const quoteOf = (m: MailMessageFull): string => {
    const body = prepareHtml(m.html || `<pre>${escapeHtml(m.text)}</pre>`, false).html;
    const who = m.fromName ? `${m.fromName} &lt;${m.fromAddr}&gt;` : m.fromAddr;
    return `<br><blockquote class="mail-quote">${t("mail.wrote", {
      date: fmtDate(m.date, lang, true),
      who,
    })}<br>${body}</blockquote>`;
  };

  const startReply = (all: boolean) => {
    const m = thread[thread.length - 1];
    if (!m) return;
    const toList = [m.fromAddr];
    const ccList = all
      ? [...m.to, ...m.cc].map((a) => a.address).filter((a) => a && !own.has(a.toLowerCase()) && a !== m.fromAddr)
      : [];
    setCompose({
      account: m.account,
      to: toList.join(", "),
      cc: ccList.join(", "),
      subject: prefixSubject("Re", m.subject),
      html: quoteOf(m),
      inReplyTo: m.messageId,
      references: m.references,
    });
  };

  const startForward = () => {
    const m = thread[thread.length - 1];
    if (!m) return;
    setCompose({
      account: m.account,
      subject: prefixSubject("Fwd", m.subject),
      html: quoteOf(m),
    });
  };

  const onQueued = (id: string, sendAt: number, immediate: boolean) => {
    if (immediate) showToast({ text: t("mail.sending"), undoId: id }, 8000);
    else showToast({ text: t("mail.scheduledFor", { when: fmtDate(sendAt, lang, true) }) });
    void loadSide();
  };

  const undo = async (id: string) => {
    const ok = await api.mailCancelSend(id);
    setToast(null);
    if (ok) showToast({ text: t("mail.sendCancelled") });
    void loadSide();
  };

  /* --------------------------- горячие клавиши -------------------------- */

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || compose || showAccounts) return;
      const i = list.findIndex((x) => x.id === selected);
      switch (e.key) {
        case "j":
          if (list[i + 1]) void openMessage(list[i + 1]);
          break;
        case "k":
          if (list[i - 1]) void openMessage(list[i - 1]);
          break;
        case "c":
          setCompose({ account: account === "all" ? undefined : account });
          break;
        case "e":
          if (thread.length) moveTo("\\Archive");
          break;
        case "#":
          if (thread.length) moveTo("\\Trash");
          break;
        case "s":
          if (thread.length) toggleStar();
          break;
        case "u":
          if (thread.length) markUnread();
          break;
        case "r":
          if (thread.length) startReply(false);
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ------------------------------- разметка ----------------------------- */

  const goBox = (id: string) => {
    setBox(id);
    setFolderPath("");
    setSelected(null);
    setThread([]);
  };

  const openCard = async (address: string) => {
    if (card?.address === address.toLowerCase()) return setCard(null);
    try {
      setCard(await api.mailContact(address));
    } catch {
      /* карточка необязательна */
    }
  };

  const specialBoxIds = new Set(Object.values(SPECIAL_TO_BOX));
  const customFolders = folders.filter(
    (f) => f.special !== SPECIAL_ALL &&!specialBoxIds.has(SPECIAL_TO_BOX[f.special] ?? ""),
  );
  const boxTitle =
    box === "outbox"
      ? t("mail.outbox")
      : folderPath
        ? (folders.find((f) => f.path === folderPath)?.name ?? folderPath)
        : t(BOXES.find((b) => b.id === box)?.key ?? "mail.inbox");

  if (loaded && accounts.length === 0) {
    return (
      <div className="page mail-page">
        <Glass className="mail-empty">
          <MailIcon size={42} strokeWidth={1.5} />
          <h2>{t("mail.noAccounts")}</h2>
          <p>{t("mail.noAccountsHint")}</p>
          <Btn variant="primary" icon={Plus} onClick={() => setShowAccounts(true)}>
            {t("mail.addAccount")}
          </Btn>
        </Glass>
        {showAccounts && (
          <MailAccountForm
            accounts={accounts}
            onClose={() => setShowAccounts(false)}
            onChanged={() => {
              void loadAccounts();
              setShowAccounts(false);
            }}
          />
        )}
      </div>
    );
  }

  const last = thread[thread.length - 1];
  const isSnoozed = !!last && last.snoozeUntil > 0;

  return (
    <div className="page mail-page">
      <Glass className="mail-shell">
        {/* ---- левая колонка ---- */}
        <aside className="mail-side">
          <Btn variant="primary" icon={Plus} onClick={() => setCompose({ account: account === "all" ? undefined : account })}>
            {t("mail.compose")}
          </Btn>

          <div className="select-wrap mail-acc-select">
            <select
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setFolderPath("");
              }}
            >
              <option value="all">{t("mail.allAccounts")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>

          <nav className="mail-boxes">
            {BOXES.map((b) => {
              const Ic = b.icon;
              const n = counts[b.id] ?? 0;
              const on = !folderPath && box === b.id;
              return (
                <button key={b.id} className={`mail-box ${on ? "is-on" : ""}`} onClick={() => goBox(b.id)}>
                  <Ic size={15} />
                  <span>{t(b.key)}</span>
                  {n > 0 && b.id !== "starred" && <i>{n}</i>}
                </button>
              );
            })}
            <button
              className={`mail-box ${box === "outbox" ? "is-on" : ""}`}
              onClick={() => goBox("outbox")}
            >
              <Send size={15} />
              <span>{t("mail.outbox")}</span>
              {(counts.outbox ?? 0) > 0 && <i>{counts.outbox}</i>}
            </button>
          </nav>

          {customFolders.length > 0 && (
            <>
              <div className="mail-side-title">{t("mail.folders")}</div>
              <nav className="mail-boxes">
                {customFolders.map((f) => (
                  <button
                    key={f.path}
                    className={`mail-box ${folderPath === f.path ? "is-on" : ""}`}
                    onClick={() => {
                      setFolderPath(f.path);
                      setBox("");
                      setSelected(null);
                      setThread([]);
                    }}
                  >
                    <Folder size={15} />
                    <span>{f.name}</span>
                    {f.unread > 0 && <i>{f.unread}</i>}
                  </button>
                ))}
              </nav>
            </>
          )}

          <div className="mail-side-foot">
            <button className="mail-box" onClick={() => setShowAccounts(true)}>
              <Settings2 size={15} />
              <span>{t("mail.accounts")}</span>
            </button>
          </div>
        </aside>

        {/* ---- список ---- */}
        <section className="mail-list">
          <div className="mail-list-head">
            <div className="mail-search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("mail.searchHint")}
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="clear">
                  <X size={13} />
                </button>
              )}
            </div>
            <button
              className={`mail-ic ${unreadOnly ? "is-on" : ""}`}
              onClick={() => setUnreadOnly((v) => !v)}
              title={t("mail.unreadOnly")}
            >
              <MailOpen size={15} />
            </button>
            <button className="mail-ic" onClick={() => void sync()} title={t("mail.refresh")}>
              {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            </button>
          </div>
          <div className="mail-list-title">
            {boxTitle}
            {loading && <Loader2 size={13} className="spin" />}
          </div>

          {reminders.length > 0 && box === "inbox" && !query && (
            <div className="mail-reminders">
              <BellRing size={14} />
              <div>
                {reminders.slice(0, 3).map((r) => (
                  <button key={r.id} onClick={() => void openMessage(r)}>
                    {t("mail.noReplyTo", { subject: r.subject || t("mail.noSubject") })}
                  </button>
                ))}
              </div>
              <button
                className="mail-ic"
                onClick={async () => {
                  await Promise.all(reminders.map((r) => api.mailReminder(r.id, 0)));
                  void loadSide();
                }}
                aria-label={t("mail.dismiss")}
              >
                <X size={13} />
              </button>
            </div>
          )}

          <div className="mail-scroll">
            {box === "outbox" ? (
              outbox.length === 0 ? (
                <EmptyHint icon={Send} text={t("mail.outboxEmpty")} />
              ) : (
                outbox.map((o) => (
                  <div key={o.id} className="mail-item">
                    <div className="mail-item-top">
                      <b>{o.to.join(", ")}</b>
                      <span>{fmtDate(o.sendAt, lang, true)}</span>
                    </div>
                    <div className="mail-item-sub">{o.subject}</div>
                    <div className="mail-item-actions">
                      {o.status === "failed" ? (
                        <>
                          <em className="mail-err">{o.error}</em>
                          <Btn onClick={() => void api.mailRetrySend(o.id).then(() => loadList())}>
                            {t("mail.retry")}
                          </Btn>
                        </>
                      ) : (
                        <span className="mail-pending">{t("mail.scheduled")}</span>
                      )}
                      <Btn onClick={() => void api.mailCancelSend(o.id).then(() => loadList())}>
                        {t("mail.cancel")}
                      </Btn>
                    </div>
                  </div>
                ))
              )
            ) : list.length === 0 ? (
              <EmptyHint icon={MailIcon} text={loading ? t("mail.loading") : t("mail.noMessages")} />
            ) : (
              list.map((m) => {
                const who =
                  box === "sent" ? m.to.map(addrShort).join(", ") || "—" : m.fromName || m.fromAddr;
                return (
                  <button
                    key={m.id}
                    className={`mail-item ${selected === m.id ? "is-sel" : ""} ${m.seen ? "" : "is-unread"}`}
                    onClick={() => void openMessage(m)}
                  >
                    <div className="mail-item-top">
                      <b>{who}</b>
                      {(m.count ?? 1) > 1 && <em>{m.count}</em>}
                      <span>{fmtDate(m.date, lang)}</span>
                    </div>
                    <div className="mail-item-sub">
                      {m.flagged && <Star size={12} className="mail-star" />}
                      {m.hasAttachments && <Paperclip size={12} />}
                      {m.subject || t("mail.noSubject")}
                    </div>
                    <div className="mail-item-snip">{m.snippet}</div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* ---- чтение ---- */}
        <section className="mail-read">
          {!last ? (
            <EmptyHint icon={MailIcon} text={t("mail.selectMessage")} />
          ) : (
            <>
              <div className="mail-read-head">
                <h2>{last.subject || t("mail.noSubject")}</h2>
                <div className="mail-toolbar">
                  <button className="mail-ic" onClick={() => startReply(false)} title={t("mail.reply")}>
                    <Reply size={16} />
                  </button>
                  <button className="mail-ic" onClick={() => startReply(true)} title={t("mail.replyAll")}>
                    <ReplyAll size={16} />
                  </button>
                  <button className="mail-ic" onClick={startForward} title={t("mail.forward")}>
                    <Forward size={16} />
                  </button>
                  <span className="mail-fmt-sep" />
                  <button className="mail-ic" onClick={() => moveTo("\\Archive")} title={t("mail.toArchive")}>
                    <Archive size={16} />
                  </button>
                  <button className="mail-ic" onClick={() => moveTo("\\Junk")} title={t("mail.toSpam")}>
                    <ShieldAlert size={16} />
                  </button>
                  <button
                    className="mail-ic"
                    onClick={() => (box === "trash" ? delForever() : moveTo("\\Trash"))}
                    title={box === "trash" ? t("mail.deleteForever") : t("mail.toTrash")}
                  >
                    <Trash2 size={16} />
                  </button>
                  <span className="mail-fmt-sep" />
                  <button className={`mail-ic ${last.flagged ? "is-on" : ""}`} onClick={toggleStar} title={t("mail.star")}>
                    <Star size={16} />
                  </button>
                  <button className="mail-ic" onClick={markUnread} title={t("mail.markUnread")}>
                    <MailOpen size={16} />
                  </button>
                  <div className="mail-pop-wrap">
                    <button
                      className={`mail-ic ${isSnoozed ? "is-on" : ""}`}
                      onClick={() => (isSnoozed ? unsnooze() : setSnoozeMenu((v) => !v))}
                      title={t("mail.snooze")}
                    >
                      <AlarmClock size={16} />
                    </button>
                    {snoozeMenu && (
                      <div className="mail-menu">
                        <button onClick={() => snoozeTo(laterToday())}>{t("mail.snoozeLater")}</button>
                        <button onClick={() => snoozeTo(tomorrow())}>{t("mail.snoozeTomorrow")}</button>
                        <button onClick={() => snoozeTo(weekend())}>{t("mail.snoozeWeekend")}</button>
                        <button onClick={() => snoozeTo(nextWeek())}>{t("mail.snoozeNextWeek")}</button>
                        <div className="mail-menu-custom">
                          <input
                            type="datetime-local"
                            value={customSnooze}
                            onChange={(e) => setCustomSnooze(e.target.value)}
                          />
                          <Btn
                            onClick={() => {
                              const ts = new Date(customSnooze).getTime();
                              if (ts > Date.now()) snoozeTo(ts);
                            }}
                          >
                            OK
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mail-read-scroll">
                {thread.map((m, i) => (
                  <MessageCard
                    key={m.id}
                    m={m}
                    open={i === thread.length - 1 || thread.length === 1}
                    lang={lang}
                    onCard={() => void openCard(m.fromAddr)}
                    card={card && card.address === m.fromAddr ? card : null}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      </Glass>

      {toast && (
        <div className="mail-toast">
          <span>{toast.text}</span>
          {toast.undoId && <button onClick={() => void undo(toast.undoId as string)}>{t("mail.undo")}</button>}
        </div>
      )}

      {compose && (
        <MailCompose
          accounts={accounts}
          init={compose}
          onClose={() => setCompose(null)}
          onQueued={onQueued}
        />
      )}
      {showAccounts && (
        <MailAccountForm
          accounts={accounts}
          onClose={() => setShowAccounts(false)}
          onChanged={() => {
            void loadAccounts();
            void loadSide();
          }}
        />
      )}
    </div>
  );
}

function MessageCard({
  m,
  open: openInit,
  lang,
  onCard,
  card,
}: {
  m: MailMessageFull;
  open: boolean;
  lang: string;
  onCard: () => void;
  card: MailContactCard | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(openInit);
  return (
    <div className={`mail-msg ${open ? "is-open" : ""}`}>
      <div className="mail-msg-head" onClick={() => setOpen((v) => !v)}>
        <span className="mail-avatar">{initials(m.fromName || m.fromAddr)}</span>
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
            <span>{t("mail.cardStats", { n: card.received, since: fmtDate(card.first, lang, true) })}</span>
          </div>
        </div>
      )}
      {open && (
        <>
          <MailBody html={m.html} text={m.text} />
          {m.attachments.filter((a) => !a.inline).length > 0 && (
            <div className="mail-atts">
              {m.attachments
                .filter((a) => !a.inline)
                .map((a) => (
                  <button
                    key={a.index}
                    className="mail-att"
                    onClick={() => void api.mailDownloadAttachment(m.id, a.index)}
                  >
                    <Paperclip size={12} />
                    {a.filename}
                    <em>{fmtSize(a.size)}</em>
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
