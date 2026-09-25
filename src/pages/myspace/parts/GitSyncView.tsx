import { useEffect, useState } from "react";
import {
  RefreshCw,
  Save,
  GitBranch,
  AlertTriangle,
  Check,
  Lock,
  Plug,
  User,
  Mail,
  KeyRound,
  Link2,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { NotesGitConfig, NotesGitSyncResult, NotesGitTestResult } from "@/api/types";

/**
 * Git-синхронизация заметок/канваса (storage/vault/) через isomorphic-git
 * (server/ts/notesGit.ts). Закладки НЕ входят в область синка (отдельный
 * JSON-файл вне vault) — см. комментарий в notesGit.ts.
 */
export default function GitSyncView() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<NotesGitConfig | null>(null);
  const [form, setForm] = useState({
    remoteUrl: "",
    branch: "main",
    authorName: "",
    authorEmail: "",
    token: "",
  });
  const [status, setStatus] = useState<{ dirty: boolean; files: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<NotesGitSyncResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NotesGitTestResult | null>(null);

  const load = async () => {
    const c = await api.notesGitConfig();
    setCfg(c);
    setForm({
      remoteUrl: c.remoteUrl,
      branch: c.branch,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      token: "",
    });
    try {
      setStatus(await api.notesGitStatus());
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const saveConfig = async () => {
    setSaving(true);
    try {
      await api.notesGitSetConfig({
        remoteUrl: form.remoteUrl,
        branch: form.branch,
        authorName: form.authorName,
        authorEmail: form.authorEmail,
        token: form.token || undefined,
      });
      setForm((f) => ({ ...f, token: "" }));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.notesGitTest());
    } finally {
      setTesting(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    setLastResult(null);
    try {
      const r = await api.notesGitSync();
      setLastResult(r);
      await load();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page git-sync-page" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <SectionHead eyebrow={t("myspace.syncTab")} title={t("gitSync.title")} />
      <div className="muted-sm" style={{ marginBottom: 12 }}>
        {t("gitSync.hint")}
      </div>

      <Glass className="chart-panel git-sync-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <div className="git-sync-section-title">
          <Link2 size={14} /> {t("gitSync.sectionRepo")}
        </div>
        <label className="git-sync-field">
          <span className="muted-sm">{t("gitSync.fRemoteUrl")}</span>
          <input
            className="text-input"
            placeholder="https://github.com/user/repo.git"
            value={form.remoteUrl}
            onChange={(e) => setForm((f) => ({ ...f, remoteUrl: e.target.value }))}
          />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="git-sync-field" style={{ width: 140 }}>
            <span className="muted-sm">{t("gitSync.fBranch")}</span>
            <input
              className="text-input"
              value={form.branch}
              onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
            />
          </label>
          <label className="git-sync-field" style={{ flex: 1 }}>
            <span className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <User size={11} /> {t("gitSync.fAuthorName")}
            </span>
            <input
              className="text-input"
              value={form.authorName}
              onChange={(e) => setForm((f) => ({ ...f, authorName: e.target.value }))}
            />
          </label>
        </div>
        <label className="git-sync-field">
          <span className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Mail size={11} /> {t("gitSync.fAuthorEmail")}
          </span>
          <input
            className="text-input"
            value={form.authorEmail}
            onChange={(e) => setForm((f) => ({ ...f, authorEmail: e.target.value }))}
          />
        </label>

        <div className="git-sync-section-title" style={{ marginTop: 6 }}>
          <Lock size={14} /> {t("gitSync.sectionPrivate")}
        </div>
        <div className="muted-sm">{t("gitSync.privateHint")}</div>
        <label className="git-sync-field">
          <span className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <KeyRound size={11} /> {t("gitSync.fToken")}
          </span>
          <input
            className="text-input"
            type="password"
            placeholder={cfg?.hasToken ? t("gitSync.fTokenSet") : t("gitSync.fTokenPlaceholder")}
            value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
          />
        </label>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Btn variant="primary" icon={Save} disabled={saving} onClick={() => void saveConfig()}>
            {t("gitSync.save")}
          </Btn>
          <Btn icon={testing ? RefreshCw : Plug} disabled={testing || !form.remoteUrl} onClick={() => void testConnection()}>
            {testing ? t("gitSync.testing") : t("gitSync.testConnection")}
          </Btn>
          {cfg?.hasToken && (
            <Badge tone="teal" mono>
              {t("gitSync.tokenSet")}
            </Badge>
          )}
        </div>

        {testResult && (
          <div
            className="git-sync-testresult"
            style={{ color: testResult.ok ? "var(--success)" : "var(--coral)" }}
          >
            {testResult.ok ? (
              <>
                <Check size={14} />
                {testResult.usedAuth
                  ? t("gitSync.testOkPrivate", { n: testResult.branches?.length ?? 0 })
                  : t("gitSync.testOkPublic", { n: testResult.branches?.length ?? 0 })}
              </>
            ) : (
              <>
                <AlertTriangle size={14} />
                {testResult.error}
              </>
            )}
          </div>
        )}
      </Glass>

      <Glass
        className="chart-panel git-sync-card"
        style={{ marginTop: 12, flexDirection: "column", alignItems: "stretch", gap: 10 }}
      >
        <div className="git-sync-section-title">
          <GitBranch size={14} /> {t("gitSync.sectionSync")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge tone={status?.dirty ? "amber" : "teal"} mono>
            {status ? (status.dirty ? t("gitSync.dirty", { n: status.files }) : t("gitSync.clean")) : "—"}
          </Badge>
        </div>
        {cfg?.lastSyncAt && (
          <div className="muted-sm">
            {t("gitSync.lastSync", { when: new Date(cfg.lastSyncAt).toLocaleString() })}
          </div>
        )}
        <Btn
          variant="primary"
          icon={syncing ? RefreshCw : GitBranch}
          disabled={syncing || !cfg?.remoteUrl}
          onClick={() => void runSync()}
          style={{ width: 200 }}
        >
          {syncing ? t("gitSync.syncing") : t("gitSync.syncNow")}
        </Btn>

        {lastResult && !lastResult.ok && lastResult.conflict && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "var(--coral)" }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{t("gitSync.conflictHint")}</span>
          </div>
        )}
        {lastResult && !lastResult.ok && !lastResult.conflict && (
          <div style={{ color: "var(--coral)" }}>{lastResult.error}</div>
        )}
        {lastResult && lastResult.ok && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--success)" }}>
            <Check size={15} /> {t("gitSync.syncOk")}
          </div>
        )}
      </Glass>
    </div>
  );
}
