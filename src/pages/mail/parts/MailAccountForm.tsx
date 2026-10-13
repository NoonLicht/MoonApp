import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, LogIn, Pin, Trash2, X } from "lucide-react";
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

interface Provider {
  id: string;
  label: string;
  color: string;
  sample: string;
  oauth?: "google" | "microsoft";
  /** Страница, где создаётся пароль приложения. */
  passUrl?: string;
  /** Страница, где включается доступ по IMAP (если нужно). */
  imapUrl?: string;
}

const PROVIDERS: Provider[] = [
  {
    id: "gmail",
    label: "Gmail",
    color: "#ea4335",
    sample: "name@gmail.com",
    oauth: "google",
    passUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "outlook",
    label: "Outlook",
    color: "#0a64ad",
    sample: "name@outlook.com",
    oauth: "microsoft",
    passUrl: "https://account.live.com/proofs/AppPassword",
  },
  {
    id: "yandex",
    label: "Yandex",
    color: "#fc3f1d",
    sample: "name@yandex.ru",
    passUrl: "https://id.yandex.ru/security/app-passwords",
    imapUrl: "https://mail.yandex.ru/#setup/client",
  },
  {
    id: "mailru",
    label: "Mail.ru",
    color: "#168de2",
    sample: "name@mail.ru",
    passUrl: "https://account.mail.ru/user/2-step-auth/passwords",
  },
  {
    id: "yahoo",
    label: "Yahoo",
    color: "#6001d2",
    sample: "name@yahoo.com",
    passUrl: "https://login.yahoo.com/account/security",
  },
  {
    id: "icloud",
    label: "iCloud",
    color: "#3b82f6",
    sample: "name@icloud.com",
    passUrl: "https://account.apple.com/account/manage",
  },
  { id: "proton", label: "Proton", color: "#6d4aff", sample: "name@proton.me" },
  { id: "other", label: "IMAP", color: "#64748b", sample: "name@example.com" },
];

/**
 * Подключение ящиков: выбор сервиса → вход в браузере (Google/Microsoft) или пароль приложения.
 * Показывается страницей на месте пустого экрана, без затемнённого модального окна.
 */
