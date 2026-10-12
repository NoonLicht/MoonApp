import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, Loader2, Plus, Trash2, Upload, X } from "lucide-react";
import { Btn, Glass, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  MailAccount,
  MailAutoReply,
  MailRule,
  MailRuleAction,
  MailRuleCondition,
  MailSettings,
  MailSignature,
  MailTemplate,
  MailTrackItem,
} from "@/api/apiMail";
import { fmtDate, toLocalInput } from "@/pages/mail/parts/mailUtil";

const TABS = [
  "general",
  "notifications",
  "identities",
  "rules",
  "autoreply",
  "templates",
  "smart",
  "tracking",
  "ai",
  "mcp",
  "oauth",
  "backup",
] as const;
export type MailSettingsTab = (typeof TABS)[number];

/* ---------------------------- мелкие поля -------------------------------- */

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mail-set-row">
      <div className="mail-set-label">
        <span>{label}</span>
        {hint && <em>{hint}</em>}
      </div>
      <div className="mail-set-ctl">{children}</div>
    </div>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="mail-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Текстовое поле: правка локальна, значение уходит на сервер при потере фокуса. */
function Txt({
  value,
  onCommit,
  placeholder,
  multiline,
  type,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  type?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const common = {
    value: v,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => v !== value && onCommit(v),
  };
  return multiline ? <textarea rows={5} {...common} /> : <input type={type} {...common} />;
}

/* ------------------------------ диалог ----------------------------------- */

export function MailSettingsDialog({
  accounts,
  initialTab,
  onClose,
  onChanged,
}: {
  accounts: MailAccount[];
  initialTab?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<MailSettingsTab>(
    (TABS as readonly string[]).includes(initialTab ?? "") ? (initialTab as MailSettingsTab) : "general",
  );
  const [s, setS] = useState<MailSettings | null>(null);
  const [sigs, setSigs] = useState<MailSignature[]>([]);
  const [tpls, setTpls] = useState<MailTemplate[]>([]);
  const [rules, setRules] = useState<MailRule[]>([]);
  const [tracks, setTracks] = useState<MailTrackItem[]>([]);
  const [msg, setMsg] = useState("");
  const [newKey, setNewKey] = useState("");
  const [mcpState, setMcpState] = useState<{ running: boolean; port: number } | null>(null);

  const reload = useCallback(async () => {
    setS(await api.mailSettings());
    setSigs(await api.mailSignatures());
    setTpls(await api.mailTemplates());
    setRules(await api.mailRules());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (tab === "tracking") api.mailTracking().then(setTracks).catch(() => undefined);
    if (tab === "mcp") api.mailMcpStatus().then(setMcpState).catch(() => undefined);
  }, [tab]);

  const save = async (patch: Record<string, unknown>) => {
    setS(await api.mailSaveSettings(patch));
    onChanged();
  };
  const upd = <K extends keyof MailSettings>(k: K, p: Partial<MailSettings[K]>) =>
    s && void save({ [k]: p });

  if (!s) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <Glass className="modal-panel mail-settings">
          <Loader2 className="spin" />
        </Glass>
      </div>
    );
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setMsg(t("mail.copied"));
    setTimeout(() => setMsg(""), 1500);
  };

  const body = (() => {
    switch (tab) {
      case "general":
        return (
          <>
            <Row label={t("mail.set_bodyTheme")} hint={t("mail.set_bodyThemeHint")}>
              <Select
                value={s.appearance.bodyTheme}
                onChange={(e) => upd("appearance", { bodyTheme: e.target.value as "auto" })}
                options={[
                  { value: "auto", label: t("mail.theme_auto") },
                  { value: "light", label: t("mail.theme_light") },
                  { value: "dark", label: t("mail.theme_dark") },
                ]}
              />
            </Row>
            <Row label={t("mail.set_density")}>
              <Select
                value={s.appearance.density}
                onChange={(e) => upd("appearance", { density: e.target.value as "cozy" })}
                options={[
                  { value: "cozy", label: t("mail.density_cozy") },
                  { value: "compact", label: t("mail.density_compact") },
                ]}
              />
            </Row>
            <Row label={t("mail.set_fontSize")}>
              <div className="lg-slider">
                <input
                  type="range"
                  min={12}
                  max={20}
                  value={s.appearance.fontSize}
                  onChange={(e) => upd("appearance", { fontSize: Number(e.target.value) })}
                />
                <span className="lg-val">{s.appearance.fontSize}px</span>
              </div>
            </Row>
            <Row label={t("mail.set_avatars")} hint={t("mail.set_avatarsHint")}>
              <Select
                value={s.appearance.avatars}
                onChange={(e) => upd("appearance", { avatars: e.target.value as "initials" })}
                options={[
                  { value: "initials", label: t("mail.avatars_initials") },
                  { value: "gravatar", label: "Gravatar" },
                  { value: "off", label: t("mail.avatars_off") },
                ]}
              />
            </Row>
            <Row label={t("mail.set_sendDelay")} hint={t("mail.set_sendDelayHint")}>
              <Select
                value={String(s.appearance.sendDelaySec)}
                onChange={(e) => upd("appearance", { sendDelaySec: Number(e.target.value) })}
                options={["0", "5", "8", "15", "30"].map((v) => ({ value: v, label: `${v} ${t("mail.sec")}` }))}
              />
            </Row>
            <Check
              checked={s.appearance.threads}
              onChange={(v) => upd("appearance", { threads: v })}
              label={t("mail.set_threads")}
            />
            <Check
              checked={s.appearance.refreshOnFocus}
              onChange={(v) => upd("appearance", { refreshOnFocus: v })}
              label={t("mail.set_refreshOnFocus")}
            />
            <Check
              checked={s.appearance.markReadOnOpen}
              onChange={(v) => upd("appearance", { markReadOnOpen: v })}
              label={t("mail.set_markRead")}
            />
            <Check
              checked={s.appearance.composeMarkdown}
              onChange={(v) => upd("appearance", { composeMarkdown: v })}
              label={t("mail.set_composeMarkdown")}
            />
          </>
        );
      case "notifications":
        return (
          <>
            <Check checked={s.notify.enabled} onChange={(v) => upd("notify", { enabled: v })} label={t("mail.n_enabled")} />
            <Check checked={s.notify.preview} onChange={(v) => upd("notify", { preview: v })} label={t("mail.n_preview")} />
            <Check checked={s.notify.sound} onChange={(v) => upd("notify", { sound: v })} label={t("mail.n_sound")} />
            <Check checked={s.notify.badge} onChange={(v) => upd("notify", { badge: v })} label={t("mail.n_badge")} />
            <Check
              checked={s.notify.quietEnabled}
              onChange={(v) => upd("notify", { quietEnabled: v })}
              label={t("mail.n_quiet")}
            />
            {s.notify.quietEnabled && (
              <Row label={t("mail.n_quietRange")}>
                <div className="mail-row-gap">
                  <input
                    type="time"
                    value={s.notify.quietFrom}
                    onChange={(e) => upd("notify", { quietFrom: e.target.value })}
                  />
                  <span>—</span>
                  <input
                    type="time"
                    value={s.notify.quietTo}
                    onChange={(e) => upd("notify", { quietTo: e.target.value })}
                  />
                </div>
              </Row>
            )}
            <div className="mail-set-sub">{t("mail.n_perAccount")}</div>
            {accounts.map((a) => (
              <Check
                key={a.id}
                checked={!s.notify.muted.includes(a.id)}
                onChange={(v) =>
                  upd("notify", {
                    muted: v ? s.notify.muted.filter((x) => x !== a.id) : [...s.notify.muted, a.id],
                  })
                }
                label={a.email}
              />
            ))}
          </>
        );
      case "identities":
        return (
          <IdentitiesTab accounts={accounts} sigs={sigs} setSigs={setSigs} onChanged={onChanged} />
        );
      case "rules":
        return <RulesTab rules={rules} setRules={setRules} accounts={accounts} />;
      case "autoreply":
        return (
          <>
            {accounts.map((a) => (
              <AutoReplyBlock
                key={a.id}
                account={a}
                value={s.autoReply[a.id]}
                onSave={(v) => void save({ autoReply: { ...s.autoReply, [a.id]: v } })}
              />
            ))}
          </>
        );
      case "templates":
        return <TemplatesTab tpls={tpls} setTpls={setTpls} />;
      case "smart":
        return (
          <SmartTab
            s={s}
            accounts={accounts}
            onSave={(list) => void save({ smartFolders: list })}
            onSavePinned={(list) => void save({ pinned: list })}
          />
        );
      case "tracking":
        return (
          <>
            <p className="mail-hint">{t("mail.tr_intro")}</p>
            <Check
              checked={s.tracking.enabled}
              onChange={(v) => upd("tracking", { enabled: v })}
              label={t("mail.tr_enabled")}
            />
            <Row label={t("mail.tr_base")} hint="https://mail-track.example.workers.dev">
              <Txt value={s.tracking.base} onCommit={(v) => upd("tracking", { base: v.trim() })} />
            </Row>
            <Row label={t("mail.tr_key")}>
              <div className="mail-row-gap">
                <Txt
                  value={s.tracking.key}
                  type="password"
                  onCommit={(v) => upd("tracking", { key: v.trim() })}
                />
                <Btn
                  onClick={async () => {
                    const r = await api.mailGenerateKey("tracking");
                    setNewKey(r.key);
                    void reload();
                  }}
                >
                  {t("mail.generate")}
                </Btn>
              </div>
            </Row>
            {newKey && (
              <div className="mail-hint">
                {t("mail.keyOnce")} <code>{newKey}</code>{" "}
                <button className="mail-link" onClick={() => copy(newKey)}>
                  {t("mail.copy")}
                </button>
              </div>
            )}
            <Check checked={s.tracking.opens} onChange={(v) => upd("tracking", { opens: v })} label={t("mail.tr_opens")} />
            <Check checked={s.tracking.clicks} onChange={(v) => upd("tracking", { clicks: v })} label={t("mail.tr_clicks")} />
            <div className="mail-row-gap">
              <Btn
                icon={Copy}
                onClick={async () => {
                  const w = await api.mailTrackingWorker();
                  copy(w.code);
                }}
              >
                {t("mail.tr_copyWorker")}
              </Btn>
              <Btn onClick={() => api.mailTracking().then(setTracks)}>{t("mail.refresh")}</Btn>
            </div>
            <div className="mail-set-sub">{t("mail.tr_list")}</div>
            {tracks.length === 0 && <div className="mail-hint">{t("mail.tr_empty")}</div>}
            {tracks.map((x) => (
              <div key={x.trackId} className="mail-track">
                <b>{x.subject || t("mail.noSubject")}</b>
                <span>
                  {x.to.join(", ")} · {fmtDate(x.sent, lang, true)}
                </span>
                <span>
                  {t("mail.tr_opened", { n: x.opens })} · {t("mail.tr_clicked", { n: x.clicks })}
                  {x.lastOpen ? ` · ${fmtDate(x.lastOpen, lang, true)}` : ""}
                </span>
              </div>
            ))}
          </>
        );
      case "ai":
        return (
          <>
            <Check checked={s.ai.enabled} onChange={(v) => upd("ai", { enabled: v })} label={t("mail.ai_enabled")} />
            <Row label={t("mail.ai_language")} hint={t("mail.ai_languageHint")}>
              <Select
                value={s.ai.language}
                onChange={(e) => upd("ai", { language: e.target.value })}
                options={[
                  { value: "", label: t("mail.ai_auto") },
                  { value: "ru", label: "Русский" },
                  { value: "en", label: "English" },
                  { value: "es", label: "Español" },
                  { value: "fr", label: "Français" },
                  { value: "zh", label: "中文" },
                  { value: "ar", label: "العربية" },
                ]}
              />
            </Row>
            <Row label={t("mail.ai_tone")}>
              <Select
                value={s.ai.tone}
                onChange={(e) => upd("ai", { tone: e.target.value })}
                options={["neutral", "formal", "friendly", "brief"].map((v) => ({
                  value: v,
                  label: t(`mail.tone_${v}`),
                }))}
              />
            </Row>
            <p className="mail-hint">{t("mail.ai_note")}</p>
          </>
        );
      case "mcp": {
        const url = `http://127.0.0.1:${s.mcp.port}/mcp`;
        const cfg = JSON.stringify(
          {
            mcpServers: {
              "moonapp-mail": {
                command: "npx",
                args: ["-y", "mcp-remote", url, "--header", "Authorization: Bearer <KEY>"],
              },
            },
          },
          null,
          2,
        );
        return (
          <>
            <p className="mail-hint">{t("mail.mcp_intro")}</p>
            <Check checked={s.mcp.enabled} onChange={(v) => upd("mcp", { enabled: v })} label={t("mail.mcp_enabled")} />
            <Row label={t("mail.port")}>
              <Txt
                value={String(s.mcp.port)}
                onCommit={(v) => upd("mcp", { port: Math.min(65535, Math.max(1024, Number(v) || 38417)) })}
              />
            </Row>
            <Row label={t("mail.tr_key")}>
              <Btn
                onClick={async () => {
                  const r = await api.mailGenerateKey("mcp");
                  setNewKey(r.key);
                  void reload();
                }}
              >
                {s.mcp.key ? t("mail.regenerate") : t("mail.generate")}
              </Btn>
            </Row>
            {newKey && (
              <div className="mail-hint">
                {t("mail.keyOnce")} <code>{newKey}</code>{" "}
                <button className="mail-link" onClick={() => copy(newKey)}>
                  {t("mail.copy")}
                </button>
              </div>
            )}
            <Check checked={s.mcp.allowSend} onChange={(v) => upd("mcp", { allowSend: v })} label={t("mail.mcp_allowSend")} />
            <div className="mail-hint">
              {mcpState?.running ? t("mail.mcp_running", { port: mcpState.port }) : t("mail.mcp_stopped")}
            </div>
            <div className="mail-set-sub">{t("mail.mcp_config")}</div>
            <pre className="mail-code">{cfg}</pre>
            <Btn icon={Copy} onClick={() => copy(cfg)}>
              {t("mail.copy")}
            </Btn>
          </>
        );
      }
      case "oauth":
        return (
          <>
            <p className="mail-hint">{t("mail.oauth_intro")}</p>
            <Row label="Google Client ID" hint={t("mail.oauth_googleHint")}>
              <Txt value={s.oauth.googleClientId} onCommit={(v) => upd("oauth", { googleClientId: v.trim() })} />
            </Row>
            <Row label="Google Client secret">
              <Txt
                value={s.oauth.googleClientSecret}
                type="password"
                onCommit={(v) => upd("oauth", { googleClientSecret: v.trim() })}
              />
            </Row>
            <Row label="Microsoft Application (client) ID" hint={t("mail.oauth_msHint")}>
              <Txt
                value={s.oauth.microsoftClientId}
                onCommit={(v) => upd("oauth", { microsoftClientId: v.trim() })}
              />
            </Row>
            <p className="mail-hint">{t("mail.oauth_redirect")}</p>
          </>
        );
      case "backup":
        return <BackupTab accounts={accounts} onDone={() => void reload()} />;
      default:
        return null;
    }
  })();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Glass className="modal-panel mail-settings" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="mail-modal-head">
          <div className="media-title">{t("mail.settings")}</div>
          <div className="mail-row-gap">
            {msg && <span className="mail-dim">{msg}</span>}
            <button className="mail-x" onClick={onClose} aria-label="close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="mail-set-layout">
          <nav className="mail-set-tabs">
            {TABS.map((k) => (
              <button key={k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
                {t(`mail.tab_${k}`)}
              </button>
            ))}
          </nav>
          <div className="mail-set-body">{body}</div>
        </div>
      </Glass>
    </div>
  );
}

