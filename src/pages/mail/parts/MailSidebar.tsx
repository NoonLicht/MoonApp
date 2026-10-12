import {
  Archive,
  BarChart3,
  Clock,
  FileText,
  Folder,
  Inbox,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { MailAccount, MailFolder, MailLabel, MailSettings } from "@/api/apiMail";
import { BOX_SPECIAL, DRAG_MIME, sameView, type MailView } from "@/pages/mail/parts/mailTypes";

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

const SPECIAL_BOX = new Set([
  "\\Inbox",
  "\\Sent",
  "\\Drafts",
  "\\Trash",
  "\\Junk",
  "\\Archive",
  "\\All",
  "\\Flagged",
]);

/** Боковая панель: ящик, виртуальные папки, закреплённые, умные папки, метки и папки аккаунта. */
export function MailSidebar({
  accounts,
  account,
  setAccount,
  view,
  setView,
  counts,
  folders,
  labels,
  settings,
  onCompose,
  onSettings,
  onAccounts,
  onDropIds,
  onPin,
}: {
  accounts: MailAccount[];
  account: string;
  setAccount: (a: string) => void;
  view: MailView;
  setView: (v: MailView) => void;
  counts: Record<string, number>;
  folders: MailFolder[];
  labels: MailLabel[];
  settings: MailSettings | null;
  onCompose: () => void;
  onSettings: () => void;
  onAccounts: () => void;
  onDropIds: (ids: string[], dest: { special?: string; path?: string; account?: string }) => void;
  onPin: (f: { account: string; path: string; name: string }) => void;
}) {
  const { t } = useI18n();
  const customFolders = folders.filter((f) => !SPECIAL_BOX.has(f.special));

  const dropProps = (dest: { special?: string; path?: string; account?: string }) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_MIME)) {
        e.preventDefault();
        e.currentTarget.classList.add("is-drop");
      }
    },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove("is-drop"),
    onDrop: (e: React.DragEvent) => {
      e.currentTarget.classList.remove("is-drop");
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      try {
        onDropIds(JSON.parse(raw) as string[], dest);
      } catch {
        /* чужой объект */
      }
    },
  });

  return (
    <aside className="mail-side">
      <Btn variant="primary" icon={Plus} onClick={onCompose}>
        {t("mail.compose")}
      </Btn>

      <div className="select-wrap mail-acc-select">
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="all">{t("mail.allAccounts")}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.pinned ? "★ " : ""}
              {a.email}
              {a.unread ? ` (${a.unread})` : ""}
            </option>
          ))}
        </select>
      </div>

      <nav className="mail-boxes">
        {BOXES.map((b) => {
          const Ic = b.icon;
          const n = counts[b.id] ?? 0;
          const v: MailView = { kind: "box", id: b.id };
          return (
            <button
              key={b.id}
              className={`mail-box ${sameView(view, v) ? "is-on" : ""}`}
              onClick={() => setView(v)}
              {...(BOX_SPECIAL[b.id] ? dropProps({ special: BOX_SPECIAL[b.id] }) : {})}
            >
              <Ic size={15} />
              <span>{t(b.key)}</span>
              {n > 0 && b.id !== "starred" && <i>{n}</i>}
            </button>
          );
        })}
        <button
          className={`mail-box ${view.kind === "outbox" ? "is-on" : ""}`}
          onClick={() => setView({ kind: "outbox" })}
        >
          <Send size={15} />
          <span>{t("mail.outbox")}</span>
          {(counts.outbox ?? 0) > 0 && <i>{counts.outbox}</i>}
        </button>
        {settings?.tracking.enabled && (
          <button
            className={`mail-box ${view.kind === "tracking" ? "is-on" : ""}`}
            onClick={() => setView({ kind: "tracking" })}
          >
            <BarChart3 size={15} />
            <span>{t("mail.tracking")}</span>
          </button>
        )}
      </nav>

      {settings && settings.pinned.length > 0 && (
        <>
          <div className="mail-side-title">{t("mail.pinnedFolders")}</div>
          <nav className="mail-boxes">
            {settings.pinned.map((p) => {
              const v: MailView = {
                kind: "folder",
                account: p.account,
                path: p.path,
                name: p.name,
              };
              return (
                <button
                  key={p.account + p.path}
                  className={`mail-box ${sameView(view, v) ? "is-on" : ""}`}
                  onClick={() => setView(v)}
                  {...dropProps({ path: p.path, account: p.account })}
                >
                  <Pin size={15} />
                  <span>{p.name}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}

      {settings && settings.smartFolders.length > 0 && (
        <>
          <div className="mail-side-title">{t("mail.smartFolders")}</div>
          <nav className="mail-boxes">
            {settings.smartFolders.map((f) => {
              const v: MailView = { kind: "smart", id: f.id };
              return (
                <button
                  key={f.id}
                  className={`mail-box ${sameView(view, v) ? "is-on" : ""}`}
                  onClick={() => setView(v)}
                >
                  <Search size={15} />
                  <span>{f.name}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}

      {account !== "all" && labels.length > 0 && (
        <>
          <div className="mail-side-title">{t("mail.labels")}</div>
          <nav className="mail-boxes">
            {labels.map((l) => {
              const v: MailView = { kind: "label", account, label: l.label };
              return (
                <button
                  key={l.label}
                  className={`mail-box ${sameView(view, v) ? "is-on" : ""}`}
                  onClick={() => setView(v)}
                >
                  <Tag size={15} />
                  <span>{l.label}</span>
                  {l.unread > 0 && <i>{l.unread}</i>}
                </button>
              );
            })}
          </nav>
        </>
      )}

      {account !== "all" && customFolders.length > 0 && (
        <>
          <div className="mail-side-title">{t("mail.folders")}</div>
          <nav className="mail-boxes">
            {customFolders.map((f) => {
              const v: MailView = { kind: "folder", account, path: f.path, name: f.name };
              const pinned = settings?.pinned.some(
                (p) => p.account === account && p.path === f.path,
              );
              return (
                <button
                  key={f.path}
                  className={`mail-box ${sameView(view, v) ? "is-on" : ""}`}
                  onClick={() => setView(v)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!pinned) onPin({ account, path: f.path, name: f.name });
                  }}
                  title={t("mail.pinHint")}
                  {...dropProps({ path: f.path, account })}
                >
                  <Folder size={15} />
                  <span>{f.name}</span>
                  {f.unread > 0 && <i>{f.unread}</i>}
                </button>
              );
            })}
          </nav>
        </>
      )}

      <div className="mail-side-foot">
        <button className="mail-box" onClick={onSettings}>
          <Settings2 size={15} />
          <span>{t("mail.settings")}</span>
        </button>
        <button className="mail-box" onClick={onAccounts}>
          <Inbox size={15} />
          <span>{t("mail.accounts")}</span>
        </button>
      </div>
    </aside>
  );
}