export function MailAccountForm({
  accounts,
  onClose,
  onChanged,
  onOpenSettings,
  closeOnAdd,
}: {
  accounts: MailAccount[];
  onClose: () => void;
  onChanged: () => void;
  onOpenSettings: (tab: string) => void;
  /** Первый ящик: после подключения сразу входим в почту. */
  closeOnAdd?: boolean;
}) {
  const { t } = useI18n();
  const [pick, setPick] = useState<Provider | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [srv, setSrv] = useState<MailServers>(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [usePass, setUsePass] = useState(false);
  const [oauthReady, setOauthReady] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [added, setAdded] = useState("");
  const poll = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (poll.current) window.clearInterval(poll.current);
    },
    [],
  );

  // готов ли вход через браузер (внесены ли Client ID)
  useEffect(() => {
    void (async () => {
      const out: Record<string, boolean> = {};
      for (const [p, e] of [
        ["google", "a@gmail.com"],
        ["microsoft", "a@outlook.com"],
      ] as const) {
        try {
          out[p] = (await api.mailGuess(e)).oauthReady;
        } catch {
          out[p] = false;
        }
      }
      setOauthReady(out);
    })();
  }, []);

  const choose = (p: Provider) => {
    setPick(p);
    setErr("");
    setAdded("");
    setPassword("");
    setUsePass(false);
    setAdvanced(p.id === "other");
    if (p.id === "other") setSrv(EMPTY);
  };

  const friendly = (m: string): string => {
    const raw = m.replace(/^[a-z_]+:\s*/, "");
    if (m.startsWith("imap_login_failed")) return t("mail.errImap") + (raw ? ` (${raw})` : "");
    if (m.startsWith("smtp_login_failed")) return t("mail.errSmtp") + (raw ? ` (${raw})` : "");
    if (m.startsWith("bad_email")) return t("mail.errEmail");
    return m;
  };

  const finish = (addr: string) => {
    setAdded(addr);
    setPick(null);
    setEmail("");
    setName("");
    setPassword("");
    onChanged();
  };

  const guess = async () => {
    if (!/@/.test(email) || !advanced) return;
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
      finish(email);
    } catch (e) {
      setErr(friendly((e as Error).message));
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
          if (s.status === "done") finish(pick?.label ?? "");
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
  const oauthOk = pick?.oauth ? oauthReady[pick.oauth] : false;
  const showOauth = !!pick?.oauth && !usePass;
  const providerHint = pick && pick.id !== "other" ? t(`mail.hint_${pick.id}`) : "";

  return (
    <div className="mail-connect-layer">
      <Glass className="mail-connect">
        <div className="mail-connect-head">
          <div>
            <h2>{t("mail.connectTitle")}</h2>
            <p>{t("mail.connectSub")}</p>
          </div>
          {!closeOnAdd && (
            <button className="mail-x" onClick={onClose} aria-label="close">
              <X size={16} />
            </button>
          )}
        </div>

        {accounts.length > 0 && (
          <div className="mail-connect-list">
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
                  onClick={() =>
                    void api.mailUpdateAccount(a.id, { pinned: !a.pinned }).then(onChanged)
                  }
                  aria-label={t("mail.pin")}
                >
                  <Pin size={15} />
                </button>
                <button
                  className="mail-x"
                  onClick={() => void remove(a)}
                  aria-label={t("mail.remove")}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        {added && (
          <div className="mail-connect-ok">
            <Check size={15} /> {t("mail.connectedOk", { email: added })}
          </div>
        )}

        <div className="mail-prov-grid">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`mail-prov ${pick?.id === p.id ? "is-on" : ""}`}
              onClick={() => choose(p)}
            >
              <span className="mail-prov-dot" style={{ background: p.color }}>
                {p.label[0]}
              </span>
              {p.id === "other" ? t("mail.providerOther") : p.label}
            </button>
          ))}
        </div>

        {pick && (
          <div className="mail-connect-form">
            {showOauth ? (
              <>
                {oauthOk ? (
                  <Btn
                    variant="primary"
                    icon={busy ? Loader2 : LogIn}
                    disabled={busy}
                    onClick={() => void oauthLogin(pick.oauth!)}
                  >
                    {busy
                      ? t("mail.waitBrowser")
                      : t("mail.signInBrowser", { provider: pick.label })}
                  </Btn>
                ) : (
                  <div className="mail-hint">
                    {t("mail.oauthNotConfigured", { provider: pick.label })}{" "}
                    <button className="mail-link" onClick={() => onOpenSettings("oauth")}>
                      {t("mail.openOauthSettings")}
                    </button>
                  </div>
                )}
                <button className="mail-link" onClick={() => setUsePass(true)}>
                  {t("mail.usePassword")}
                </button>
              </>
            ) : (
              <>
                {pick.id !== "other" && (
                  <div className="mail-steps">
                    <div className="mail-form-title">{t("mail.appPasswordTitle")}</div>
                    <div className="mail-hint">{t("mail.appPasswordWhat")}</div>
                    {providerHint && <div className="mail-hint">{providerHint}</div>}
                    <div className="mail-row-gap">
                      {pick.passUrl && (
                        <Btn icon={ExternalLink} onClick={() => openExternal(pick.passUrl!)}>
                          {t("mail.openPassPage")}
                        </Btn>
                      )}
                      {pick.imapUrl && (
                        <Btn icon={ExternalLink} onClick={() => openExternal(pick.imapUrl!)}>
                          {t("mail.openImapPage")}
                        </Btn>
                      )}
                    </div>
                  </div>
                )}
                <Field label={t("mail.email")}>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={() => void guess()}
                    placeholder={pick.sample}
                    autoFocus
                  />
                </Field>
                <Field label={t("mail.accountName")}>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label={pick.id === "other" ? t("mail.password") : t("mail.appPassword")}>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <button className="mail-link" onClick={() => setAdvanced((v) => !v)}>
                  {advanced ? t("mail.hideServers") : t("mail.showServers")}
                </button>
                {advanced && (
                  <div className="mail-grid2">
                    <Field label="IMAP">
                      <input
                        value={srv.imapHost}
                        onChange={(e) => setSrv({ ...srv, imapHost: e.target.value })}
                      />
                    </Field>
                    <Field label={t("mail.port")}>
                      <input
                        value={srv.imapPort}
                        onChange={(e) => setSrv({ ...srv, imapPort: num(e.target.value) })}
                      />
                    </Field>
                    <Field label="SMTP">
                      <input
                        value={srv.smtpHost}
                        onChange={(e) => setSrv({ ...srv, smtpHost: e.target.value })}
                      />
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
                {busy && <div className="mail-hint">{t("mail.checking")}</div>}
                <div className="mail-actions">
                  <Btn
                    variant="primary"
                    onClick={() => void connect()}
                    disabled={busy || !email || !password}
                  >
                    {busy ? <Loader2 size={14} className="spin" /> : null}
                    {busy ? t("mail.connecting") : t("mail.connect")}
                  </Btn>
                </div>
              </>
            )}
            {err && <div className="mail-err">{err}</div>}
          </div>
        )}

        {accounts.length > 0 && !closeOnAdd && (
          <div className="mail-actions">
            <Btn variant="primary" onClick={onClose}>
              {t("mail.done")}
            </Btn>
          </div>
        )}
      </Glass>
    </div>
  );
}
