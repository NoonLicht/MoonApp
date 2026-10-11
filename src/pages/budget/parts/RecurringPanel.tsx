import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, Check, Plus, Trash2, TrendingUp } from "lucide-react";
import { Glass, Btn, Badge, SectionHead, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  BudgetForecast,
  RecurringInterval,
  RecurringPayment,
  UpcomingPayment,
} from "@/api/types";

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Эквивалент платежа в месяц (для суммарной строки «подписки обходятся в…»). */
function perMonth(r: RecurringPayment): number {
  const k = r.interval === "week" ? 52 / 12 : r.interval === "month" ? 1 : 1 / 12;
  return r.amount * k;
}

interface Props {
  /** Валюта, в которой показывается прогноз (валюта отображения страницы). */
  currency: string;
  currencies: string[];
  /** Вызывается после проведения платежа — страница перечитывает операции. */
  onChanged: () => void;
}

/** Подписки, напоминания о списаниях и прогноз расходов месяца. */
export default function RecurringPanel({ currency, currencies, onChanged }: Props) {
  const { t } = useI18n();
  const [list, setList] = useState<RecurringPayment[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingPayment[]>([]);
  const [forecast, setForecast] = useState<BudgetForecast | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    amount: "",
    currency: "RUB",
    interval: "month" as RecurringInterval,
    startDate: new Date().toISOString().slice(0, 10),
    remindDays: "3",
  });

  const load = useCallback(() => {
    Promise.all([api.budgetRecurringList(), api.budgetUpcoming(30), api.budgetForecast(currency)])
      .then(([l, u, f]) => {
        setList(l);
        setUpcoming(u);
        setForecast(f);
      })
      .catch((e) => setError((e as Error).message));
  }, [currency]);
  useEffect(load, [load]);

  const add = async () => {
    setError("");
    try {
      await api.budgetRecurringCreate({
        name: form.name,
        amount: form.amount,
        currency: form.currency,
        interval: form.interval,
        startDate: form.startDate,
        remindDays: Number(form.remindDays) || 0,
      });
      setForm((f) => ({ ...f, name: "", amount: "" }));
      setShowForm(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pay = async (id: string) => {
    await api.budgetRecurringPay(id).catch((e) => setError((e as Error).message));
    load();
    onChanged();
  };

  const monthly = list
    .filter((r) => r.active && r.type === "expense" && r.currency === currency)
    .reduce((s, r) => s + perMonth(r), 0);

  const dueLabel = (u: UpcomingPayment): string =>
    u.inDays < 0
      ? t("budget.rec.overdue", { n: -u.inDays })
      : u.inDays === 0
        ? t("budget.rec.today")
        : t("budget.rec.inDays", { n: u.inDays });

  return (
    <>
      <SectionHead
        eyebrow={t("budget.rec.eyebrow")}
        title={t("budget.rec.title")}
        action={
          <Btn icon={Plus} onClick={() => setShowForm((v) => !v)}>
            {t("budget.rec.add")}
          </Btn>
        }
      />

      {error && <div className="muted-sm" style={{ color: "var(--coral)" }}>{error}</div>}

      {forecast && (
        <Glass className="budget-total-card" style={{ alignItems: "flex-start" }}>
          <TrendingUp size={16} style={{ color: "var(--amber)", marginTop: 3 }} />
          <div style={{ flex: 1 }}>
            <div className="muted-sm">{t("budget.rec.forecast")}</div>
            <div className="budget-total-value">
              {fmt(forecast.projectedTotal)} {forecast.currency}
            </div>
            <div className="muted-sm">
              {t("budget.rec.forecastParts", {
                spent: fmt(forecast.spentSoFar),
                daily: fmt(forecast.dailyVariable),
                ahead: fmt(forecast.recurringAhead),
                cur: forecast.currency,
              })}
            </div>
            {forecast.skipped > 0 && (
              <div className="muted-sm">{t("budget.rec.forecastSkipped", { n: forecast.skipped })}</div>
            )}
          </div>
        </Glass>
      )}

      {showForm && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            className="text-input"
            placeholder={t("budget.rec.name")}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              type="number"
              step="0.01"
              placeholder={t("budget.fAmount")}
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
            <Select
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              options={currencies.map((c) => ({ value: c, label: c }))}
            />
            <Select
              value={form.interval}
              onChange={(e) => setForm((f) => ({ ...f, interval: e.target.value as RecurringInterval }))}
              options={(["week", "month", "year"] as const).map((i) => ({
                value: i,
                label: t(`budget.rec.interval.${i}`),
              }))}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="muted-sm">{t("budget.rec.first")}</span>
            <input
              className="text-input"
              type="date"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            />
            <span className="muted-sm">{t("budget.rec.remindBefore")}</span>
            <input
              className="text-input"
              style={{ width: 70 }}
              type="number"
              min={0}
              value={form.remindDays}
              onChange={(e) => setForm((f) => ({ ...f, remindDays: e.target.value }))}
            />
          </div>
          <div>
            <Btn variant="primary" disabled={!form.name.trim() || !form.amount} onClick={() => void add()}>
              {t("budget.save")}
            </Btn>
          </div>
        </Glass>
      )}

      {upcoming.length > 0 && (
        <div className="budget-tx-list">
          {upcoming.map((u) => (
            <Glass key={u.recurring.id} className="budget-tx-row">
              {u.remind || u.inDays < 0 ? (
                <BellRing size={15} style={{ color: u.inDays < 0 ? "var(--coral)" : "var(--amber)" }} />
              ) : (
                <CalendarClock size={15} className="muted-sm" />
              )}
              <span style={{ flex: 1 }}>
                {u.recurring.name}
                <span className="muted-sm">
                  {" · "}
                  {u.due} · {dueLabel(u)}
                </span>
              </span>
              <b>
                {fmt(u.recurring.amount)} {u.recurring.currency}
              </b>
              <Btn icon={Check} onClick={() => void pay(u.recurring.id)}>
                {t("budget.rec.pay")}
              </Btn>
            </Glass>
          ))}
        </div>
      )}

      {list.length > 0 && (
        <>
          <div className="muted-sm">
            {t("budget.rec.monthlyTotal", { sum: fmt(monthly), cur: currency })}
          </div>
          <div className="budget-tx-list">
            {list.map((r) => (
              <Glass key={r.id} className="budget-tx-row" style={{ opacity: r.active ? 1 : 0.55 }}>
                <Badge tone="neutral">{t(`budget.rec.interval.${r.interval}`)}</Badge>
                <span style={{ flex: 1 }}>{r.name}</span>
                <span style={{ fontWeight: 600 }}>
                  {fmt(r.amount)} {r.currency}
                </span>
                <Btn
                  onClick={() =>
                    void api.budgetRecurringToggle(r.id, !r.active).then(load)
                  }
                >
                  {r.active ? t("budget.rec.pause") : t("budget.rec.resume")}
                </Btn>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void api.budgetRecurringDelete(r.id).then(load)}
                >
                  <Trash2 size={14} />
                </button>
              </Glass>
            ))}
          </div>
        </>
      )}
      {list.length === 0 && !showForm && (
        <div className="muted-sm">{t("budget.rec.empty")}</div>
      )}
    </>
  );
}
