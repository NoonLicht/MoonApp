import { useCallback, useEffect, useState } from "react";
import { HandHeart } from "lucide-react";
import { Btn, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Contracts = Awaited<ReturnType<typeof api.selfContracts>>["items"];
type Due = {
  traces: Awaited<ReturnType<typeof api.mindTraces>>["due"];
  checks: Awaited<ReturnType<typeof api.mindConfidence>>["due"];
};

const METRICS = [
  "category_minutes_day",
  "app_minutes_day",
  "spend_day",
  "spend_month",
  "category_spend_month",
] as const;
const CATEGORIES = ["media", "game", "chat", "browser", "dev", "office", "other"] as const;

/**
 * «Договорённости с собой»: контракты (лимиты времени и трат) со спокойным
 * статусом и то, что пора проверить — решения полугодовой давности и
 * утверждения с уверенностью. Никаких уведомлений: всё видно, когда вы сами
 * заходите в дневник.
 */
export default function SelfCheckPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<Contracts>([]);
  const [due, setDue] = useState<Due>({ traces: [], checks: [] });
  const [label, setLabel] = useState("");
  const [metric, setMetric] = useState<(typeof METRICS)[number]>("category_minutes_day");
  const [target, setTarget] = useState("media");
  const [limit, setLimit] = useState("120");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, tr, cf] = await Promise.all([api.selfContracts(), api.mindTraces(), api.mindConfidence()]);
      setItems(c.items);
      setDue({ traces: tr.due, checks: cf.due });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const needsTarget = metric === "category_minutes_day" || metric === "app_minutes_day" || metric === "category_spend_month";

  const add = async () => {
    setErr("");
    try {
      await api.selfContractCreate({
        label: label.trim() || t(`diary.self.metric.${metric}`),
        metric,
        target: needsTarget ? target : "",
        limit: Number(limit),
      });
      setLabel("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const nothing = items.length === 0 && due.traces.length === 0 && due.checks.length === 0;

  return (
    <Glass style={{ marginTop: 12, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <HandHeart size={16} /> <b>{t("diary.self.title")}</b>
      </div>
      {err && <div className="muted-sm">{err}</div>}
      {nothing && <div className="muted-sm">{t("diary.self.empty")}</div>}

      {items.map((e) => {
        const shown = e.unit === "min" ? `${Math.round(e.value)} / ${e.contract.limit} ${t("diary.self.min")}` : `${Math.round(e.value)} / ${e.contract.limit}`;
        return (
          <div key={e.contract.id} style={{ display: "grid", gap: 3 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ flex: 1 }}>{e.contract.label}</span>
              <span className="muted-sm">{shown}</span>
              <button
                className="ghost-x"
                aria-label={t("common.delete")}
                onClick={() => void api.selfContractDelete(e.contract.id).then(load)}
              >
                ×
              </button>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--track)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.min(100, Math.round(e.ratio * 100))}%`,
                  height: "100%",
                  background: e.status === "over" ? "var(--amber, #e0a030)" : e.status === "near" ? "#c9b458" : "var(--green, #3fb27f)",
                }}
              />
            </div>
            <div className="muted-sm">{t(`diary.self.status.${e.status}`)}</div>
          </div>
        );
      })}

      {due.checks.length > 0 && (
        <div>
          <div className="muted-sm">{t("diary.self.checks")}</div>
          {due.checks.slice(0, 5).map((c) => (
            <div key={c.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                {c.pct}% · {c.claim}
              </span>
              <Btn variant="ghost" onClick={() => void api.mindConfidenceResolve(c.id, true).then(load)}>
                {t("diary.self.came")}
              </Btn>
              <Btn variant="ghost" onClick={() => void api.mindConfidenceResolve(c.id, false).then(load)}>
                {t("diary.self.notCame")}
              </Btn>
            </div>
          ))}
        </div>
      )}

      {due.traces.length > 0 && (
        <div>
          <div className="muted-sm">{t("diary.self.traces")}</div>
          {due.traces.slice(0, 3).map((tr) => (
            <div key={tr.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                {tr.title}: {tr.decision.slice(0, 90)}
              </span>
              <Btn variant="ghost" onClick={() => void api.mindTraceReview(tr.id, "right").then(load)}>
                {t("diary.self.right")}
              </Btn>
              <Btn variant="ghost" onClick={() => void api.mindTraceReview(tr.id, "wrong").then(load)}>
                {t("diary.self.wrong")}
              </Btn>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {t(`diary.self.metric.${m}`)}
            </option>
          ))}
        </select>
        {metric === "category_minutes_day" && (
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`diary.self.cat.${c}`)}
              </option>
            ))}
          </select>
        )}
        {(metric === "app_minutes_day" || metric === "category_spend_month") && (
          <input
            className="input"
            placeholder={t(metric === "app_minutes_day" ? "diary.self.app" : "diary.self.category")}
            value={target === "media" ? "" : target}
            onChange={(e) => setTarget(e.target.value)}
          />
        )}
        <input
          className="input"
          type="number"
          style={{ width: 100 }}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <input
          className="input"
          placeholder={t("diary.self.label")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Btn disabled={!(Number(limit) > 0)} onClick={() => void add()}>
          {t("diary.self.add")}
        </Btn>
      </div>
    </Glass>
  );
}
