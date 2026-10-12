import { useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { Btn, Field, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { MailAccount, MailServers } from "@/api/apiMail";

const EMPTY: MailServers = {
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
};

/** Окно «Ящики»: список подключённых аккаунтов и форма добавления нового. */
export function MailAccountForm({
  accounts,
  onClose,
  onChanged,
}: {
  accounts: MailAccount[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [srv, setSrv] = useState<MailServers>(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const guess = async () => {
    if (!/@/.test(email)) return;
    try {
      setSrv(await api.mailGuess(email));
    } catch {
      /* автоподбор необязателен */
    }
  };

  const connect = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.mailAddAccount({ email, name, password, ...(advanced ? srv : {}) });
      setEmail("");
      setName("");
      setPassword("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: MailAccount) => {
    if (!window.confirm(t("mail.removeConfirm", { email: a.email }))) return;
    await api.mailRemoveAccount(a.id);
    onChanged();
  };

  const num = (v: string) => Number(v.replace(/\D/g, "")) || 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Glass className="modal-panel mail-modal" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="mail-modal-head">
          <div className="media-title">{t("mail.accounts")}</div>
          <button className="mail-x" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        </div>

        {accounts.map((a) => (
          <div key={a.id} className="mail-acc-row">
            <div className="mail-acc-main">
              <b>{a.name}</b>
              <span>{a.email}</span>
              {a.error && <em className="mail-err">{a.error}</em>}
            </div>
            <button className="mail-x" onClick={() => void remove(a)} aria-label={t("mail.remove")}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}

        <div className="mail-form-title">{t("mail.addAccount")}</div>
        <Field label={t("mail.email")}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => void guess()}
            placeholder="name@example.com"
            autoFocus
          />
        </Field>
        <Field label={t("mail.accountName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("mail.password")}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="mail-hint">{t("mail.appPasswordHint")}</div>

        <button className="mail-link" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? t("mail.hideServers") : t("mail.showServers")}
        </button>
        {advanced && (
          <div className="mail-grid2">
            <Field label="IMAP">
              <input value={srv.imapHost} onChange={(e) => setSrv({ ...srv, imapHost: e.target.value })} />
            </Field>
            <Field label={t("mail.port")}>
              <input
                value={srv.imapPort}
                onChange={(e) => setSrv({ ...srv, imapPort: num(e.target.value) })}
              />
            </Field>
            <Field label="SMTP">
              <input value={srv.smtpHost} onChange={(e) => setSrv({ ...srv, smtpHost: e.target.value })} />
            </Field>
            <Field label={t("mail.port")}>
              <input
                value={srv.smtpPort}
                onChange={(e) => {
                  const port = num(e.target.value);
                  setSrv({ ...srv, smtpPort: port, smtpSecure: port === 465 });
                }}
              />
            </Field>
          </div>
        )}
        {err && <div className="mail-err">{err}</div>}
        <div className="mail-actions">
          <Btn variant="primary" onClick={() => void connect()} disabled={busy || !email || !password}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {busy ? t("mail.connecting") : t("mail.connect")}
          </Btn>
        </div>
      </Glass>
    </div>
  );
}
