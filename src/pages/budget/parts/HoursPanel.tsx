import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Report = Awaited<ReturnType<typeof api.budgetHours>>;
type Forecast = Awaited<ReturnType<typeof api.budgetSavingForecast>>;

const money = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * «Цена в часах»: траты месяца в рабочих часах и часах жизни по доходу, плюс
 * прогноз «накоплю на X к дате». Доход берётся из операций или вводится вручную.
 */
export default function HoursPanel({ currency }: { currency: string }) {
  const { t } = useI18n();
  const [income, setIncome] = useState("");
  const [workHours, setWorkHours] = useState("160");
  const [report, setReport] = useState<Report | null>(null);
  const [target, setTarget] = useState("");
  const [have, setHave] = useState("");
  const [date, setDate] = useState("");
  const [fc, setFc] = useState<Forecast | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      setReport(
        await api.budgetHours({
          currency,
          monthlyIncome: income === "" ? undefined : Number(income),
          workHours: Number(workHours) || undefined,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // загрузка при открытии и смене валюты; поля применяются кнопкой
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  const forecast = async () => {
    setError("");
    try {
      setFc(
        await api.budgetSavingForecast({
          currency,
          target: Number(target),
          have: have === "" ? undefined : Number(have),
          date: date || undefined,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const r = report?.rates;

  return (
    <div className="card" style={{ padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Hourglass size={16} /> <b>{t("budget.hours.title")}</b>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="input"
          type="number"
          placeholder={t("budget.hours.income")}
          value={income}
          onChange={(e) => setIncome(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 110 }}
          type="number"
          placeholder={t("budget.hours.workHours")}
          value={workHours}
          onChange={(e) => setWorkHours(e.target.value)}
        />
        <Btn onClick={() => void load()}>{t("budget.hours.apply")}</Btn>
      </div>
      {error && <div className="muted-sm">{error}</div>}
      {r && r.perWorkHour === 0 && <div className="muted-sm">{t("budget.hours.noIncome")}</div>}
      {r && r.perWorkHour > 0 && report && (
        <>
          <div className="muted-sm">
            {t("budget.hours.rates", {
              work: money(r.perWorkHour),
              life: money(r.perLifeHour),
              income: money(r.monthlyIncome),
            })}
          </div>
          <div>
            {t("budget.hours.month", {
              sum: money(report.totalExpense),
              hours: report.totalWorkHours,
            })}
          </div>
          <div className="muted-sm">
            {report.byCategory.slice(0, 6).map((c) => (
              <div key={c.category}>
                {c.category}: {money(c.amount)} · {t("budget.hours.h", { n: c.workHours })}
              </div>
            ))}
          </div>
          {report.top.length > 0 && (
            <div>
              <div className="field-label">{t("budget.hours.top")}</div>
              {report.top.map((x, i) => (
                <div key={i} className="muted-sm">
                  {x.date.slice(5)} · {x.note || x.category}: {money(x.amount)} →{" "}
                  <b>{t("budget.hours.h", { n: x.workHours })}</b> ({t("budget.hours.life", { n: x.lifeHours })})
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="field-label">{t("budget.hours.forecast")}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="input"
          type="number"
          placeholder={t("budget.hours.target")}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <input
          className="input"
          type="number"
          placeholder={t("budget.hours.have")}
          value={have}
          onChange={(e) => setHave(e.target.value)}
        />
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Btn disabled={!(Number(target) > 0)} onClick={() => void forecast()}>
          {t("budget.hours.calc")}
        </Btn>
      </div>
      {fc && (
        <div className="muted-sm">
          <div>{t("budget.hours.saving", { n: money(fc.monthlySaving) })}</div>
          {fc.reachedOn ? (
            <div>
              {t("budget.hours.reached", { date: fc.reachedOn, months: fc.monthsNeeded ?? 0 })}
            </div>
          ) : (
            <div>{t("budget.hours.never")}</div>
          )}
          {fc.byDate && (
            <div>
              {t(fc.byDate.feasible ? "budget.hours.feasible" : "budget.hours.notFeasible", {
                n: money(fc.byDate.requiredPerMonth),
                date: fc.byDate.date,
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
