import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Eye, ShieldAlert, Check, Save, Undo2 } from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TuningOverview, TuningResult, TuningTabId } from "@/api/client";
import TweaksList from "@/pages/tuning/parts/TweaksList";
import ProcessTool from "@/pages/tuning/parts/ProcessTool";
import UsbTree from "@/pages/tuning/parts/UsbTree";
import DriversTable from "@/pages/tuning/parts/DriversTable";
import BiosTab from "@/pages/tuning/parts/BiosTab";
import BenchTab from "@/pages/tuning/parts/BenchTab";
import ChecklistTab from "@/pages/tuning/parts/ChecklistTab";
import BackupsTab from "@/pages/tuning/parts/BackupsTab";
import DebloatFixes from "@/pages/tuning/parts/DebloatFixes";
import WinutilTools from "@/pages/tuning/parts/WinutilTools";
import WinutilApps from "@/pages/tuning/parts/WinutilApps";
import LinuxTuning from "@/pages/tuning/LinuxTuning";
import PrivacyTab from "@/pages/tuning/parts/PrivacyTab";
import { usePrivacy } from "@/pages/tuning/parts/usePrivacy";
import { describeResult } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

type TabKey = TuningTabId | "wu-tools" | "wu-apps" | "bios" | "bench" | "checklist" | "privacy" | "backups";

const TABS: TabKey[] = [
  "windows",
  "scheduler",
  "usb",
  "network",
  "drivers",
  "debloat",
  "wu-essential",
  "wu-advanced",
  "wu-prefs",
  "wu-tools",
  "wu-apps",
  "bios",
  "bench",
  "checklist",
  "privacy",
  "backups",
];

const TWEAK_TABS = new Set<TabKey>([
  "windows",
  "scheduler",
  "usb",
  "network",
  "drivers",
  "debloat",
  "wu-essential",
  "wu-advanced",
  "wu-prefs",
]);

