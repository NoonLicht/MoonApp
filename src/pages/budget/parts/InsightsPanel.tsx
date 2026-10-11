import { useEffect, useState } from "react";
import { Glass, Btn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { BudgetInsights } from "@/api/types";

const monthStr = (offset: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() + offset, 1);
  return d.toISOString().slice(0, 7);
};

/**
 * Аналитика: хватит ли до зарплаты, забытые подписки, сравнение двух месяцев,
 * личная инфляция и «что если сократить расходы».
 */
export default function InsightsPanel({
  currency,
  categories,
}: {
  currency: string;
  categories: string[];
}) {
  const { t } = useI18n();
  const [payday, setPayday] = useState("");
  const [available, setAvailable] = useState("");
  const [data, setData] = useState<BudgetInsights | null>(null);
  const [error, setError] = useState("");
  const [cutCat, setCutCat] = useState("");
  const [cutPct, setCutPct] = useState(20);
  const [saving, setSaving] = useState<{ perMonth: number; perYear: number } | null>(null);
  const [tax, setTax] = useState<Awaited<ReturnType<typeof api.budgetTaxDeductions>> | null>(null);

  const load = async () => {
    setError("");
    try {
      setData(
        await api.budgetInsights({
          currency,
          payday: payday || undefined,
          available: available === "" ? undefined : Number(available),
          monthA: monthStr(-1),
          monthB: monthStr(0),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // загрузка при открытии и смене валюты; поля формы применяются кнопкой
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  useEffect(() => {
    let alive = true;
    void api
      .budgetTaxDeductions(currency)
      .then((r) => {
        if (alive) setTax(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [currency]);

  const runWhatIf = async () => {
    if (!cutCat) return;
    try {
      setSaving(await api.budgetWhatIf({ [cutCat]: cutPct }, currency));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const r = data?.runway;
  return (
    <>
      <SectionHead eyebrow={t("budget.insights.eyebrow")} title={t("budget.insights.title")} />
      <Glass className="p-4">
        <div className="field-label">{t("budget.insights.runwayTitle")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            type="number"
            placeholder={t("budget.insights.available")}
            value={available}
            onChange={(e) => setAvailable(e.target.value)}
          />
          <input
            className="input"
            type="date"
            title={t("budget.insights.payday")}
            value={payday}
            onChange={(e) => setPayday(e.target.value)}
          />
          <Btn variant="primary" onClick={load} disabled={!payday || available === ""}>
            {t("budget.insights.calc")}
          </Btn>
        </div>
        {error && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{error}</div>}
        {r && (
          <div style={{ marginTop: 8 }}>
            <strong>
              {r.enough ? t("budget.insights.enough") : t("budget.insights.notEnough")}
            </strong>
            <div className="muted-sm">
              {t("budget.insights.runwayLine", {
                days: r.daysUntilPayday,
                avg: r.avgDaily,
                allow: r.dailyAllowance,
                left: r.leftover,
              })}
            </div>
          </div>
        )}

        {data && data.subscriptions.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">{t("budget.insights.subs")}</div>
            {data.subscriptions.map((s) => (
              <div key={s.name} style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 4 }}>
                <span style={{ flex: 1 }}>
                  {s.stale ? "⚠️ " : ""}
                  {s.name}
                </span>
                <span className="muted-sm">
                  {s.amount} / {s.everyDays} {t("budget.insights.days")} · {s.yearlyCost}{" "}
                  {t("budget.insights.perYear")}
                </span>
              </div>
            ))}
            <div className="muted-sm">{t("budget.insights.subsHint")}</div>
          </div>
        )}

        {data?.compare && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">
              {t("budget.insights.compare", {
                a: data.compare.totalA,
                b: data.compare.totalB,
              })}
            </div>
            {data.compare.categories.slice(0, 6).map((c) => (
              <div key={c.category} style={{ display: "flex", gap: 8, fontSize: 13 }}>
                <span style={{ flex: 1 }}>{c.category}</span>
                <span style={{ color: c.delta > 0 ? "var(--coral)" : "var(--teal)" }}>
                  {c.delta > 0 ? "+" : ""}
                  {c.delta}
                  {c.pct !== null ? ` (${c.pct}%)` : ""}
                </span>
              </div>
            ))}
          </div>
        )}

        {data?.inflation.overallPct != null && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">
              {t("budget.insights.inflation", { pct: data.inflation.overallPct })}
            </div>
            {data.inflation.items.slice(0, 5).map((i) => (
              <div key={i.name} className="muted-sm">
                {i.name}: {i.first} → {i.last} ({i.pct > 0 ? "+" : ""}
                {i.pct}%)
              </div>
            ))}
          </div>
        )}

        {tax && tax.years.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">{t("budget.insights.tax", { limit: tax.limit })}</div>
            {tax.years.slice(0, 3).map((y) => (
              <div key={y.year} style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 4 }}>
                <span style={{ flex: 1 }}>
                  {y.year}: {t("budget.insights.taxKinds", {
                    m: y.byKind.medicine,
                    e: y.byKind.education,
                    s: y.byKind.sport,
                  })}
                </span>
                <span>{t("budget.insights.taxRefund", { n: y.refund })}</span>
              </div>
            ))}
            <div className="muted-sm">{t("budget.insights.taxHint")}</div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div className="field-label">{t("budget.insights.whatIf")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select className="input" value={cutCat} onChange={(e) => setCutCat(e.target.value)}>
              <option value="">{t("budget.insights.pickCategory")}</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ width: 90 }}
              type="number"
              min={1}
              max={100}
              value={cutPct}
              onChange={(e) => setCutPct(Number(e.target.value))}
            />
            <span style={{ alignSelf: "center" }}>%</span>
            <Btn onClick={runWhatIf} disabled={!cutCat}>
              {t("budget.insights.calcSaving")}
            </Btn>
          </div>
          {saving && (
            <div className="muted-sm" style={{ marginTop: 6 }}>
              {t("budget.insights.saving", { m: saving.perMonth, y: saving.perYear })}
            </div>
          )}
        </div>
      </Glass>
    </>
  );
}
