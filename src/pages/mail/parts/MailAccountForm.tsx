import { useEffect, useRef, useState } from "react";
import { Loader2, LogIn, Pin, Trash2, X } from "lucide-react";
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

function openExternal(url: string): void {
  if (window.appBridge?.openExternal) void window.appBridge.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

/** Окно «Ящики»: подключённые аккаунты и форма добавления (пароль или вход через Google/Microsoft). */
export function MailAccountForm({
  accounts,
  onClose,
  onChanged,
  onOpenSettings,
}: {
  accounts: MailAccount[];
  onClose: () => void;
  onChanged: () => void;
  onOpenSettings: (tab: string) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [srv, setSrv] = useState<MailServers>(EMPTY);
  const [oauth, setOauth] = useState<"" | "google" | "microsoft">("");
  const [oauthReady, setOauthReady] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const poll = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (poll.current) window.clearInterval(poll.current);
    },
    [],
  );

  const guess = async () => {
    if (!/@/.test(email)) return;
    try {
      const g = await api.mailGuess(email);
      setSrv(g);
      setOauth(g.oauth);
      setOauthReady(g.oauthReady);
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

  const oauthLogin = async (provider: "google" | "microsoft") => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.mailOAuthStart(provider);
      openExternal(r.url);
      const started = Date.now();
      poll.current = window.setInterval(async () => {
        try {
          const s = await api.mailOAuthStatus(r.id);
          if (s.status === "pending" && Date.now() - started < 300_000) return;
          if (poll.current) window.clearInterval(poll.current);
          setBusy(false);
          if (s.status === "done") onChanged();
          else setErr(s.error || "timeout");
        } catch (e) {
          if (poll.current) window.clearInterval(poll.current);
          setBusy(false);
          setErr((e as Error).message);
        }
      }, 1500);
    } catch (e) {
      setBusy(false);
      setErr((e as Error).message);
    }
  };

  const remove = async (a: MailAccount) => {
    if (!window.confirm(t("mail.removeConfirm", { email: a.email }))) return;
    await api.mailRemoveAccount(a.id);
    onChanged();
  };

  const num = (v: string) => Number(v.replace(/\D/g, "")) || 0;
  const providerName = oauth === "google" ? "Google" : "Microsoft";

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
              <b>
                {a.name} {a.authType === "oauth" && <em className="mail-dim">OAuth</em>}
              </b>
              <span>{a.email}</span>
              {a.error && <em className="mail-err">{a.error}</em>}
            </div>
            <button
              className={`mail-ic ${a.pinned ? "is-on" : ""}`}
              onClick={() => void api.mailUpdateAccount(a.id, { pinned: !a.pinned }).then(onChanged)}
              aria-label={t("mail.pin")}
            >
              <Pin size={15} />
            </button>
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

        {oauth && (
          <div className="mail-oauth">
            {oauthReady ? (
              <Btn
                variant="primary"
                icon={busy ? Loader2 : LogIn}
                disabled={busy}
                onClick={() => void oauthLogin(oauth)}
              >
                {t("mail.signInWith", { provider: providerName })}
              </Btn>
            ) : (
              <div className="mail-hint">
                {t("mail.oauthNotConfigured", { provider: providerName })}{" "}
                <button className="mail-link" onClick={() => onOpenSettings("oauth")}>
                  {t("mail.openOauthSettings")}
                </button>
              </div>
            )}
            <div className="mail-hint">{t("mail.orPassword")}</div>
          </div>
        )}

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
