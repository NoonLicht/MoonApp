import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mail as MailIcon, Plus } from "lucide-react";
import { Btn, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { usePageActive } from "@/components/Toolbar";
import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailLabel,
  MailListQuery,
  MailMessage,
  MailMessageFull,
  MailOutboxItem,
  MailSettings,
  MailSignature,
  MailTrackItem,
} from "@/api/apiMail";
import { MailAccountForm } from "@/pages/mail/parts/MailAccountForm";
import { MailCompose, type ComposeInit } from "@/pages/mail/parts/MailCompose";
import { MailSettingsDialog } from "@/pages/mail/parts/MailSettingsDialog";
import { MailSidebar } from "@/pages/mail/parts/MailSidebar";
import { MailList, type BulkActions } from "@/pages/mail/parts/MailList";
import { MailReader } from "@/pages/mail/parts/MailReader";
import type { MailView } from "@/pages/mail/parts/mailTypes";
import {
  escapeHtml,
  fmtDate,
  laterToday,
  prefixSubject,
  prepareHtml,
} from "@/pages/mail/parts/mailUtil";

const PAGE = 100;

const SPECIAL_OF_BOX: Record<string, string> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  spam: "\\Junk",
  archive: "\\Archive",
};

interface Toast {
  text: string;
  undoId?: string;
}