/* ------------------------------ вкладки ---------------------------------- */

function IdentitiesTab({
  accounts,
  sigs,
  setSigs,
  onChanged,
}: {
  accounts: MailAccount[];
  sigs: MailSignature[];
  setSigs: (s: MailSignature[]) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<MailSignature | null>(null);

  const saveSig = async () => {
    if (!editing?.name.trim()) return;
    const r = await api.mailSaveSignature(editing);
    setSigs([...sigs.filter((x) => x.id !== r.id), r].sort((a, b) => a.name.localeCompare(b.name)));
    setEditing(null);
  };

  const sigOptions = [{ value: "", label: t("mail.noSignature") }, ...sigs.map((x) => ({ value: x.id, label: x.name }))];

  return (
    <>
      <div className="mail-set-sub">{t("mail.signatures")}</div>
      {sigs.map((x) => (
        <div key={x.id} className="mail-acc-row">
          <div className="mail-acc-main">
            <b>{x.name}</b>
          </div>
          <Btn onClick={() => setEditing(x)}>{t("mail.edit")}</Btn>
          <button
            className="mail-x"
            aria-label={t("mail.remove")}
            onClick={async () => {
              await api.mailRemoveSignature(x.id);
              setSigs(sigs.filter((y) => y.id !== x.id));
              onChanged();
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {editing ? (
        <div className="mail-edit-box">
          <input
            value={editing.name}
            placeholder={t("mail.sigName")}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <textarea
            rows={6}
            value={editing.html}
            placeholder={t("mail.sigHtml")}
            onChange={(e) => setEditing({ ...editing, html: e.target.value })}
          />
          <div className="mail-row-gap">
            <Btn variant="primary" onClick={() => void saveSig()}>
              {t("mail.save")}
            </Btn>
            <Btn onClick={() => setEditing(null)}>{t("mail.cancel")}</Btn>
          </div>
        </div>
      ) : (
        <Btn icon={Plus} onClick={() => setEditing({ id: "", name: "", html: "" })}>
          {t("mail.addSignature")}
        </Btn>
      )}

      <div className="mail-set-sub">{t("mail.senderProfiles")}</div>
      {accounts.map((a) => (
        <div key={a.id} className="mail-edit-box">
          <b>{a.email}</b>
          <Row label={t("mail.defaultSignature")}>
            <Select
              value={a.defaultSignature}
              onChange={(e) =>
                void api.mailUpdateAccount(a.id, { defaultSignature: e.target.value }).then(onChanged)
              }
              options={sigOptions}
            />
          </Row>
          {a.aliases.map((al, i) => (
            <div key={i} className="mail-alias-row">
              <input
                defaultValue={al.name}
                placeholder={t("mail.accountName")}
                onBlur={(e) => {
                  const next = a.aliases.map((x, j) => (j === i ? { ...x, name: e.target.value } : x));
                  void api.mailUpdateAccount(a.id, { aliases: next }).then(onChanged);
                }}
              />
              <input
                defaultValue={al.address}
                placeholder="alias@example.com"
                onBlur={(e) => {
                  const next = a.aliases.map((x, j) => (j === i ? { ...x, address: e.target.value } : x));
                  void api.mailUpdateAccount(a.id, { aliases: next }).then(onChanged);
                }}
              />
              <Select
                value={al.signature ?? ""}
                onChange={(e) => {
                  const next = a.aliases.map((x, j) => (j === i ? { ...x, signature: e.target.value } : x));
                  void api.mailUpdateAccount(a.id, { aliases: next }).then(onChanged);
                }}
                options={sigOptions}
              />
              <button
                className="mail-x"
                aria-label={t("mail.remove")}
                onClick={() =>
                  void api
                    .mailUpdateAccount(a.id, { aliases: a.aliases.filter((_, j) => j !== i) })
                    .then(onChanged)
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <Btn
            icon={Plus}
            onClick={() =>
              void api
                .mailUpdateAccount(a.id, { aliases: [...a.aliases, { name: a.name, address: "" }] })
                .then(onChanged)
            }
          >
            {t("mail.addAlias")}
          </Btn>
        </div>
      ))}
    </>
  );
}

const FIELDS: MailRuleCondition["field"][] = ["from", "to", "cc", "subject", "body", "hasAttachment", "list", "size"];
const OPS: MailRuleCondition["op"][] = ["contains", "notContains", "equals", "startsWith", "endsWith", "regex"];
const ACTS: MailRuleAction["type"][] = ["move", "markRead", "star", "archive", "trash", "spam", "snooze", "label"];

function RulesTab({
  rules,
  setRules,
  accounts,
}: {
  rules: MailRule[];
  setRules: (r: MailRule[]) => void;
  accounts: MailAccount[];
}) {
  const { t } = useI18n();
  const [edit, setEdit] = useState<MailRule | null>(null);
  const [info, setInfo] = useState("");
  const blank = (): MailRule => ({
    id: "",
    account: "",
    name: "",
    enabled: true,
    matchAll: true,
    conditions: [{ field: "from", op: "contains", value: "" }],
    actions: [{ type: "archive" }],
    position: 0,
  });

  const save = async () => {
    if (!edit?.name.trim()) return;
    const r = await api.mailSaveRule(edit);
    setRules([...rules.filter((x) => x.id !== r.id), r].sort((a, b) => a.position - b.position));
    setEdit(null);
  };

  return (
    <>
      <p className="mail-hint">{t("mail.rules_intro")}</p>
      {rules.map((r) => (
        <div key={r.id} className="mail-acc-row">
          <label className="mail-check">
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={async (e) => {
                const n = await api.mailSaveRule({ ...r, enabled: e.target.checked });
                setRules(rules.map((x) => (x.id === n.id ? n : x)));
              }}
            />
          </label>
          <div className="mail-acc-main">
            <b>{r.name}</b>
            <span>
              {r.conditions.map((c) => `${t(`mail.f_${c.field}`)} ${c.value}`).join(r.matchAll ? " & " : " | ")}
            </span>
          </div>
          <Btn onClick={() => setEdit(r)}>{t("mail.edit")}</Btn>
          <button
            className="mail-x"
            aria-label={t("mail.remove")}
            onClick={async () => {
              await api.mailRemoveRule(r.id);
              setRules(rules.filter((x) => x.id !== r.id));
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {edit ? (
        <div className="mail-edit-box">
          <input
            value={edit.name}
            placeholder={t("mail.ruleName")}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <div className="mail-row-gap">
            <Select
              value={edit.account}
              onChange={(e) => setEdit({ ...edit, account: e.target.value })}
              options={[
                { value: "", label: t("mail.allAccounts") },
                ...accounts.map((a) => ({ value: a.id, label: a.email })),
              ]}
            />
            <Select
              value={edit.matchAll ? "all" : "any"}
              onChange={(e) => setEdit({ ...edit, matchAll: e.target.value === "all" })}
              options={[
                { value: "all", label: t("mail.matchAll") },
                { value: "any", label: t("mail.matchAny") },
              ]}
            />
          </div>
          {edit.conditions.map((c, i) => (
            <div key={i} className="mail-alias-row">
              <Select
                value={c.field}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    conditions: edit.conditions.map((x, j) =>
                      j === i ? { ...x, field: e.target.value as MailRuleCondition["field"] } : x,
                    ),
                  })
                }
                options={FIELDS.map((f) => ({ value: f, label: t(`mail.f_${f}`) }))}
              />
              {!["hasAttachment", "list", "size"].includes(c.field) && (
                <Select
                  value={c.op}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      conditions: edit.conditions.map((x, j) =>
                        j === i ? { ...x, op: e.target.value as MailRuleCondition["op"] } : x,
                      ),
                    })
                  }
                  options={OPS.map((o) => ({ value: o, label: t(`mail.op_${o}`) }))}
                />
              )}
              {c.field === "size" && (
                <Select
                  value={c.op}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      conditions: edit.conditions.map((x, j) =>
                        j === i ? { ...x, op: e.target.value as MailRuleCondition["op"] } : x,
                      ),
                    })
                  }
                  options={[
                    { value: "gt", label: t("mail.op_gt") },
                    { value: "lt", label: t("mail.op_lt") },
                  ]}
                />
              )}
              {!["hasAttachment", "list"].includes(c.field) && (
                <input
                  value={c.value}
                  placeholder={c.field === "size" ? "KB" : ""}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      conditions: edit.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    })
                  }
                />
              )}
              <button
                className="mail-x"
                aria-label={t("mail.remove")}
                onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_, j) => j !== i) })}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <Btn
            icon={Plus}
            onClick={() =>
              setEdit({ ...edit, conditions: [...edit.conditions, { field: "subject", op: "contains", value: "" }] })
            }
          >
            {t("mail.addCondition")}
          </Btn>
          <div className="mail-set-sub">{t("mail.thenDo")}</div>
          {edit.actions.map((a, i) => (
            <div key={i} className="mail-alias-row">
              <Select
                value={a.type}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    actions: edit.actions.map((x, j) =>
                      j === i ? { ...x, type: e.target.value as MailRuleAction["type"] } : x,
                    ),
                  })
                }
                options={ACTS.map((x) => ({ value: x, label: t(`mail.a_${x}`) }))}
              />
              {["move", "snooze", "label"].includes(a.type) && (
                <input
                  value={a.value ?? ""}
                  placeholder={
                    a.type === "move" ? t("mail.folderPath") : a.type === "snooze" ? t("mail.hours") : t("mail.label")
                  }
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      actions: edit.actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    })
                  }
                />
              )}
              <button
                className="mail-x"
                aria-label={t("mail.remove")}
                onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <Btn icon={Plus} onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: "markRead" }] })}>
            {t("mail.addAction")}
          </Btn>
          <div className="mail-row-gap">
            <Btn variant="primary" onClick={() => void save()}>
              {t("mail.save")}
            </Btn>
            <Btn onClick={() => setEdit(null)}>{t("mail.cancel")}</Btn>
          </div>
        </div>
      ) : (
        <div className="mail-row-gap">
          <Btn icon={Plus} onClick={() => setEdit(blank())}>
            {t("mail.addRule")}
          </Btn>
          <Btn
            onClick={async () => {
              const r = await api.mailRunRules();
              setInfo(t("mail.rulesMatched", { n: r.matched }));
            }}
          >
            {t("mail.runRules")}
          </Btn>
          {info && <span className="mail-dim">{info}</span>}
        </div>
      )}
    </>
  );
}

