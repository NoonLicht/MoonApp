import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Play, ShieldAlert } from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LinutilNode, LinutilOverview } from "@/api/client";
import PrivacyTab from "@/pages/tuning/parts/PrivacyTab";
import { usePrivacy } from "@/pages/tuning/parts/usePrivacy";

const FALLBACK_TABS = ["system-setup", "applications-setup", "gaming", "security", "utils"];

function matches(n: LinutilNode, q: string): boolean {
  if (!q) return true;
  const hay = `${n.name} ${n.desc ?? ""}`.toLowerCase();
  return hay.includes(q) || (n.children ?? []).some((c) => matches(c, q));
}

/**
 * «Тюнинг ПК» на Linux: каталог скриптов из ChrisTitusTech/linutil (MIT) и
 * вкладка «Приватность». Скрипты запускаются в окне терминала (они интерактивны),
 * на серверной стороне разрешён только id из каталога.
 */
export default function LinuxTuning() {
  const { t } = useI18n();
  const [ov, setOv] = useState<LinutilOverview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("system-setup");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const notify = useCallback((text: string, ok = true) => setMsg({ text, ok }), []);
  const privacy = usePrivacy(notify);

  useEffect(() => {
    api
      .linutilOverview()
      .then((o) => {
        setOv(o);
        setTab((cur) => (o.tabs.some((x) => x.id === cur) ? cur : (o.tabs[0]?.id ?? "privacy")));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = async (n: LinutilNode) => {
    if (!n.id) return;
    if (!window.confirm(t("tuning.lu.confirm", { name: n.name }))) return;
    setBusy(n.id);
    try {
      const r = await api.linutilRun(n.id);
      notify(
        r.ok
          ? t("tuning.lu.launched", { terminal: r.terminal ?? "" })
          : t(`tuning.lu.err.${r.error ?? "unknown"}`),
        r.ok,
      );
    } catch (e) {
      notify((e as Error).message, false);
    } finally {
      setBusy(null);
    }
  };

  const query = q.trim().toLowerCase();
  const current = ov?.tabs.find((x) => x.id === tab);
  const groups = useMemo(
    () => (current?.groups ?? []).filter((g) => matches(g, query)),
    [current, query],
  );

  const entry = (n: LinutilNode, depth: number): React.ReactNode =>
    n.script ? (
      <div key={n.id} className="tn-row">
        <div className="tn-row-main">
          <div className="tn-row-title">{n.name}</div>
          {n.desc && (
            <div className="muted-sm" style={{ whiteSpace: "pre-line" }}>
              {n.desc}
            </div>
          )}
        </div>
        <Btn icon={Play} disabled={busy !== null} onClick={() => void run(n)}>
          {busy === n.id ? t("tuning.working") : t("tuning.fixRun")}
        </Btn>
      </div>
    ) : (
      <div key={n.name} style={{ marginTop: depth ? 8 : 0 }}>
        <div className="muted-sm" style={{ margin: "6px 0 2px" }}>
          {n.name}
        </div>
        {(n.children ?? []).filter((c) => matches(c, query)).map((c) => entry(c, depth + 1))}
      </div>
    );

  if (!ov) {
    return (
      <div className="page">
        <SectionHead eyebrow={t("tuning.eyebrow")} title={t("tuning.title")} />
        <div className="muted-sm">{error || t("tuning.loading")}</div>
      </div>
    );
  }

  const tabs = [...(ov.tabs.length ? ov.tabs.map((x) => x.id) : FALLBACK_TABS), "privacy"];

  return (
    <div className="page tn-page">
      <SectionHead
        eyebrow={t("tuning.eyebrow")}
        title={t("tuning.title")}
        action={ov.distro ? <Badge tone="teal">{ov.distro}</Badge> : undefined}
      />

      {!ov.terminal && (
        <div className="tn-note">
          <ShieldAlert size={14} /> {t("tuning.lu.err.no_terminal")}
        </div>
      )}

      <div className="tn-tabs">
        {tabs.map((k) => (
          <Badge
            key={k}
            tone={tab === k ? "amber" : "neutral"}
            active={tab === k}
            onClick={() => setTab(k)}
          >
            {k === "privacy" ? t("tuning.tab.privacy") : t(`tuning.lu.tab.${k}`)}
          </Badge>
        ))}
      </div>

      {msg && (
        <div
          className={`tn-msg ${msg.ok ? "ok" : "bad"}`}
          role="status"
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </div>
      )}

      {tab === "privacy" && privacy.ov && privacy.ov.items.length > 0 && (
        <div className="tn-bar glass">
          <span className="muted-sm">{t("privacy.selected", { n: privacy.sel.size })}</span>
          <Btn onClick={privacy.clearSel} disabled={privacy.sel.size === 0 || privacy.busy}>
            {t("tuning.discard")}
          </Btn>
          <Btn
            variant="primary"
            icon={Check}
            onClick={() => void privacy.wipeSelected()}
            disabled={privacy.sel.size === 0 || privacy.busy}
          >
            {privacy.busy
              ? t("tuning.working")
              : t("privacy.wipeSelected", { n: privacy.sel.size })}
          </Btn>
        </div>
      )}

      <div className="page-scroll-body">
        {tab === "privacy" ? (
          <PrivacyTab p={privacy} />
        ) : (
          <>
            <div className="muted-sm" style={{ margin: "4px 0 8px" }}>
              {t("tuning.lu.hint")}
            </div>
            <div className="tn-bar glass">
              <input
                className="tn-input"
                placeholder={t("tuning.lu.search")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ flex: 1, minWidth: 120 }}
              />
            </div>
            {groups.length === 0 && <div className="muted-sm">{t("tuning.lu.empty")}</div>}
            {groups.map((g) => (
              <Glass key={g.name} style={{ padding: 14, marginTop: 12 }}>
                <b className="tn-card-title">{g.name}</b>
                <div className="tn-list">
                  {g.script
                    ? entry(g, 0)
                    : (g.children ?? []).filter((c) => matches(c, query)).map((c) => entry(c, 0))}
                </div>
              </Glass>
            ))}
            <div className="muted-sm" style={{ marginTop: 12 }}>
              {t("tuning.lu.credit")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