function WindowsTuning() {
  const { t } = useI18n();
  const [ov, setOv] = useState<TuningOverview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("windows");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setOv(await api.tuningOverview());
      setError("");
    } catch (e) {
      const m = (e as Error).message;
      setError(m === "windows_only" ? t("tuning.windowsOnly") : m);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const notify = useCallback((text: string, ok = true) => setMsg({ text, ok }), []);

  const run = useCallback(
    async (fn: () => Promise<TuningResult>, okText = "") => {
      setBusy(true);
      try {
        const r = await fn();
        const d = describeResult(r, t, okText || t("tuning.done"));
        notify(d.text, d.ok);
        await reload();
      } catch (e) {
        notify((e as Error).message, false);
      } finally {
        setBusy(false);
      }
    },
    [notify, reload, t],
  );

  const ctx: TuningCtx | null = useMemo(
    () => (ov ? { ov, reload, notify, run } : null),
    [ov, reload, notify, run],
  );

  const privacy = usePrivacy(notify);

  const stateOf = (id: string) => ov?.statuses.find((s) => s.id === id)?.state ?? "na";

  const onToggle = (id: string, desired: boolean) => {
    setPending((p) => {
      const n = { ...p };
      const st = stateOf(id);
      // «Частично применён» не равен ни включённому, ни выключенному: оба действия осмысленны.
      if (st !== "partial" && desired === (st === "applied")) delete n[id];
      else n[id] = desired;
      return n;
    });
  };

  const toApply = Object.entries(pending)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const toRevert = Object.entries(pending)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const total = toApply.length + toRevert.length;

  const applyAll = async () => {
    if (!ov || !total) return;
    const risky = toApply.filter((id) => ov.tweaks.find((x) => x.id === id)?.risk === 2);
    if (
      risky.length &&
      !window.confirm(
        t("tuning.confirmRisk", { list: risky.map((id) => t(`tuning.tw.${id}.t`)).join(", ") }),
      )
    )
      return;
    setBusy(true);
    try {
      let reboot = false;
      let last: TuningResult | null = null;
      if (toRevert.length) {
        const r = await api.tuningRevert(toRevert);
        reboot ||= r.needsReboot;
        last = r;
      }
      if (toApply.length && (!last || last.ok)) {
        const r = await api.tuningApply(toApply);
        reboot ||= r.needsReboot;
        last = r;
      }
      if (last) {
        const d = describeResult(
          { ...last, needsReboot: reboot },
          t,
          t("tuning.applied", { n: total }),
        );
        notify(d.text, d.ok);
        if (d.ok) setPending({});
      }
      await reload();
    } catch (e) {
      notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const quickBackup = async () => {
    await api.tuningBackupCreate(t("tuning.backupManual"));
    notify(t("tuning.backupCreated"));
    await reload();
  };

  const rollbackAll = async () => {
    if (!ov || !window.confirm(t("tuning.rollbackConfirm", { n: ov.applied }))) return;
    await run(() => api.tuningRollbackAll(), t("tuning.rolledBack"));
  };

  const showReg = async () => {
    const ids = total
      ? Object.keys(pending)
      : (ov?.tweaks.filter((x) => x.tab === tab).map((x) => x.id) ?? []);
    const r = await api.tuningReg(ids, total && toApply.length === 0 ? "revert" : "apply");
    setPreview(r.text);
  };

  const downloadReg = () => {
    if (preview === null) return;
    const url = URL.createObjectURL(new Blob(["﻿" + preview], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "moonapp-tuning.reg";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!ov || !ctx) {
    return (
      <div className="page">
        <SectionHead eyebrow={t("tuning.eyebrow")} title={t("tuning.title")} />
        <div className="muted-sm">{error || t("tuning.loading")}</div>
      </div>
    );
  }

  const appliedCount = ov.statuses.filter((s) => s.state === "applied").length;

  return (
    <div className="page tn-page">
      <SectionHead
        eyebrow={t("tuning.eyebrow")}
        title={t("tuning.title")}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone={ov.admin ? "teal" : "amber"}>
              {ov.admin ? t("tuning.adminYes") : t("tuning.adminNo")}
            </Badge>
            <Btn icon={Save} disabled={busy} onClick={() => void quickBackup()}>
              {t("tuning.backupCreate")}
            </Btn>
            <Btn
              icon={Undo2}
              disabled={busy || ov.applied === 0}
              onClick={() => void rollbackAll()}
            >
              {t("tuning.rollbackAll")} ({ov.applied})
            </Btn>
          </div>
        }
      />
      <div className="tn-stats">
        <Glass className="tn-stat">
          <span className="muted-sm">{t("tuning.statApplied")}</span>
          <b>
            {appliedCount} / {ov.tweaks.length}
          </b>
        </Glass>
        <Glass className="tn-stat">
          <span className="muted-sm">{t("tuning.statByApp")}</span>
          <b>{ov.applied}</b>
        </Glass>
        <Glass className="tn-stat">
          <span className="muted-sm">{t("tuning.statBackups")}</span>
          <b>{ov.backups}</b>
        </Glass>
      </div>

      {!ov.admin && (
        <div className="tn-note">
          <ShieldAlert size={14} /> {t("tuning.adminNote")}
        </div>
      )}

      <div className="tn-tabs">
        {TABS.map((k) => (
          <Badge
            key={k}
            tone={tab === k ? "amber" : "neutral"}
            active={tab === k}
            onClick={() => setTab(k)}
          >
            {t(`tuning.tab.${k}`)}
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

      {TWEAK_TABS.has(tab) && (
        <div className="tn-bar glass">
          <span className="muted-sm">{t("tuning.pending", { n: total })}</span>
          <Btn icon={Eye} onClick={() => void showReg()}>
            {t("tuning.regButton")}
          </Btn>
          <Btn onClick={() => setPending({})} disabled={!total || busy}>
            {t("tuning.discard")}
          </Btn>
          <Btn
            variant="primary"
            icon={Check}
            onClick={() => void applyAll()}
            disabled={!total || busy}
          >
            {busy ? t("tuning.working") : t("tuning.apply")}
          </Btn>
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
        {TWEAK_TABS.has(tab) && (
          <>
            <div className="muted-sm" style={{ margin: "4px 0 8px" }}>
              {t(`tuning.tabHint.${tab}`)}
            </div>
            <Glass style={{ padding: "4px 14px" }}>
              <TweaksList
                tab={tab as TuningTabId}
                ov={ov}
                pending={pending}
                onToggle={onToggle}
                disabled={busy}
              />
            </Glass>
            {tab === "scheduler" && <ProcessTool ctx={ctx} />}
            {tab === "usb" && <UsbTree onError={(m) => notify(m, false)} />}
            {tab === "drivers" && <DriversTable onError={(m) => notify(m, false)} />}
            {tab === "debloat" && <DebloatFixes ctx={ctx} />}
          </>
        )}
        {tab === "wu-tools" && <WinutilTools ctx={ctx} />}
        {tab === "wu-apps" && <WinutilApps ctx={ctx} />}
        {tab === "bios" && <BiosTab ctx={ctx} />}
        {tab === "bench" && <BenchTab ctx={ctx} />}
        {tab === "checklist" && <ChecklistTab ctx={ctx} />}
        {tab === "privacy" && <PrivacyTab p={privacy} />}
        {tab === "backups" && <BackupsTab ctx={ctx} />}

        {preview !== null && (
          <Glass style={{ padding: 14, marginTop: 12 }}>
            <div className="tn-sub">
              <b className="tn-card-title">{t("tuning.regPreview")}</b>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn icon={Download} onClick={downloadReg}>
                  {t("tuning.regDownload")}
                </Btn>
                <Btn onClick={() => setPreview(null)}>{t("tuning.close")}</Btn>
              </div>
            </div>
            <pre className="tn-reg">{preview}</pre>
          </Glass>
        )}
      </div>
    </div>
  );
}

/** Windows — твики и инструменты; Linux — скрипты linutil и приватность. */
export default function TuningPage() {
  return window.appBridge?.platform === "linux" ? <LinuxTuning /> : <WindowsTuning />;
}
