/**
 * Бюджет: инсайты по операциям (чистые функции, без файлов и сети).
 *
 *  - runway: «хватит ли до зарплаты» — сколько дней покрывают деньги при текущих тратах;
 *  - forgottenSubscriptions: регулярные списания, похожие на подписки;
 *  - compareMonths: сравнение расходов двух месяцев по категориям;
 *  - personalInflation: как изменились цены на то, что вы покупаете регулярно;
 *  - whatIf: сколько даст сокращение расходов по категориям;
 *  - taxDeductions: оценка социального вычета (лечение, учёба, спорт).
 *
 * Суммы берутся как есть: операции в разных валютах нужно предварительно
 * привести к одной (см. budget.convertAmount).
 */

export interface Tx {
  type: "income" | "expense";
  amount: number;
  category: string;
  note: string;
  /** YYYY-MM-DD */
  date: string;
}

const DAY = 86_400_000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const toTime = (s: string): number => Date.parse(`${s}T00:00:00Z`);
const round = (n: number): number => Math.round(n * 100) / 100;

/** Название покупки без цифр, дат и регистра — для группировки одинаковых. */
export function normalizeNote(note: string, category = ""): string {
  const n = String(note || "")
    .toLowerCase()
    .replace(/\d+([.,]\d+)?/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n || category.toLowerCase();
}

/* ------------------------- Хватит ли до зарплаты ------------------------- */

export interface Runway {
  daysUntilPayday: number;
  /** Средние ежедневные траты за окно (без крупных разовых — см. trimTop). */
  avgDaily: number;
  /** Ожидаемые обязательные платежи до зарплаты (передаются вызывающим). */
  fixedUntilPayday: number;
  projectedSpend: number;
  /** Сколько останется (минус — не хватит). */
  leftover: number;
  /** Сколько можно тратить в день, чтобы дожить до зарплаты. */
  dailyAllowance: number;
  /** На сколько дней хватит при текущем темпе (с учётом обязательных платежей). */
  coveredDays: number;
  enough: boolean;
}

export function runway(opts: {
  txs: Tx[];
  available: number;
  today: string;
  payday: string;
  /** Обязательные платежи до зарплаты (например, из регулярных платежей). */
  fixedUntilPayday?: number;
  /** Окно для среднего, дней. */
  windowDays?: number;
  /** Не учитывать столько самых крупных трат окна (аренда, покупки) в «обычном» темпе. */
  trimTop?: number;
}): Runway {
  const window = opts.windowDays ?? 30;
  const t0 = toTime(opts.today);
  const from = t0 - window * DAY;
  const spends = opts.txs
    .filter((t) => t.type === "expense" && toTime(t.date) > from && toTime(t.date) <= t0)
    .map((t) => t.amount)
    .sort((a, b) => b - a);
  const kept = spends.slice(Math.min(opts.trimTop ?? 0, spends.length));
  const avgDaily = kept.reduce((s, v) => s + v, 0) / window;
  const days = Math.max(0, Math.round((toTime(opts.payday) - t0) / DAY));
  const fixed = opts.fixedUntilPayday ?? 0;
  const projected = avgDaily * days + fixed;
  const free = opts.available - fixed;
  return {
    daysUntilPayday: days,
    avgDaily: round(avgDaily),
    fixedUntilPayday: round(fixed),
    projectedSpend: round(projected),
    leftover: round(opts.available - projected),
    dailyAllowance: days > 0 ? round(Math.max(0, free) / days) : round(Math.max(0, free)),
    coveredDays: avgDaily > 0 ? Math.max(0, Math.floor(free / avgDaily)) : days,
    enough: opts.available >= projected,
  };
}

/* ------------------------- Забытые подписки ------------------------- */

export interface Subscription {
  name: string;
  category: string;
  amount: number;
  /** Средний интервал между списаниями, дней. */
  everyDays: number;
  charges: number;
  lastDate: string;
  monthlyCost: number;
  yearlyCost: number;
  /** Не списывалось уже дольше двух интервалов — возможно, давно неактуально/отменено. */
  stale: boolean;
}

/**
 * Ищет регулярные списания: одинаковое название, сумма в пределах ±10 %, не
 * меньше трёх списаний с шагом 7–40 дней (неделя … месяц с запасом).
 */
export function findSubscriptions(txs: Tx[], today: string): Subscription[] {
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const key = normalizeNote(t.note, t.category);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const out: Subscription[] = [];
  for (const [name, list] of groups) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const med = [...sorted.map((t) => t.amount)].sort((a, b) => a - b)[Math.floor(sorted.length / 2)];
    const same = sorted.filter((t) => Math.abs(t.amount - med) <= med * 0.1);
    if (same.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < same.length; i++) gaps.push((toTime(same[i].date) - toTime(same[i - 1].date)) / DAY);
    const every = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    const steady = gaps.every((g) => Math.abs(g - every) <= Math.max(4, every * 0.25));
    if (!steady || every < 7 || every > 40) continue;
    const last = same[same.length - 1];
    const monthly = (med * 30) / every;
    out.push({
      name,
      category: last.category,
      amount: round(med),
      everyDays: Math.round(every),
      charges: same.length,
      lastDate: last.date,
      monthlyCost: round(monthly),
      yearlyCost: round(monthly * 12),
      stale: (toTime(today) - toTime(last.date)) / DAY > every * 2,
    });
  }
  return out.sort((a, b) => b.yearlyCost - a.yearlyCost);
}

