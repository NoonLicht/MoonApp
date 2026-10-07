import { RotateCcw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TuningOverview, TuningTabId } from "@/api/client";

interface Props {
  tab: TuningTabId;
  ov: TuningOverview;
  pending: Record<string, boolean>;
  onToggle: (id: string, desired: boolean) => void;
  disabled: boolean;
}

const RISK_TONE = ["teal", "amber", "coral"] as const;

/** Список твиков вкладки: переключатель задаёт желаемое состояние, применяет его панель внизу. */
export default function TweaksList({ tab, ov, pending, onToggle, disabled }: Props) {
  const { t } = useI18n();
  const items = ov.tweaks.filter((x) => x.tab === tab);
  return (
    <div className="tn-list">
      {items.map((tw) => {
        const st = ov.statuses.find((s) => s.id === tw.id);
        const state = st?.state ?? "na";
        const current = state === "applied";
        const desired = pending[tw.id] ?? current;
        const unavailable = state === "na";
        return (
          <div key={tw.id} className={`tn-row ${unavailable ? "is-na" : ""}`}>
            <div className="tn-row-main">
              <div className="tn-row-title">{t(`tuning.tw.${tw.id}.t`)}</div>
              <div className="muted-sm">{t(`tuning.tw.${tw.id}.d`)}</div>
            </div>
            <div className="tn-row-badges">
              {state === "partial" && <Badge tone="violet">{t("tuning.statePartial")}</Badge>}
              {unavailable && <Badge tone="neutral">{t("tuning.stateNa")}</Badge>}
              {st?.byApp && (
                <span title={t("tuning.byApp")}>
                  <ShieldCheck size={14} />
                </span>
              )}
              {tw.reboot && (
                <span title={t("tuning.needsReboot")}>
                  <RotateCcw size={13} />
                </span>
              )}
              <Badge tone={RISK_TONE[tw.risk]}>{t(`tuning.risk${tw.risk}`)}</Badge>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={desired}
              aria-label={t(`tuning.tw.${tw.id}.t`)}
              className={`tn-switch ${desired ? "on" : ""} ${desired !== current ? "dirty" : ""}`}
              disabled={disabled || unavailable}
              onClick={() => onToggle(tw.id, !desired)}
            />
          </div>
        );
      })}
    </div>
  );
}