function AutoReplyBlock({
  account,
  value,
  onSave,
}: {
  account: MailAccount;
  value: MailAutoReply | undefined;
  onSave: (v: MailAutoReply) => void;
}) {
  const { t } = useI18n();
  const v: MailAutoReply = value ?? { enabled: false, subject: "", body: "", from: 0, to: 0, onlyKnown: false };
  return (
    <div className="mail-edit-box">
      <b>{account.email}</b>
      <Check checked={v.enabled} onChange={(x) => onSave({ ...v, enabled: x })} label={t("mail.ar_enabled")} />
      <Row label={t("mail.subject")}>
        <Txt value={v.subject} onCommit={(x) => onSave({ ...v, subject: x })} placeholder={t("mail.ar_subjectHint")} />
      </Row>
      <Row label={t("mail.ar_text")}>
        <Txt value={v.body} multiline onCommit={(x) => onSave({ ...v, body: x })} />
      </Row>
      <Row label={t("mail.ar_period")} hint={t("mail.ar_periodHint")}>
        <div className="mail-row-gap">
          <input
            type="datetime-local"
            value={v.from ? toLocalInput(v.from) : ""}
            onChange={(e) => onSave({ ...v, from: e.target.value ? new Date(e.target.value).getTime() : 0 })}
          />
          <span>—</span>
          <input
            type="datetime-local"
            value={v.to ? toLocalInput(v.to) : ""}
            onChange={(e) => onSave({ ...v, to: e.target.value ? new Date(e.target.value).getTime() : 0 })}
          />
        </div>
      </Row>
      <Check checked={v.onlyKnown} onChange={(x) => onSave({ ...v, onlyKnown: x })} label={t("mail.ar_onlyKnown")} />
    </div>
  );
}