/* ------------------------- Сравнение месяцев ------------------------- */

export interface MonthDelta {
  category: string;
  a: number;
  b: number;
  delta: number;
  /** Процент относительно a; null, если в a ничего не было. */
  pct: number | null;
}

export function compareMonths(txs: Tx[], monthA: string, monthB: string): {
  totalA: number;
  totalB: number;
  categories: MonthDelta[];
} {
  const sums = (m: string): Map<string, number> => {
    const r = new Map<string, number>();
    for (const t of txs) {
      if (t.type === "expense" && t.date.startsWith(m)) r.set(t.category, (r.get(t.category) ?? 0) + t.amount);
    }
    return r;
  };
  const a = sums(monthA);
  const b = sums(monthB);
  const cats = new Set([...a.keys(), ...b.keys()]);
  const categories = [...cats].map((c) => {
    const av = a.get(c) ?? 0;
    const bv = b.get(c) ?? 0;
    return {
      category: c,
      a: round(av),
      b: round(bv),
      delta: round(bv - av),
      pct: av > 0 ? Math.round(((bv - av) / av) * 1000) / 10 : null,
    };
  });
  categories.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const total = (m: Map<string, number>): number => round([...m.values()].reduce((s, v) => s + v, 0));
  return { totalA: total(a), totalB: total(b), categories };
}

/* ------------------------- Личная инфляция ------------------------- */

export interface PriceChange {
  name: string;
  first: number;
  last: number;
  pct: number;
  purchases: number;
}

/**
 * Для покупок, которые повторялись не менее трёх раз за период в 60+ дней,
 * сравнивает среднюю цену первой и последней трети. Итог — средневзвешенное
 * изменение по объёму трат.
 */
export function personalInflation(txs: Tx[]): { overallPct: number | null; items: PriceChange[] } {
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const key = normalizeNote(t.note);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const items: PriceChange[] = [];
  let weighted = 0;
  let weight = 0;
  for (const [name, list] of groups) {
    if (list.length < 3) continue;
    const s = [...list].sort((a, b) => a.date.localeCompare(b.date));
    if ((toTime(s[s.length - 1].date) - toTime(s[0].date)) / DAY < 60) continue;
    const n = Math.max(1, Math.floor(s.length / 3));
    const avg = (arr: Tx[]): number => arr.reduce((x, t) => x + t.amount, 0) / arr.length;
    const first = avg(s.slice(0, n));
    const last = avg(s.slice(-n));
    if (first <= 0) continue;
    const pct = ((last - first) / first) * 100;
    const volume = s.reduce((x, t) => x + t.amount, 0);
    items.push({ name, first: round(first), last: round(last), pct: Math.round(pct * 10) / 10, purchases: s.length });
    weighted += pct * volume;
    weight += volume;
  }
  items.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return { overallPct: weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null, items };
}