export default function MailPage() {
  const { t, lang } = useI18n();
  const active = usePageActive();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [account, setAccount] = useState("all");
  const [view, setView] = useState<MailView>({ kind: "box", id: "inbox" });
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [rows, setRows] = useState<MailMessage[]>([]);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [outbox, setOutbox] = useState<MailOutboxItem[]>([]);
  const [tracks, setTracks] = useState<MailTrackItem[]>([]);
  const [reminders, setReminders] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<MailMessageFull[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [signatures, setSignatures] = useState<MailSignature[]>([]);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [ruleSeed, setRuleSeed] = useState("");
  const [quick, setQuick] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [loaded, setLoaded] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastIdx = useRef(-1);
  const exhausted = useRef(false);
  const lastSyncAt = useRef(0);
  const reqSeq = useRef(0);

  const showToast = useCallback((tt: Toast, ms = 6000) => {
    setToast(tt);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const own = useMemo(
    () =>
      new Set(
        accounts
          .flatMap((a) => [a.email, ...a.aliases.map((x) => x.address)])
          .map((x) => x.toLowerCase()),
      ),
    [accounts],
  );

  const threadsOn = settings?.appearance.threads !== false;

  useEffect(() => {
    if (ruleSeed) setSettingsTab("rules");
  }, [ruleSeed]);

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

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.mailSettings());
      setSignatures(await api.mailSignatures());
    } catch {
      /* настройки подтянутся позже */
    }
  }, []);

  const loadSide = useCallback(async () => {
    try {
      setCounts(await api.mailCounts());
      setReminders(await api.mailReminders());
      if (account !== "all") {
        setFolders(await api.mailFolders(account));
        setLabels(await api.mailLabels(account));
      } else {
        setFolders([]);
        setLabels([]);
      }
    } catch {
      /* обновится при следующем опросе */
    }
  }, [account]);

  const buildQuery = useCallback(
    (offset: number): MailListQuery => {
      const tokens = [
        query.trim(),
        quick.includes("starred") ? "is:starred" : "",
        quick.includes("attach") ? "has:attachment" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const q: MailListQuery = {
        account: account === "all" ? undefined : account,
        q: tokens || undefined,
        unread: unreadOnly,
        threads: threadsOn,
        limit: PAGE,
        offset,
      };
      if (view.kind === "box") q.box = view.id;
      else if (view.kind === "folder") {
        q.account = view.account;
        q.folder = view.path;
      } else if (view.kind === "label") {
        q.account = view.account;
        q.label = view.label;
      } else if (view.kind === "smart") {
        const f = settings?.smartFolders.find((x) => x.id === view.id);
        q.account = f?.account || undefined;
        q.q = [f?.query, tokens].filter(Boolean).join(" ") || undefined;
      }
      return q;
    },
    [account, query, quick, unreadOnly, threadsOn, view, settings],
  );

  const loadList = useCallback(
    async (silent = false) => {
      const seq = ++reqSeq.current;
      if (view.kind === "outbox") {
        setOutbox(await api.mailOutbox().catch(() => []));
        return;
      }
      if (view.kind === "tracking") {
        setTracks(await api.mailTracking().catch(() => []));
        return;
      }
      if (!silent) setLoading(true);
      try {
        const r = await api.mailMessages(buildQuery(0));
        if (seq !== reqSeq.current) return;
        exhausted.current = r.length < PAGE;
        setRows(r);
        if (view.kind === "box" && view.id === "drafts")
          setDrafts(await api.mailDrafts().catch(() => []));
        else setDrafts([]);
      } catch {
        /* ignore */
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [view, buildQuery],
  );

  /** Какую папку сервера можно «догружать» для текущего вида. */
  const olderTarget = useCallback((): { account: string; folder: string } | null => {
    if (query.trim() || view.kind === "smart" || view.kind === "label") return null;
    if (view.kind === "folder") return { account: view.account, folder: view.path };
    if (view.kind === "box" && account !== "all") {
      const sp = SPECIAL_OF_BOX[view.id];
      const f = sp ? folders.find((x) => x.special === sp) : undefined;
      return f ? { account, folder: f.path } : null;
    }
    return null;
  }, [view, account, folders, query]);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || view.kind === "outbox" || view.kind === "tracking") return;
    setLoadingMore(true);
    try {
      if (!exhausted.current) {
        const r = await api.mailMessages(buildQuery(rows.length));
        if (r.length < PAGE) exhausted.current = true;
        if (r.length)
          setRows((cur) => [...cur, ...r.filter((x) => !cur.some((y) => y.id === x.id))]);
        if (r.length) return;
      }
      const tgt = olderTarget();
      if (!tgt) return;
      const res = await api.mailLoadOlder(tgt.account, tgt.folder);
      if (res.added > 0) {
        exhausted.current = false;
        const r = await api.mailMessages(buildQuery(rows.length));
        setRows((cur) => [...cur, ...r.filter((x) => !cur.some((y) => y.id === x.id))]);
        if (r.length < PAGE && !res.hasMore) exhausted.current = true;
      }
    } catch {
      /* подгрузка необязательна */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, view, buildQuery, rows.length, olderTarget]);

  useEffect(() => {
    void loadAccounts();
    void loadSettings();
  }, [loadAccounts, loadSettings]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadList(), query ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [loadList, query]);

  useEffect(() => {
    void loadSide();
  }, [loadSide]);

  // фоновый опрос локальной базы: синхронизация идёт на сервере (IDLE), здесь только перерисовка
  useEffect(() => {
    if (!active || !accounts.length) return;
    const id = window.setInterval(() => {
      void loadList(true);
      void loadSide();
      void loadAccounts();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [active, accounts.length, loadList, loadSide, loadAccounts]);

  const sync = useCallback(
    async (silent = false) => {
      lastSyncAt.current = Date.now();
      if (!silent) setSyncing(true);
      try {
        await api.mailSync(account === "all" ? undefined : account);
      } catch (e) {
        if (!silent) showToast({ text: (e as Error).message });
      } finally {
        setSyncing(false);
        void loadAccounts();
        void loadList(true);
        void loadSide();
      }
    },
    [account, loadAccounts, loadList, loadSide, showToast],
  );

  // синхронизация при возврате в окно (плагин refresh-on-focus)
  useEffect(() => {
    if (!settings?.appearance.refreshOnFocus || !accounts.length) return;
    const onFocus = () => {
      if (!active || document.hidden) return;
      if (Date.now() - lastSyncAt.current < 20_000) return;
      void sync(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [settings?.appearance.refreshOnFocus, accounts.length, active, sync]);

  // первая синхронизация после добавления ящика
  useEffect(() => {
    if (loaded && accounts.length && accounts.every((a) => a.lastSync === 0)) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, accounts.length]);

  /* ------------------------------ чтение -------------------------------- */

  const openMessage = useCallback(
    async (m: MailMessage) => {
      setSelected(m.id);
      try {
        const th = await api.mailThread(m.id);
        setThread(th);
        if (settings?.appearance.markReadOnOpen === false) return;
        const unseen = th.filter((x) => !x.seen).map((x) => x.id);
        if (unseen.length) {
          await api.mailFlags(unseen, { seen: true });
          setRows((l) =>
            l.map((x) => (x.thread === m.thread ? { ...x, seen: true, unreadCount: 0 } : x)),
          );
          void loadSide();
        }
      } catch {
        setThread([]);
      }
    },
    [loadSide, settings?.appearance.markReadOnOpen],
  );

  const ref = (id: string) => (threadsOn ? `t:${id}` : id);

  const dropRows = useCallback((ids: string[]) => {
    const gone = new Set(ids.map((i) => i.replace(/^t:/, "")));
    setRows((l) => l.filter((x) => !gone.has(x.id)));
    setSel(new Set());
    setSelected((cur) => {
      if (cur && gone.has(cur)) {
        setThread([]);
        return null;
      }
      return cur;
    });
  }, []);

  const guard = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      try {
        await fn();
        after?.();
      } catch (e) {
        showToast({ text: (e as Error).message });
      } finally {
        void loadSide();
      }
    },
    [loadSide, showToast],
  );

  const nextAfter = (id: string) => {
    const idx = rows.findIndex((x) => x.id === id);
    return rows[idx + 1] ?? rows[idx - 1] ?? null;
  };

  /* ---------------------- действия над открытой цепочкой ---------------- */

  const cur = selected;
  const curRef = cur ? ref(cur) : "";
  const last = thread[thread.length - 1];
  const lastAccount = last?.account;
  const [readerFolders, setReaderFolders] = useState<MailFolder[]>([]);
  const [readerLabels, setReaderLabels] = useState<MailLabel[]>([]);
  // в режиме «Все ящики» папки и метки берём у ящика открытого письма
  useEffect(() => {
    if (account !== "all" || !lastAccount) return;
    void api
      .mailFolders(lastAccount)
      .then(setReaderFolders)
      .catch(() => undefined);
    void api
      .mailLabels(lastAccount)
      .then(setReaderLabels)
      .catch(() => undefined);
  }, [account, lastAccount]);
  const inTrash = view.kind === "box" && view.id === "trash";

  const actMove = (special: string) => {
    if (!cur) return;
    const next = nextAfter(cur);
    void guard(
      () => api.mailMove([curRef], { special }),
      () => {
        dropRows([cur]);
        if (next) void openMessage(next);
      },
    );
  };

  const actMovePath = (path: string) => {
    if (!cur) return;
    const next = nextAfter(cur);
    void guard(
      () => api.mailMove([curRef], { path }),
      () => {
        dropRows([cur]);
        if (next) void openMessage(next);
      },
    );
  };

  const actLabel = (label: string, add: boolean) => {
    if (!cur) return;
    void guard(
      () => api.mailSetLabel([curRef], label, add),
      () =>
        setThread((th) =>
          th.map((x) => ({
            ...x,
            labels: add ? [...new Set([...x.labels, label])] : x.labels.filter((l) => l !== label),
          })),
        ),
    );
  };

  const markAll = () => {
    const tgt = olderTarget();
    if (!tgt) return;
    void guard(
      () => api.mailMarkAllRead(tgt.account, tgt.folder),
      () => {
        setRows((l) => l.map((x) => ({ ...x, seen: true, unreadCount: 0 })));
        void loadList(true);
      },
    );
  };

  const emptyBox = () => {
    if (view.kind !== "box" || account === "all") return;
    if (!window.confirm(t("mail.emptyConfirm"))) return;
    const special = view.id === "trash" ? "\\Trash" : "\\Junk";
    void guard(
      () => api.mailEmptyFolder(account, special),
      () => {
        setRows([]);
        setThread([]);
        setSelected(null);
      },
    );
  };

  const actDeleteForever = () => {
    if (!cur || !window.confirm(t("mail.deleteConfirm"))) return;
    void guard(
      () => api.mailDelete([curRef]),
      () => dropRows([cur]),
    );
  };

  const actStar = () => {
    if (!cur || !last) return;
    const v = !last.flagged;
    setThread((th) => th.map((x) => ({ ...x, flagged: v })));
    setRows((l) => l.map((x) => (x.id === cur ? { ...x, flagged: v } : x)));
    void guard(() => api.mailFlags([curRef], { flagged: v }));
  };

  const actUnread = () => {
    if (!cur) return;
    setRows((l) => l.map((x) => (x.id === cur ? { ...x, seen: false } : x)));
    void guard(() => api.mailFlags([curRef], { seen: false }));
  };

  const actSnooze = (until: number) => {
    if (!cur) return;
    const next = nextAfter(cur);
    void guard(
      () => api.mailSnooze([curRef], until),
      () => {
        dropRows([cur]);
        if (until > 0)
          showToast({ text: t("mail.snoozedUntil", { when: fmtDate(until, lang, true) }) });
        if (next) void openMessage(next);
      },
    );
  };

  /* ------------------------------ написание ----------------------------- */

  const quoteOf = (m: MailMessageFull): string => {
    const body = prepareHtml(m.html || `<pre>${escapeHtml(m.text)}</pre>`, false).html;
    const who = m.fromName ? `${escapeHtml(m.fromName)} &lt;${m.fromAddr}&gt;` : m.fromAddr;
    return `<br><blockquote class="mail-quote">${t("mail.wrote", {
      date: fmtDate(m.date, lang, true),
      who,
    })}<br>${body}</blockquote>`;
  };

  const startReply = (all: boolean, lead?: string) => {
    const m = thread[thread.length - 1];
    if (!m) return;
    // отвечаем отправителю; если это наше письмо — тем, кому писали
    const fromMe = own.has(m.fromAddr.toLowerCase());
    const toList = fromMe ? m.to.map((a) => a.address) : [m.replyTo || m.fromAddr];
    const ccList = all
      ? [...m.to, ...m.cc]
          .map((a) => a.address)
          .filter((a) => a && !own.has(a.toLowerCase()) && !toList.includes(a))
      : [];
    // отвечаем с того адреса, на который пришло письмо
    const mine = [...m.to, ...m.cc].map((a) => a.address).find((a) => own.has(a.toLowerCase()));
    setCompose({
      account: m.account,
      from: mine,
      to: toList.join(", "),
      cc: ccList.join(", "),
      subject: prefixSubject("Re", m.subject),
      lead,
      quoted: quoteOf(m),
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
      quoted: quoteOf(m),
    });
  };

  const openDraft = (d: MailDraft) =>
    setCompose({
      draftId: d.id,
      account: d.account,
      from: d.from,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      html: d.html,
      inReplyTo: d.inReplyTo,
      references: d.references,
      attachments: d.attachments,
    });

  const onQueued = (id: string, sendAt: number, immediate: boolean) => {
    if (immediate)
      showToast(
        { text: t("mail.sending"), undoId: id },
        Math.max(4000, (settings?.appearance.sendDelaySec ?? 8) * 1000),
      );
    else showToast({ text: t("mail.scheduledFor", { when: fmtDate(sendAt, lang, true) }) });
    void loadSide();
    void loadList(true);
  };

  const undo = async (id: string) => {
    setToast(null);
    try {
      const r = await api.mailCancelSend(id);
      if (r.ok && r.payload) {
        const p = r.payload;
        setCompose({
          draftId: p.draftId,
          account: p.account,
          to: p.to.join(", "),
          cc: (p.cc ?? []).join(", "),
          bcc: (p.bcc ?? []).join(", "),
          subject: p.subject,
          html: p.html,
          inReplyTo: p.inReplyTo,
          references: p.references,
          attachments: p.attachments,
          // без draftId HTML вставится как «хвост» — для вернувшегося письма нужен весь текст
          ...(p.draftId ? {} : { draftId: crypto.randomUUID() }),
        });
        showToast({ text: t("mail.sendCancelled") });
      }
    } finally {
      void loadSide();
    }
  };

  /* ------------------------ выделение и пакетные действия --------------- */

  const onOpen = (m: MailMessage, e: React.MouseEvent) => {
    const idx = rows.findIndex((x) => x.id === m.id);
    if (e.ctrlKey || e.metaKey) {
      toggle(m, e);
      lastIdx.current = idx;
      return;
    }
    if (e.shiftKey && lastIdx.current >= 0) {
      const [a, b] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)];
      setSel(new Set(rows.slice(a, b + 1).map((x) => x.id)));
      return;
    }
    setSel(new Set());
    lastIdx.current = idx;
    void openMessage(m);
  };

  function toggle(m: MailMessage, e?: React.MouseEvent) {
    const idx = rows.findIndex((x) => x.id === m.id);
    setSel((s) => {
      const n = new Set(s);
      if (e?.shiftKey && lastIdx.current >= 0) {
        const [a, b] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)];
        rows.slice(a, b + 1).forEach((x) => n.add(x.id));
      } else if (n.has(m.id)) n.delete(m.id);
      else n.add(m.id);
      return n;
    });
    lastIdx.current = idx;
  }

  const selIds = () => [...sel].map(ref);

  const bulk: BulkActions = {
    read: () =>
      void guard(
        () => api.mailFlags(selIds(), { seen: true }),
        () => {
          setRows((l) => l.map((x) => (sel.has(x.id) ? { ...x, seen: true } : x)));
          setSel(new Set());
        },
      ),
    unread: () =>
      void guard(
        () => api.mailFlags(selIds(), { seen: false }),
        () => {
          setRows((l) => l.map((x) => (sel.has(x.id) ? { ...x, seen: false } : x)));
          setSel(new Set());
        },
      ),
    star: () => {
      const all = rows.filter((x) => sel.has(x.id)).every((x) => x.flagged);
      void guard(
        () => api.mailFlags(selIds(), { flagged: !all }),
        () => {
          setRows((l) => l.map((x) => (sel.has(x.id) ? { ...x, flagged: !all } : x)));
          setSel(new Set());
        },
      );
    },
    archive: () =>
      void guard(
        () => api.mailMove(selIds(), { special: "\\Archive" }),
        () => dropRows([...sel]),
      ),
    spam: () =>
      void guard(
        () => api.mailMove(selIds(), { special: "\\Junk" }),
        () => dropRows([...sel]),
      ),
    trash: () =>
      void guard(
        () => api.mailMove(selIds(), { special: "\\Trash" }),
        () => dropRows([...sel]),
      ),
    snooze: () =>
      void guard(
        () => api.mailSnooze(selIds(), laterToday()),
        () => dropRows([...sel]),
      ),
    move: (path) =>
      void guard(
        () => api.mailMove(selIds(), { path }),
        () => dropRows([...sel]),
      ),
    selectAll: () => setSel(new Set(rows.map((x) => x.id))),
    clear: () => setSel(new Set()),
  };

  const onDropIds = (
    ids: string[],
    dest: { special?: string; path?: string; account?: string },
  ) => {
    void guard(
      () => api.mailMove(ids, dest.path ? { path: dest.path } : { special: dest.special }),
      () => dropRows(ids),
    );
  };

  /* --------------------------- горячие клавиши -------------------------- */

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || compose || showAccounts || settingsTab) return;
      const i = rows.findIndex((x) => x.id === selected);
      switch (e.key) {
        case "j":
          if (rows[i + 1]) void openMessage(rows[i + 1]);
          break;
        case "k":
          if (rows[i - 1]) void openMessage(rows[i - 1]);
          break;
        case "c":
          setCompose({ account: account === "all" ? undefined : account });
          break;
        case "x":
          if (rows[i]) toggle(rows[i]);
          break;
        case "e":
          if (sel.size) bulk.archive();
          else if (thread.length) actMove("\\Archive");
          break;
        case "#":
          if (sel.size) bulk.trash();
          else if (thread.length) actMove("\\Trash");
          break;
        case "s":
          if (thread.length) actStar();
          break;
        case "u":
          if (thread.length) actUnread();
          break;
        case "r":
          if (thread.length) startReply(false);
          break;
        case "a":
          if (thread.length) startReply(true);
          break;
        case "f":
          if (thread.length) startForward();
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

  const changeView = (v: MailView) => {
    setView(v);
    setSelected(null);
    setThread([]);
    setSel(new Set());
    exhausted.current = false;
  };

  const pin = async (f: { account: string; path: string; name: string }) => {
    if (!settings) return;
    const next = [
      ...settings.pinned.filter((p) => !(p.account === f.account && p.path === f.path)),
      f,
    ];
    setSettings(await api.mailSaveSettings({ pinned: next }));
  };

  const title = (() => {
    switch (view.kind) {
      case "outbox":
        return t("mail.outbox");
      case "tracking":
        return t("mail.tracking");
      case "folder":
        return view.name;
      case "label":
        return view.label;
      case "smart":
        return settings?.smartFolders.find((x) => x.id === view.id)?.name ?? "";
      default:
        return t(
          {
            inbox: "mail.inbox",
            starred: "mail.starred",
            snoozed: "mail.snoozed",
            sent: "mail.sentBox",
            drafts: "mail.drafts",
            archive: "mail.archive",
            spam: "mail.spam",
            trash: "mail.trash",
          }[view.id] ?? "mail.inbox",
        );
    }
  })();

  // тема письма: «авто» следует теме приложения
  const lightApp =
    typeof document !== "undefined" &&
    !!document.querySelector(".app-shell.theme-light, .app-shell[class*='theme-light']");
  const bodyTheme = settings?.appearance.bodyTheme ?? "auto";
  const dark = bodyTheme === "dark" || (bodyTheme === "auto" && !lightApp);

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
            onOpenSettings={(tab) => {
              setShowAccounts(false);
              setSettingsTab(tab);
            }}
          />
        )}
        {settingsTab && (
          <MailSettingsDialog
            accounts={accounts}
            initialTab={settingsTab}
            ruleSeed={ruleSeed}
            onClose={() => {
              setSettingsTab(null);
              setRuleSeed("");
            }}
            onChanged={() => void loadSettings()}
          />
        )}
      </div>
    );
  }

  const mode = view.kind === "outbox" ? "outbox" : view.kind === "tracking" ? "tracking" : "list";
  const density = settings?.appearance.density ?? "cozy";

  return (
    <div className={`page mail-page mail-density-${density}`}>
      <Glass className="mail-shell">
        <MailSidebar
          accounts={accounts}
          account={account}
          setAccount={(a) => {
            setAccount(a);
            if (view.kind === "folder" || view.kind === "label")
              changeView({ kind: "box", id: "inbox" });
          }}
          view={view}
          setView={changeView}
          counts={counts}
          folders={folders}
          labels={labels}
          settings={settings}
          onCompose={() => setCompose({ account: account === "all" ? undefined : account })}
          onSettings={() => setSettingsTab("general")}
          onAccounts={() => setShowAccounts(true)}
          onDropIds={onDropIds}
          onPin={(f) => void pin(f)}
        />

        <MailList
          ref={scrollRef}
          title={title}
          rows={rows}
          drafts={view.kind === "box" && view.id === "drafts" && !query ? drafts : []}
          outbox={outbox}
          tracks={tracks}
          mode={mode}
          isSent={view.kind === "box" && view.id === "sent"}
          loading={loading}
          syncing={syncing}
          loadingMore={loadingMore}
          query={query}
          setQuery={setQuery}
          unreadOnly={unreadOnly}
          setUnreadOnly={setUnreadOnly}
          quick={quick}
          toggleQuick={(k) =>
            setQuick((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]))
          }
          canMarkAll={view.kind === "folder" || (view.kind === "box" && !!olderTarget())}
          onMarkAllRead={markAll}
          emptyKind={
            view.kind === "box" && account !== "all" && (view.id === "trash" || view.id === "spam")
              ? view.id
              : ""
          }
          onEmpty={emptyBox}
          selected={selected}
          sel={sel}
          folders={account === "all" ? [] : folders}
          settings={settings}
          lang={lang}
          reminders={reminders}
          bulk={bulk}
          searchRef={searchRef}
          onOpen={onOpen}
          onToggle={(m, e) => toggle(m, e)}
          onOpenDraft={openDraft}
          onDeleteDraft={(d) => void api.mailDeleteDraft(d.id).then(() => loadList(true))}
          onSync={() => void sync()}
          onScrollEnd={() => void loadMore()}
          onOutboxCancel={(o) => void api.mailCancelSend(o.id).then(() => loadList(true))}
          onOutboxRetry={(o) => void api.mailRetrySend(o.id).then(() => loadList(true))}
          onDismissReminders={async () => {
            await Promise.all(reminders.map((r) => api.mailReminder(r.id, 0)));
            void loadSide();
          }}
          onOpenReminder={(m) => void openMessage(m)}
        />

        <MailReader
          thread={thread}
          settings={settings}
          dark={dark}
          lang={lang}
          inTrash={inTrash}
          inSpam={view.kind === "box" && view.id === "spam"}
          folders={(account === "all" ? readerFolders : folders).filter((f) => !f.special)}
          labels={account === "all" ? readerLabels : labels}
          onMovePath={actMovePath}
          onLabel={actLabel}
          onRuleFromSender={() => setRuleSeed(last ? last.fromAddr : "")}
          onReply={startReply}
          onForward={startForward}
          onMove={actMove}
          onDeleteForever={actDeleteForever}
          onStar={actStar}
          onUnread={actUnread}
          onSnooze={actSnooze}
          onToast={(text) => showToast({ text })}
        />
      </Glass>

      {toast && (
        <div className="mail-toast">
          <span>{toast.text}</span>
          {toast.undoId && (
            <button onClick={() => void undo(toast.undoId as string)}>{t("mail.undo")}</button>
          )}
        </div>
      )}

      {compose && settings && (
        <MailCompose
          accounts={accounts}
          init={compose}
          settings={settings}
          signatures={signatures}
          onClose={() => {
            setCompose(null);
            void loadSide();
            void loadList(true);
          }}
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
          onOpenSettings={(tab) => {
            setShowAccounts(false);
            setSettingsTab(tab);
          }}
        />
      )}
      {settingsTab && (
        <MailSettingsDialog
          accounts={accounts}
          initialTab={settingsTab}
          ruleSeed={ruleSeed}
          onClose={() => {
            setSettingsTab(null);
            setRuleSeed("");
          }}
          onChanged={() => {
            void loadSettings();
            void loadAccounts();
          }}
        />
      )}
    </div>
  );
}
