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
  History,
  Undo2,
  FilePlus,
  FileMinus,
  FileDiff,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Glass, Btn, Badge, IconBtn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  NotesGitConfig,
  NotesGitSyncResult,
  NotesGitTestResult,
  NotesGitLogEntry,
  NotesGitDiffResult,
} from "@/api/types";
import { lineDiff } from "@/lib/lineDiff";

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Один файл диффа коммита: заголовок со статусом (+свёртка) и построчный
 * дифф, тем же алгоритмом и раскраской, что и Diff-инструмент на Tools. */
function DiffFileBlock({ file }: { file: NotesGitDiffResult["files"][number] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const Icon = file.status === "added" ? FilePlus : file.status === "deleted" ? FileMinus : FileDiff;
  const tone = file.status === "added" ? "var(--success)" : file.status === "deleted" ? "var(--coral)" : "var(--amber)";
  const lines = file.binary ? null : lineDiff(file.oldText ?? "", file.newText ?? "");

  return (
    <div className="git-sync-diff-file">
      <button type="button" className="git-sync-diff-file-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Icon size={13} style={{ color: tone, flexShrink: 0 }} />
        <span className="git-sync-diff-file-path">{file.path}</span>
      </button>
      {open &&
        (file.binary ? (
          <div className="muted-sm" style={{ padding: "4px 10px" }}>
            {t("gitSync.binaryFile")}
          </div>
        ) : (
          <div className="git-sync-diff-lines">
            {lines?.map((l, i) => (
              <div key={i} className={`git-sync-diff-line is-${l.type}`}>
                <span className="git-sync-diff-mark">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
                {l.text}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * Правая панель: история коммитов vault (как список коммитов на GitHub) +
 * построчный дифф выбранного коммита + откат рабочей копии к нему.
 * Откат НЕ переписывает историю (см. server/ts/notesGit.ts → restoreToCommit):
 * он готовит файлы, а закоммитить и отправить их — обычная «Синхронизация»,
 * которую пользователь запускает сам. Это и есть путь для сценария "второе
 * устройство пишет поверх, затем первое забирает его правки": каждое
 * устройство при синхронизации сначала PULL'ит чужие изменения, потом PUSH'ит
 * свои — историю коммитов видно именно здесь.
 */
function HistoryPanel({ onRestored }: { onRestored: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<NotesGitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<NotesGitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  const loadLog = async () => {
    setLoading(true);
    try {
      setEntries(await api.notesGitLog(50));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadLog();
  }, []);

  const selectCommit = async (oid: string) => {
    setSelected(oid);
    setDiff(null);
    setRestoreMsg(null);
    setDiffLoading(true);
    try {
      setDiff(await api.notesGitDiff(oid));
    } catch {
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const restore = async (oid: string) => {
    if (!window.confirm(t("gitSync.restoreConfirm"))) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      const r = await api.notesGitRestore(oid);
      setRestoreMsg(t("gitSync.restoreDone", { n: r.files }));
      onRestored();
    } catch (e) {
      setRestoreMsg((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Glass
      className="chart-panel git-sync-card git-sync-history"
      style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8 }}
    >
      <div className="git-sync-section-title" style={{ justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <History size={14} /> {t("gitSync.sectionHistory")}
        </span>
        <IconBtn icon={RefreshCw} size={14} title={t("gitSync.refreshHistory")} onClick={() => void loadLog()} />
      </div>
      <div className="muted-sm">{t("gitSync.multiDeviceHint")}</div>

      {loading && <div className="muted-sm">{t("gitSync.historyLoading")}</div>}
      {!loading && entries.length === 0 && <div className="muted-sm">{t("gitSync.historyEmpty")}</div>}

      <div className="git-sync-commit-list">
        {entries.map((e) => (
          <button
            key={e.oid}
            type="button"
            className={`git-sync-commit-item ${selected === e.oid ? "is-active" : ""}`}
            onClick={() => void selectCommit(e.oid)}
          >
            <span className="git-sync-commit-msg">{e.message.split("\n")[0]}</span>
            <span className="muted-sm">
              {e.author} · {fmtWhen(e.timestamp)}
              {e.isMerge ? ` · ${t("gitSync.mergeCommit")}` : ""}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="git-sync-diff-panel">
          <div className="git-sync-diff-toolbar">
            <Btn
              icon={restoring ? RefreshCw : Undo2}
              disabled={restoring}
              onClick={() => void restore(selected)}
            >
              {restoring ? t("gitSync.restoring") : t("gitSync.restoreThis")}
            </Btn>
          </div>
          {restoreMsg && <div className="muted-sm">{restoreMsg}</div>}
          {diffLoading && <div className="muted-sm">{t("gitSync.diffLoading")}</div>}
          {!diffLoading && diff && diff.files.length === 0 && (
            <div className="muted-sm">{t("gitSync.diffEmpty")}</div>
          )}
          {!diffLoading && diff && diff.files.length > 0 && (
            <div className="git-sync-diff-files">
              {diff.files.map((f) => (
                <DiffFileBlock key={f.path} file={f} />
              ))}
            </div>
          )}
        </div>
      )}
    </Glass>
  );
}

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
  const [historyKey, setHistoryKey] = useState(0);

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
      setHistoryKey((k) => k + 1); // коммит мог появиться — перечитать историю
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

      <div className="git-sync-layout">
        <div className="git-sync-col-left">
          <Glass
            className="chart-panel git-sync-card"
            style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}
          >
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
              <label className="git-sync-field" style={{ width: 120 }}>
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

            <div className="git-sync-section-title" style={{ marginTop: 2 }}>
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
              <Btn
                icon={testing ? RefreshCw : Plug}
                disabled={testing || !form.remoteUrl}
                onClick={() => void testConnection()}
              >
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
            style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10 }}
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

        <div className="git-sync-col-right">
          <HistoryPanel key={historyKey} onRestored={() => void load()} />
        </div>
      </div>
    </div>
  );
}