/* ------------------------- Что если ------------------------- */

export function whatIf(
  txs: Tx[],
  cut: Record<string, number>,
  opts: { months?: number; today?: string } = {},
): { perMonth: number; perYear: number; byCategory: { category: string; perMonth: number }[] } {
  const months = opts.months ?? 3;
  const end = opts.today ? toTime(opts.today) : Date.now();
  const from = end - months * 30 * DAY;
  const totals = new Map<string, number>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const ts = toTime(t.date);
    if (ts > from && ts <= end) totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
  }
  const byCategory = Object.entries(cut)
    .map(([category, pct]) => ({
      category,
      perMonth: round(((totals.get(category) ?? 0) / months) * (Math.min(100, Math.max(0, pct)) / 100)),
    }))
    .filter((c) => c.perMonth > 0)
    .sort((a, b) => b.perMonth - a.perMonth);
  const perMonth = round(byCategory.reduce((s, c) => s + c.perMonth, 0));
  return { perMonth, perYear: round(perMonth * 12), byCategory };
}

/* ------------------------- Налоговые вычеты (РФ) ------------------------- */

export type DeductionKind = "medicine" | "education" | "sport";

const DEDUCTION_RULES: { kind: DeductionKind; re: RegExp }[] = [
  { kind: "medicine", re: /медиц|врач|аптек|лекарств|стоматолог|клиник|больниц|анализ|поликлиник|здоровь/i },
  { kind: "education", re: /обучен|курс|школ|универс|институт|репетитор|тренинг|образован/i },
  { kind: "sport", re: /фитнес|спортзал|спорт|бассейн|тренажёр|тренажер/i },
];

export interface DeductionYear {
  year: number;
  byKind: Record<DeductionKind, number>;
  total: number;
  /** Сумма в пределах лимита социального вычета. */
  eligible: number;
  /** Возврат НДФЛ по ставке rate. */
  refund: number;
  overLimit: number;
}

/**
 * Социальный налоговый вычет по расходам на лечение, учёбу и спорт: считает траты
 * по ключевым словам категории/заметки за каждый год. Лимит и ставка настраиваются
 * (по умолчанию 150 000 ₽ и 13%). Это оценка — факт определяет ФНС.
 */
export function taxDeductions(
  txs: Tx[],
  opts: { limit?: number; rate?: number } = {},
): { years: DeductionYear[]; limit: number; rate: number } {
  const limit = opts.limit ?? 150_000;
  const rate = opts.rate ?? 0.13;
  const byYear = new Map<number, Record<DeductionKind, number>>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const hay = `${t.category} ${t.note}`;
    const rule = DEDUCTION_RULES.find((r) => r.re.test(hay));
    if (!rule) continue;
    const year = Number(t.date.slice(0, 4));
    if (!year) continue;
    const cur = byYear.get(year) ?? { medicine: 0, education: 0, sport: 0 };
    cur[rule.kind] += t.amount;
    byYear.set(year, cur);
  }
  const years = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, k]) => {
      const byKind = { medicine: round(k.medicine), education: round(k.education), sport: round(k.sport) };
      const total = round(byKind.medicine + byKind.education + byKind.sport);
      const eligible = Math.min(total, limit);
      return {
        year,
        byKind,
        total,
        eligible: round(eligible),
        refund: round(eligible * rate),
        overLimit: round(Math.max(0, total - limit)),
      };
    });
  return { years, limit, rate };
}

export { ymd };