function TemplatesTab({ tpls, setTpls }: { tpls: MailTemplate[]; setTpls: (l: MailTemplate[]) => void }) {
  const { t } = useI18n();
  const [edit, setEdit] = useState<MailTemplate | null>(null);
  const save = async () => {
    if (!edit?.name.trim()) return;
    const r = await api.mailSaveTemplate(edit);
    setTpls([...tpls.filter((x) => x.id !== r.id), r].sort((a, b) => a.name.localeCompare(b.name)));
    setEdit(null);
  };
  return (
    <>
      {tpls.map((x) => (
        <div key={x.id} className="mail-acc-row">
          <div className="mail-acc-main">
            <b>{x.name}</b>
            <span>{x.subject}</span>
          </div>
          <Btn onClick={() => setEdit(x)}>{t("mail.edit")}</Btn>
          <button
            className="mail-x"
            aria-label={t("mail.remove")}
            onClick={async () => {
              await api.mailRemoveTemplate(x.id);
              setTpls(tpls.filter((y) => y.id !== x.id));
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {edit ? (
        <div className="mail-edit-box">
          <input value={edit.name} placeholder={t("mail.templateName")} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input value={edit.subject} placeholder={t("mail.subject")} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          <textarea rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <div className="mail-row-gap">
            <Btn variant="primary" onClick={() => void save()}>
              {t("mail.save")}
            </Btn>
            <Btn onClick={() => setEdit(null)}>{t("mail.cancel")}</Btn>
          </div>
        </div>
      ) : (
        <Btn icon={Plus} onClick={() => setEdit({ id: "", name: "", subject: "", body: "" })}>
          {t("mail.addTemplate")}
        </Btn>
      )}
    </>
  );
}

function SmartTab({
  s,
  accounts,
  onSave,
  onSavePinned,
}: {
  s: MailSettings;
  accounts: MailAccount[];
  onSave: (l: MailSettings["smartFolders"]) => void;
  onSavePinned: (l: MailSettings["pinned"]) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  return (
    <>
      <p className="mail-hint">{t("mail.smart_intro")}</p>
      {s.smartFolders.map((f) => (
        <div key={f.id} className="mail-acc-row">
          <div className="mail-acc-main">
            <b>{f.name}</b>
            <span>{f.query}</span>
          </div>
          <button
            className="mail-x"
            aria-label={t("mail.remove")}
            onClick={() => onSave(s.smartFolders.filter((x) => x.id !== f.id))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="mail-edit-box">
        <input value={name} placeholder={t("mail.smart_name")} onChange={(e) => setName(e.target.value)} />
        <input
          value={query}
          placeholder="is:unread has:attachment from:ivan"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          options={[
            { value: "", label: t("mail.allAccounts") },
            ...accounts.map((a) => ({ value: a.id, label: a.email })),
          ]}
        />
        <Btn
          icon={Plus}
          disabled={!name.trim() || !query.trim()}
          onClick={() => {
            onSave([...s.smartFolders, { id: crypto.randomUUID(), name: name.trim(), query: query.trim(), account }]);
            setName("");
            setQuery("");
          }}
        >
          {t("mail.smart_add")}
        </Btn>
      </div>
      <div className="mail-set-sub">{t("mail.pinnedFolders")}</div>
      {s.pinned.length === 0 && <div className="mail-hint">{t("mail.pinnedEmpty")}</div>}
      {s.pinned.map((p) => (
        <div key={p.account + p.path} className="mail-acc-row">
          <div className="mail-acc-main">
            <b>{p.name}</b>
            <span>{accounts.find((a) => a.id === p.account)?.email}</span>
          </div>
          <button
            className="mail-x"
            aria-label={t("mail.remove")}
            onClick={() => onSavePinned(s.pinned.filter((x) => !(x.account === p.account && x.path === p.path)))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </>
  );
}

function BackupTab({ accounts, onDone }: { accounts: MailAccount[]; onDone: () => void }) {
  const { t } = useI18n();
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const [folders, setFolders] = useState<{ path: string; name: string }[]>([]);
  const [folder, setFolder] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileJson = useRef<HTMLInputElement>(null);
  const fileEml = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!account) return;
    api
      .mailFolders(account)
      .then((l) => {
        setFolders(l);
        setFolder(l.find((f) => f.path === "INBOX")?.path ?? l[0]?.path ?? "");
      })
      .catch(() => setFolders([]));
  }, [account]);

  const exportJson = async () => {
    const b = await api.mailBackupExport();
    const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "moonapp-mail-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const importJson = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await api.mailBackupImport(JSON.parse(await f.text()));
      setMsg(t("mail.imported", { n: r.rules + r.signatures + r.templates }));
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const importEml = async (files: FileList | null) => {
    if (!files || !account || !folder) return;
    setBusy(true);
    let n = 0;
    try {
      for (const f of Array.from(files)) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const r = await api.mailImportEml(account, folder, btoa(bin));
        n += r.imported;
      }
      setMsg(t("mail.imported", { n }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mail-set-sub">{t("mail.bk_settings")}</div>
      <div className="mail-row-gap">
        <Btn icon={Download} onClick={() => void exportJson()}>
          {t("mail.bk_export")}
        </Btn>
        <Btn icon={Upload} onClick={() => fileJson.current?.click()}>
          {t("mail.bk_import")}
        </Btn>
        <input ref={fileJson} type="file" accept=".json" hidden onChange={(e) => void importJson(e.target.files?.[0])} />
      </div>
      <p className="mail-hint">{t("mail.bk_note")}</p>
      <div className="mail-set-sub">{t("mail.bk_messages")}</div>
      <div className="mail-row-gap">
        <Select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          options={accounts.map((a) => ({ value: a.id, label: a.email }))}
        />
        <Select value={folder} onChange={(e) => setFolder(e.target.value)} options={folders.map((f) => ({ value: f.path, label: f.name }))} />
      </div>
      <div className="mail-row-gap">
        <Btn icon={busy ? Loader2 : Upload} disabled={busy || !folder} onClick={() => fileEml.current?.click()}>
          {t("mail.bk_importEml")}
        </Btn>
        <Btn icon={Download} disabled={!folder} onClick={() => void api.mailExportMbox(account, folder)}>
          {t("mail.bk_exportMbox")}
        </Btn>
        <input
          ref={fileEml}
          type="file"
          accept=".eml,.mbox,message/rfc822"
          multiple
          hidden
          onChange={(e) => void importEml(e.target.files)}
        />
      </div>
      {msg && <div className="mail-dim">{msg}</div>}
    </>
  );
}
