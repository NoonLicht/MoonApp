import { useCallback, useEffect, useState } from "react";
import { Wrench, RefreshCw } from "lucide-react";
import { Glass, Btn, Badge, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TuningResult, WuFeatureRow, WuMeta } from "@/api/client";
import { describeResult } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

/** Разовые действия из winutil (ChrisTitusTech/winutil, MIT), сгруппированные по смыслу. */
const GROUPS: { id: string; actions: string[] }[] = [
  { id: "updates", actions: ["updates-default", "updates-security", "updates-disable"] },
  { id: "power", actions: ["ultperf-add", "ultperf-remove"] },
  { id: "repair", actions: ["sys-repair", "wu-repair", "wu-repair-aggressive", "ntp-pool"] },
  { id: "extra", actions: ["oosu", "autologon", "ssh-server"] },
];

/**
 * Вкладка «Инструменты»: режимы Windows Update, DNS, схема питания, ремонт,
 * компоненты Windows и старые панели управления. Всё это — разовые действия, а не
 * переключатели: у большинства нет состояния, которое можно проверить и откатить.
 */
export default function WinutilTools({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [meta, setMeta] = useState<WuMeta | null>(null);
  const [feats, setFeats] = useState<WuFeatureRow[] | null>(null);
  const [dns, setDns] = useState("DHCP");
  const [busy, setBusy] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api.wuMeta());
    } catch (e) {
      ctx.notify((e as Error).message, false);
    }
  }, [ctx]);

  const loadFeats = useCallback(async () => {
    try {
      setFeats(await api.wuFeatures());
    } catch (e) {
      ctx.notify((e as Error).message, false);
    }
  }, [ctx]);

  useEffect(() => {
    void loadMeta();
    void loadFeats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exec = async (key: string, fn: () => Promise<TuningResult>) => {
    setBusy(key);
    try {
      const d = describeResult(await fn(), t, t("tuning.fixDone"));
      ctx.notify(d.text, d.ok);
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setBusy(null);
    }
  };

  const action = async (id: string) => {
    if (!window.confirm(t("tuning.fixConfirm", { name: t(`tuning.wact.${id}.t`) }))) return;
    await exec(id, () => api.wuAction(id));
  };

  const applyDns = async () => {
    if (!window.confirm(t("tuning.fixConfirm", { name: `DNS: ${dns}` }))) return;
    await exec("dns", () => api.wuDns(dns));
    await loadMeta();
  };

  const setFeature = async (id: string, enable: boolean) => {
    if (!window.confirm(t("tuning.fixConfirm", { name: t(`tuning.wf.${id}.t`) }))) return;
    await exec(id, () => api.wuFeature(id, enable));
    await loadFeats();
  };

  const adminBadge = !ctx.ov.admin && <Badge tone="amber">{t("tuning.adminYes")}</Badge>;

  return (
    <div>
      <div className="muted-sm" style={{ margin: "4px 0 8px" }}>
        {t("tuning.wu.credit")}
      </div>

      <Glass style={{ padding: 14 }}>
        <b className="tn-card-title">
          <Wrench size={14} /> DNS
        </b>
        <div className="muted-sm">
          {t("tuning.wu.dnsHint")} {meta?.dnsCurrent ? `(${meta.dnsCurrent})` : ""}
        </div>
        <div className="tn-row">
          <div className="tn-row-main">
            <Select
              value={dns}
              onChange={(e) => setDns(e.target.value)}
              options={(meta?.dns ?? ["DHCP"]).map((d) => ({
                value: d,
                label: d === "DHCP" ? t("tuning.wu.dnsDhcp") : d,
              }))}
            />
          </div>
          {adminBadge}
          <Btn disabled={busy !== null} onClick={() => void applyDns()}>
            {busy === "dns" ? t("tuning.working") : t("tuning.wu.dnsApply")}
          </Btn>
        </div>
      </Glass>

      {GROUPS.map((g) => (
        <Glass key={g.id} style={{ padding: 14, marginTop: 12 }}>
          <b className="tn-card-title">{t(`tuning.wu.group.${g.id}`)}</b>
          <div className="tn-list">
            {g.actions.map((id) => (
              <div key={id} className="tn-row">
                <div className="tn-row-main">
                  <div className="tn-row-title">{t(`tuning.wact.${id}.t`)}</div>
                  <div className="muted-sm">{t(`tuning.wact.${id}.d`)}</div>
                </div>
                {adminBadge}
                <Btn disabled={busy !== null} onClick={() => void action(id)}>
                  {busy === id ? t("tuning.working") : t("tuning.fixRun")}
                </Btn>
              </div>
            ))}
          </div>
        </Glass>
      ))}

      <Glass style={{ padding: 14, marginTop: 12 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("tuning.wu.features")}</b>
          <Btn icon={RefreshCw} onClick={() => void loadFeats()}>
            {t("tuning.refresh")}
          </Btn>
        </div>
        <div className="muted-sm">{t("tuning.wu.featuresHint")}</div>
        <div className="tn-list">
          {(feats ?? []).map((f) => (
            <div key={f.id} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">{t(`tuning.wf.${f.id}.t`)}</div>
                <div className="muted-sm">{t(`tuning.wf.${f.id}.d`)}</div>
              </div>
              {f.enabled !== null && (
                <Badge tone={f.enabled ? "teal" : "neutral"}>
                  {f.enabled ? t("tuning.wu.on") : t("tuning.wu.off")}
                </Badge>
              )}
              {adminBadge}
              {f.canDisable && f.enabled === true ? (
                <Btn disabled={busy !== null} onClick={() => void setFeature(f.id, false)}>
                  {busy === f.id ? t("tuning.working") : t("tuning.wu.disable")}
                </Btn>
              ) : (
                <Btn disabled={busy !== null} onClick={() => void setFeature(f.id, true)}>
                  {busy === f.id ? t("tuning.working") : t("tuning.wu.enable")}
                </Btn>
              )}
            </div>
          ))}
        </div>
      </Glass>

      <Glass style={{ padding: 14, marginTop: 12 }}>
        <b className="tn-card-title">{t("tuning.wu.panels")}</b>
        <div className="muted-sm">{t("tuning.wu.panelsHint")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {(meta?.panels ?? []).map((id) => (
            <Btn
              key={id}
              disabled={busy !== null}
              onClick={() => void exec(id, () => api.wuPanel(id))}
            >
              {t(`tuning.wp.${id}.t`)}
            </Btn>
          ))}
        </div>
      </Glass>
    </div>
  );
}
