/**
 * Бюджет: «цена в часах» и прогноз накоплений. Чистые функции над операциями
 * в одной валюте.
 *
 *  - рабочий час = доход в месяц / рабочих часов в месяце (по умолчанию 160);
 *  - «час жизни» = доход в месяц / бодрствующих часов в месяце (16 ч × 30 дней):
 *    сколько часов бодрствования «стоит» покупка, если мерить доходом.
 *
 * Если доход не задан вручную, берётся среднее по последним полным месяцам с
 * доходом (текущий неполный месяц учитывается, только если других нет).
 */
import type { Tx } from "./budgetInsights";

const round = (n: number, d = 2): number => {
  const k = 10 ** d;
  return Math.round(n * k) / k;
};

export interface HourRates {
  monthlyIncome: number;
  workHoursPerMonth: number;
  wakingHoursPerMonth: number;
  /** Денег за один рабочий час. */
  perWorkHour: number;
  /** Денег за один час бодрствования. */
  perLifeHour: number;
  /** По скольким месяцам посчитан доход; 0 — задан вручную или данных нет. */
  basedOnMonths: number;
}

const monthOf = (d: string): string => d.slice(0, 7);

/** Средний месячный доход по последним `months` месяцам с доходом. */
export function averageMonthlyIncome(
  txs: Tx[],
  today: string,
  months = 3,
): { value: number; months: number } {
  const byMonth = new Map<string, number>();
  for (const t of txs) {
    if (t.type !== "income" || t.date > today) continue;
    byMonth.set(monthOf(t.date), (byMonth.get(monthOf(t.date)) ?? 0) + t.amount);
  }
  const cur = monthOf(today);
  let keys = [...byMonth.keys()].filter((k) => k < cur).sort().reverse();
  if (!keys.length) keys = [...byMonth.keys()].filter((k) => k === cur);
  keys = keys.slice(0, months);
  if (!keys.length) return { value: 0, months: 0 };
  const sum = keys.reduce((s, k) => s + (byMonth.get(k) ?? 0), 0);
  return { value: sum / keys.length, months: keys.length };
}

export function hourRates(
  txs: Tx[],
  today: string,
  o: { monthlyIncome?: number; workHoursPerMonth?: number; wakingHoursPerDay?: number } = {},
): HourRates {
  const work = o.workHoursPerMonth && o.workHoursPerMonth > 0 ? o.workHoursPerMonth : 160;
  const waking = (o.wakingHoursPerDay && o.wakingHoursPerDay > 0 ? o.wakingHoursPerDay : 16) * 30;
  const manual = o.monthlyIncome && o.monthlyIncome > 0 ? o.monthlyIncome : 0;
  const avg = manual ? { value: manual, months: 0 } : averageMonthlyIncome(txs, today);
  return {
    monthlyIncome: round(avg.value),
    workHoursPerMonth: work,
    wakingHoursPerMonth: waking,
    perWorkHour: avg.value ? round(avg.value / work) : 0,
    perLifeHour: avg.value ? round(avg.value / waking) : 0,
    basedOnMonths: avg.months,
  };
}

export interface PriceInHours {
  workHours: number;
  lifeHours: number;
  /** Рабочих дней по 8 часов. */
  workDays: number;
}

export function priceInHours(amount: number, rates: HourRates): PriceInHours | null {
  if (!(rates.perWorkHour > 0) || !(amount >= 0)) return null;
  return {
    workHours: round(amount / rates.perWorkHour, 1),
    lifeHours: round(amount / rates.perLifeHour, 1),
    workDays: round(amount / rates.perWorkHour / 8, 1),
  };
}

export interface HoursReport {
  rates: HourRates;
  month: string;
  totalExpense: number;
  totalWorkHours: number;
  byCategory: { category: string; amount: number; workHours: number }[];
  top: { date: string; note: string; category: string; amount: number; workHours: number; lifeHours: number }[];
}

