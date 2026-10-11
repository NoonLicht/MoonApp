import { useEffect, useState } from "react";
import { RotateCcw, ShieldCheck, Search } from "lucide-react";
import { api } from "@/api/client";
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
  const all = ov.tweaks.filter((x) => x.tab === tab);
  // Поиск твика по задаче («не греется ноутбук», «убрать рекламу в меню Пуск»): по смыслу и по словам.
  const [q, setQ] = useState("");
  const [rank, setRank] = useState<string[] | null>(null);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setRank(null);
      return;
    }
    let live = true;
    const tm = setTimeout(async () => {
      const texts = all.map((x) => `${t(`tuning.tw.${x.id}.t`)}. ${t(`tuning.tw.${x.id}.d`)}`);
      const low = text.toLowerCase();
      let scores: number[] = texts.map((x) => (x.toLowerCase().includes(low) ? 1 : 0));
      try {
        const sem = await api.semRank(text, texts);
        scores = sem.map((v, i) => Math.max(scores[i], v));
      } catch {
        /* без модели — только слова */
      }
      if (!live) return;
      const top = Math.max(...scores, 0);
      setRank(
        scores
          .map((v, i) => ({ v, id: all[i].id }))
          .filter((x) => x.v >= Math.max(0.68, top - 0.06))
          .sort((a, b) => b.v - a.v)
          .map((x) => x.id),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(tm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab]);
  const items = rank
    ? rank.map((id) => all.find((x) => x.id === id)).filter((x): x is (typeof all)[number] => !!x)
    : all;
  return (
    <div className="tn-list">
      <label
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px 8px" }}
        className="muted-sm"
      >
        <Search size={13} />
        <input
          className="text-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("tuning.searchPh")}
          style={{ flex: 1 }}
        />
      </label>
      {rank && items.length === 0 && <div className="muted-sm">{t("common.nothingFound")}</div>}
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
