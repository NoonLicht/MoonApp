import { forwardRef } from "react";
import {
  AlarmClock,
  Archive,
  BellRing,
  FolderInput,
  Loader2,
  Mail as MailIcon,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  X,
  Check,
} from "lucide-react";
import { Btn, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type {
  MailDraft,
  MailFolder,
  MailMessage,
  MailOutboxItem,
  MailSettings,
  MailTrackItem,
} from "@/api/apiMail";
import { MailAvatar } from "@/pages/mail/parts/MailAvatar";
import { addrShort, fmtDate } from "@/pages/mail/parts/mailUtil";
import { DRAG_MIME } from "@/pages/mail/parts/mailTypes";

export interface BulkActions {
  read: () => void;
  unread: () => void;
  star: () => void;
  archive: () => void;
  spam: () => void;
  trash: () => void;
  snooze: () => void;
  move: (path: string) => void;
  selectAll: () => void;
  clear: () => void;
}

/** Список писем с поиском, множественным выделением, перетаскиванием и подгрузкой. */
export const MailList = forwardRef<
  HTMLDivElement,
  {
    title: string;
    rows: MailMessage[];
    drafts: MailDraft[];
    outbox: MailOutboxItem[];
    tracks: MailTrackItem[];
    mode: "list" | "outbox" | "tracking";
    isSent: boolean;
    loading: boolean;
    syncing: boolean;
    loadingMore: boolean;
    query: string;
    setQuery: (q: string) => void;
    unreadOnly: boolean;
    setUnreadOnly: (v: boolean) => void;
    quick: string[];
    toggleQuick: (k: string) => void;
    canMarkAll: boolean;
    onMarkAllRead: () => void;
    emptyKind: "" | "trash" | "spam";
    onEmpty: () => void;
    selected: string | null;
    sel: Set<string>;
    folders: MailFolder[];
    settings: MailSettings | null;
    lang: string;
    reminders: MailMessage[];
    bulk: BulkActions;
    searchRef: React.MutableRefObject<HTMLInputElement | null>;
    onOpen: (m: MailMessage, e: React.MouseEvent) => void;
    onToggle: (m: MailMessage, e: React.MouseEvent) => void;
    onOpenDraft: (d: MailDraft) => void;
    onDeleteDraft: (d: MailDraft) => void;
    onSync: () => void;
    onScrollEnd: () => void;
    onOutboxCancel: (o: MailOutboxItem) => void;
    onOutboxRetry: (o: MailOutboxItem) => void;
    onDismissReminders: () => void;
    onOpenReminder: (m: MailMessage) => void;
  }
>(function MailList(p, ref) {
  const { t } = useI18n();
  const avatars = p.settings?.appearance.avatars ?? "initials";
  const compact = p.settings?.appearance.density === "compact";
  const multi = p.sel.size > 0;

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) p.onScrollEnd();
  };

  return (
    <section className="mail-list">
      <div className="mail-list-head">
        <div className="mail-search">
          <Search size={14} />
          <input
            ref={p.searchRef as React.RefObject<HTMLInputElement>}
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            placeholder={t("mail.searchHint")}
          />
          {p.query && (
            <button onClick={() => p.setQuery("")} aria-label="clear">
              <X size={13} />
            </button>
          )}
        </div>
        <button
          className={`mail-ic ${p.unreadOnly ? "is-on" : ""}`}
          onClick={() => p.setUnreadOnly(!p.unreadOnly)}
          title={t("mail.unreadOnly")}
        >
          <MailOpen size={15} />
        </button>
        <button className="mail-ic" onClick={p.onSync} title={t("mail.refresh")}>
          {p.syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        </button>
      </div>

      <div className="mail-quickfilters">
        {(["unread", "starred", "attach"] as const).map((k) => {
          const on = k === "unread" ? p.unreadOnly : p.quick.includes(k);
          return (
            <button
              key={k}
              className={`mail-chip ${on ? "is-on" : ""}`}
              onClick={() => (k === "unread" ? p.setUnreadOnly(!p.unreadOnly) : p.toggleQuick(k))}
            >
              {t(`mail.qf_${k}`)}
            </button>
          );
        })}
      </div>

      {multi ? (
        <div className="mail-bulk">
          <button className="mail-ic" onClick={p.bulk.clear} title={t("mail.clearSelection")}>
            <X size={15} />
          </button>
          <b>{t("mail.selected", { n: p.sel.size })}</b>
          <button className="mail-ic" onClick={p.bulk.selectAll} title={t("mail.selectAll")}>
            <Check size={15} />
          </button>
          <span className="mail-fmt-sep" />
          <button className="mail-ic" onClick={p.bulk.read} title={t("mail.markRead")}>
            <MailOpen size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.unread} title={t("mail.markUnread")}>
            <MailIcon size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.star} title={t("mail.star")}>
            <Star size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.snooze} title={t("mail.snooze")}>
            <AlarmClock size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.archive} title={t("mail.toArchive")}>
            <Archive size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.spam} title={t("mail.toSpam")}>
            <ShieldAlert size={15} />
          </button>
          <button className="mail-ic" onClick={p.bulk.trash} title={t("mail.toTrash")}>
            <Trash2 size={15} />
          </button>
          {p.folders.length > 0 && (
            <label className="mail-move">
              <FolderInput size={15} />
              <select value="" onChange={(e) => e.target.value && p.bulk.move(e.target.value)}>
                <option value="">{t("mail.moveTo")}</option>
                {p.folders.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ) : (
        <div className="mail-list-title">
          {p.title}
          {p.loading && <Loader2 size={13} className="spin" />}
          <span className="mail-list-title-actions">
            {p.canMarkAll && (
              <button className="mail-link" onClick={p.onMarkAllRead}>
                {t("mail.markAllRead")}
              </button>
            )}
            {p.emptyKind && (
              <button className="mail-link" onClick={p.onEmpty}>
                {p.emptyKind === "trash" ? t("mail.emptyTrash") : t("mail.emptySpam")}
              </button>
            )}
          </span>
        </div>
      )}

      {p.reminders.length > 0 && p.mode === "list" && !p.query && (
        <div className="mail-reminders">
          <BellRing size={14} />
          <div>
            {p.reminders.slice(0, 3).map((r) => (
              <button key={r.id} onClick={() => p.onOpenReminder(r)}>
                {t("mail.noReplyTo", { subject: r.subject || t("mail.noSubject") })}
              </button>
            ))}
          </div>
          <button className="mail-ic" onClick={p.onDismissReminders} aria-label={t("mail.dismiss")}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="mail-scroll" ref={ref} onScroll={onScroll}>
        {p.mode === "outbox" ? (
          p.outbox.length === 0 ? (
            <EmptyHint icon={Send} text={t("mail.outboxEmpty")} />
          ) : (
            p.outbox.map((o) => (
              <div key={o.id} className="mail-item">
                <div className="mail-item-top">
                  <b>{o.to.join(", ")}</b>
                  <span>{fmtDate(o.sendAt, p.lang, true)}</span>
                </div>
                <div className="mail-item-sub">{o.subject}</div>
                <div className="mail-item-actions">
                  {o.status === "failed" ? (
                    <>
                      <em className="mail-err">{o.error}</em>
                      <Btn onClick={() => p.onOutboxRetry(o)}>{t("mail.retry")}</Btn>
                    </>
                  ) : (
                    <span className="mail-pending">{t("mail.scheduled")}</span>
                  )}
                  <Btn onClick={() => p.onOutboxCancel(o)}>{t("mail.cancel")}</Btn>
                </div>
              </div>
            ))
          )
        ) : p.mode === "tracking" ? (
          p.tracks.length === 0 ? (
            <EmptyHint icon={Send} text={t("mail.tr_empty")} />
          ) : (
            p.tracks.map((x) => (
              <div key={x.trackId} className="mail-item">
                <div className="mail-item-top">
                  <b>{x.subject || t("mail.noSubject")}</b>
                  <span>{fmtDate(x.sent, p.lang)}</span>
                </div>
                <div className="mail-item-sub">{x.to.join(", ")}</div>
                <div className="mail-item-snip">
                  {t("mail.tr_opened", { n: x.opens })} · {t("mail.tr_clicked", { n: x.clicks })}
                  {x.lastOpen ? ` · ${fmtDate(x.lastOpen, p.lang, true)}` : ""}
                </div>
              </div>
            ))
          )
        ) : (
          <>
            {p.drafts.map((d) => (
              <div key={d.id} className="mail-item is-draft" onClick={() => p.onOpenDraft(d)}>
                <div className="mail-item-top">
                  <b>
                    <em className="mail-draft-tag">{t("mail.draft")}</em>{" "}
                    {d.to || t("mail.noRecipient")}
                  </b>
                  <span>{fmtDate(d.updated, p.lang)}</span>
                </div>
                <div className="mail-item-sub">{d.subject || t("mail.noSubject")}</div>
                <div className="mail-item-actions">
                  <button
                    className="mail-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onDeleteDraft(d);
                    }}
                  >
                    {t("mail.remove")}
                  </button>
                </div>
              </div>
            ))}
            {p.rows.length === 0 && p.drafts.length === 0 ? (
              <EmptyHint
                icon={MailIcon}
                text={p.loading ? t("mail.loading") : t("mail.noMessages")}
              />
            ) : (
              p.rows.map((m) => {
                const who = p.isSent
                  ? m.to.map(addrShort).join(", ") || "—"
                  : m.fromName || m.fromAddr;
                const checked = p.sel.has(m.id);
                return (
                  <div
                    key={m.id}
                    draggable
                    onDragStart={(e) => {
                      const ids = p.sel.has(m.id) ? [...p.sel] : [m.id];
                      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids.map((i) => `t:${i}`)));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`mail-item ${compact ? "is-compact" : ""} ${
                      p.selected === m.id ? "is-sel" : ""
                    } ${checked ? "is-checked" : ""} ${m.seen ? "" : "is-unread"}`}
                    onClick={(e) => p.onOpen(m, e)}
                  >
                    <div className="mail-item-row">
                      <button
                        className={`mail-pick ${checked ? "is-on" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onToggle(m, e);
                        }}
                        aria-label={t("mail.select")}
                      >
                        {checked ? (
                          <Check size={13} />
                        ) : (
                          <span className="mail-pick-av">
                            <MailAvatar
                              address={p.isSent ? (m.to[0]?.address ?? "") : m.fromAddr}
                              name={who}
                              size={26}
                              mode={avatars}
                            />
                          </span>
                        )}
                      </button>
                      <div className="mail-item-main">
                        <div className="mail-item-top">
                          <b>{who}</b>
                          {(m.count ?? 1) > 1 && <em>{m.count}</em>}
                          <span>{fmtDate(m.date, p.lang)}</span>
                        </div>
                        <div className="mail-item-sub">
                          {m.flagged && <Star size={12} className="mail-star" />}
                          {m.hasAttachments && <Paperclip size={12} />}
                          {m.subject || t("mail.noSubject")}
                        </div>
                        {!compact && <div className="mail-item-snip">{m.snippet}</div>}
                        {m.labels.length > 0 && (
                          <div className="mail-item-labels">
                            {m.labels.slice(0, 3).map((l) => (
                              <span key={l}>{l}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {p.loadingMore && (
              <div className="mail-more">
                <Loader2 size={14} className="spin" /> {t("mail.loading")}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});
