import { useEffect, useState } from "react";
import { RefreshCw, Save, GitBranch, AlertTriangle, Check } from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { NotesGitConfig, NotesGitSyncResult } from "@/api/types";

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
    <div className="page" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <SectionHead eyebrow={t("myspace.syncTab")} title={t("gitSync.title")} />
      <div className="muted-sm" style={{ marginBottom: 10 }}>
        {t("gitSync.hint")}
      </div>

      <Glass className="chart-panel" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <input
          className="text-input"
          placeholder={t("gitSync.fRemoteUrl")}
          value={form.remoteUrl}
          onChange={(e) => setForm((f) => ({ ...f, remoteUrl: e.target.value }))}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="text-input"
            style={{ width: 140 }}
            placeholder={t("gitSync.fBranch")}
            value={form.branch}
            onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
          />
          <input
            className="text-input"
            style={{ flex: 1 }}
            placeholder={t("gitSync.fAuthorName")}
            value={form.authorName}
            onChange={(e) => setForm((f) => ({ ...f, authorName: e.target.value }))}
          />
        </div>
        <input
          className="text-input"
          placeholder={t("gitSync.fAuthorEmail")}
          value={form.authorEmail}
          onChange={(e) => setForm((f) => ({ ...f, authorEmail: e.target.value }))}
        />
        <input
          className="text-input"
          type="password"
          placeholder={cfg?.hasToken ? t("gitSync.fTokenSet") : t("gitSync.fToken")}
          value={form.token}
          onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Btn icon={Save} disabled={saving} onClick={() => void saveConfig()}>
            {t("gitSync.save")}
          </Btn>
          {cfg?.hasToken && (
            <Badge tone="teal" mono>
              {t("gitSync.tokenSet")}
            </Badge>
          )}
        </div>
      </Glass>

      <Glass
        className="chart-panel"
        style={{ marginTop: 12, flexDirection: "column", alignItems: "stretch", gap: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GitBranch size={16} />
          <span className="muted-sm">
            {status
              ? status.dirty
                ? t("gitSync.dirty", { n: status.files })
                : t("gitSync.clean")
              : "—"}
          </span>
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