export function hoursReport(txs: Tx[], month: string, rates: HourRates, topN = 8): HoursReport {
  const exp = txs.filter((t) => t.type === "expense" && monthOf(t.date) === month);
  const cats = new Map<string, number>();
  for (const t of exp) cats.set(t.category, (cats.get(t.category) ?? 0) + t.amount);
  const h = (a: number): number => (rates.perWorkHour > 0 ? round(a / rates.perWorkHour, 1) : 0);
  const total = exp.reduce((s, t) => s + t.amount, 0);
  return {
    rates,
    month,
    totalExpense: round(total),
    totalWorkHours: h(total),
    byCategory: [...cats.entries()]
      .map(([category, amount]) => ({ category, amount: round(amount), workHours: h(amount) }))
      .sort((a, b) => b.amount - a.amount),
    top: [...exp]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, topN)
      .map((t) => {
        const p = priceInHours(t.amount, rates);
        return {
          date: t.date,
          note: t.note,
          category: t.category,
          amount: round(t.amount),
          workHours: p?.workHours ?? 0,
          lifeHours: p?.lifeHours ?? 0,
        };
      }),
  };
}

// ---------------- прогноз накоплений ----------------

export interface SavingForecast {
  /** Средние накопления в месяц (доход − расход) по последним месяцам. */
  monthlySaving: number;
  monthsUsed: number;
  remaining: number;
  /** Сколько месяцев до цели при текущем темпе; null — при таком темпе не накопить. */
  monthsNeeded: number | null;
  /** Дата достижения цели (YYYY-MM-DD) при текущем темпе. */
  reachedOn: string | null;
  /** Если задан срок: сколько нужно откладывать в месяц и хватает ли текущего темпа. */
  byDate?: { date: string; monthsLeft: number; requiredPerMonth: number; feasible: boolean };
}

const addMonths = (today: string, n: number): string => {
  const d = new Date(`${today}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // 31 января + 1 месяц не должно перепрыгивать в март
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export function savingForecast(
  txs: Tx[],
  today: string,
  o: { target: number; have?: number; byDate?: string; months?: number },
): SavingForecast {
  const want = Math.max(0, o.months ?? 3);
  const cur = monthOf(today);
  const net = new Map<string, number>();
  for (const t of txs) {
    if (t.date > today) continue;
    const k = monthOf(t.date);
    net.set(k, (net.get(k) ?? 0) + (t.type === "income" ? t.amount : -t.amount));
  }
  let keys = [...net.keys()].filter((k) => k < cur).sort().reverse().slice(0, want);
  if (!keys.length && net.has(cur)) keys = [cur];
  const saving = keys.length ? keys.reduce((s, k) => s + (net.get(k) ?? 0), 0) / keys.length : 0;
  const remaining = Math.max(0, o.target - (o.have ?? 0));
  const out: SavingForecast = {
    monthlySaving: round(saving),
    monthsUsed: keys.length,
    remaining: round(remaining),
    monthsNeeded: null,
    reachedOn: null,
  };
  if (remaining === 0) {
    out.monthsNeeded = 0;
    out.reachedOn = today;
  } else if (saving > 0) {
    out.monthsNeeded = Math.ceil(remaining / saving);
    out.reachedOn = addMonths(today, out.monthsNeeded);
  }
  if (o.byDate && /^\d{4}-\d{2}-\d{2}$/.test(o.byDate) && o.byDate > today) {
    const days = (Date.parse(o.byDate) - Date.parse(today)) / 86_400_000;
    const monthsLeft = Math.max(days / 30.4375, 0.1);
    const required = remaining / monthsLeft;
    out.byDate = {
      date: o.byDate,
      monthsLeft: round(monthsLeft, 1),
      requiredPerMonth: round(required),
      feasible: remaining === 0 || (saving > 0 && saving >= required),
    };
  }
  return out;
}
