/**
 * Бюджет: подписки и регулярные платежи, прогноз месяца, импорт OFX.
 *
 * Чистая логика (даты, повторения, парсинг) вынесена в экспортируемые функции без
 * обращения к диску — их покрывают tests/budgetRecurring.test.ts. Хранение —
 * отдельный JSON рядом с операциями (storage/budget-recurring.json).
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";
import * as budget from "./budget";
import type { Transaction } from "./budget";
import type {
  Forecast,
  Recurring,
  RecurringInput,
  RecurringInterval,
  Upcoming,
} from "./contracts/budget";

const { FILES } = config;

export type Interval = RecurringInterval;
export type { Recurring, RecurringInput, Upcoming, Forecast };

/* ----------------------------- даты и повторения ---------------------------- */

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Разбор YYYY-MM-DD в локальную дату (без сдвига часового пояса). */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const DAY = 24 * 3600 * 1000;

/** Разница в днях между двумя датами YYYY-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / DAY);
}

/**
 * N-я дата повторения. Для месяцев/лет день удерживается «якорным» числом из
 * startDate: платёж «31-го» в феврале приходится на последний день месяца, а в
 * марте снова на 31-е (а не «залипает» на 28-м).
 */
export function occurrence(startDate: string, interval: Interval, n: number): string {
  const s = parseYmd(startDate);
  if (interval === "week") return ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * n));
  const months = interval === "month" ? n : 12 * n;
  const first = new Date(s.getFullYear(), s.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(s.getDate(), last)));
}

/** Все даты списаний в окне [from, to] (включительно), с учётом endDate. */
export function occurrencesBetween(r: Recurring, from: string, to: string): string[] {
  const out: string[] = [];
  for (let n = 0; n < 5000; n++) {
    const d = occurrence(r.startDate, r.interval, n);
    if (d > to || (r.endDate && d > r.endDate)) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Ближайшее непроведённое списание (первое после lastPaid, не раньше startDate). */
export function nextDue(r: Recurring): string | null {
  if (!r.active) return null;
  for (let n = 0; n < 5000; n++) {
    const d = occurrence(r.startDate, r.interval, n);
    if (r.endDate && d > r.endDate) return null;
    if (!r.lastPaid || d > r.lastPaid) return d;
  }
  return null;
}

/** Предстоящие и просроченные списания на `days` дней вперёд, ближайшие первыми. */
export function upcoming(list: Recurring[], today: string, days: number): Upcoming[] {
  const out: Upcoming[] = [];
  for (const r of list) {
    const due = nextDue(r);
    if (!due) continue;
    const inDays = daysBetween(today, due);
    if (inDays > days) continue;
    out.push({ recurring: r, due, inDays, remind: inDays <= r.remindDays });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** Эквивалент платежа в месяц — для подсказки «подписки обходятся в N ₽/мес». */
export function monthlyEquivalent(r: Recurring): number {
  const k = r.interval === "week" ? 52 / 12 : r.interval === "month" ? 1 : 1 / 12;
  return Math.round(r.amount * k * 100) / 100;
}

/* --------------------------------- прогноз --------------------------------- */

/**
 * Прогноз расхода месяца: уже потрачено + обычный темп трат на оставшиеся дни +
 * регулярные платежи, которые ещё впереди. Регулярные уже оплаченные в этом месяце
 * (они есть в «потрачено») в темп не входят, иначе подписки считались бы дважды.
 */
export function forecastMonth(
  txs: Transaction[],
  recs: Recurring[],
  today: string,
  currency = "RUB",
): Forecast {
  const month = today.slice(0, 7);
  const t = parseYmd(today);
  const daysInMonth = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const dayOfMonth = t.getDate();
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  let skipped = 0;

  const recNames = new Set(recs.filter((r) => r.type === "expense").map((r) => r.name));
  let spent = 0;
  let spentRecurring = 0;
  for (const tx of txs) {
    if (tx.type !== "expense" || !tx.date.startsWith(month) || tx.date > today) continue;
    const amount = budget.convertAmount(tx, currency);
    if (amount === null) {
      skipped++;
      continue;
    }
    spent += amount;
    if (tx.note && recNames.has(tx.note)) spentRecurring += amount;
  }

  let ahead = 0;
  for (const r of recs) {
    if (!r.active || r.type !== "expense") continue;
    if (r.currency.toUpperCase() !== currency) {
      skipped++;
      continue;
    }
    const tomorrow = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
    const dates = occurrencesBetween(r, tomorrow, monthEnd).filter((d) => !r.lastPaid || d > r.lastPaid);
    ahead += dates.length * r.amount;
  }

  const variableSoFar = Math.max(0, spent - spentRecurring);
  const dailyVariable = variableSoFar / Math.max(1, dayOfMonth);
  const daysLeft = daysInMonth - dayOfMonth;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    month,
    spentSoFar: r2(spent),
    recurringAhead: r2(ahead),
    dailyVariable: r2(dailyVariable),
    projectedTotal: r2(spent + dailyVariable * daysLeft + ahead),
    skipped,
    currency,
  };
}

/* ---------------------------------- OFX ----------------------------------- */

export interface ParsedOfx {
  items: { date: string; amount: number; name: string; fitid: string; currency?: string }[];
  currency?: string;
  skipped: number;
}

/** Достаёт значение SGML/XML-тега OFX: `<NAME>Кофе` и `<NAME>Кофе</NAME>`. */
function ofxTag(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? m[1].trim() : "";
}

/** Разбор выписки OFX/QFX (v1 SGML и v2 XML): операции STMTTRN со знаком суммы. */
export function parseOfx(text: string): ParsedOfx {
  const currency = ofxTag(text, "CURDEF").toUpperCase() || undefined;
  const items: ParsedOfx["items"] = [];
  let skipped = 0;
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const amount = parseFloat(ofxTag(block, "TRNAMT").replace(",", "."));
    const dt = ofxTag(block, "DTPOSTED").match(/^(\d{4})(\d{2})(\d{2})/);
    if (!Number.isFinite(amount) || amount === 0 || !dt) {
      skipped++;
      continue;
    }
    items.push({
      date: `${dt[1]}-${dt[2]}-${dt[3]}`,
      amount,
      name: ofxTag(block, "NAME") || ofxTag(block, "MEMO") || "",
      fitid: ofxTag(block, "FITID"),
      currency: ofxTag(block, "CURRENCY").toUpperCase() || currency,
    });
  }
  return { items, currency, skipped };
}

/* -------------------------------- хранилище -------------------------------- */

function readAll(): Recurring[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.budgetRecurring, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function writeAll(items: Recurring[]): void {
  fs.writeFileSync(FILES.budgetRecurring, JSON.stringify(items, null, 2), "utf8");
}

export function list(): Recurring[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function create(input: RecurringInput): Recurring {
  const amount = Number(input.amount);
  const name = String(input.name || "").trim();
  if (!name) throw new Error("invalid_name");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("invalid_amount");
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(input.startDate || "")
    ? input.startDate!
    : ymd(new Date());
  const r: Recurring = {
    id: crypto.randomUUID(),
    name,
    amount,
    currency: String(input.currency || "RUB").toUpperCase(),
    category: String(input.category || "Подписки").trim() || "Подписки",
    type: input.type === "income" ? "income" : "expense",
    interval: input.interval === "week" || input.interval === "year" ? input.interval : "month",
    startDate,
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(input.endDate || "") ? input.endDate : undefined,
    remindDays: Math.max(0, Math.min(60, Number(input.remindDays ?? 3) || 0)),
    active: true,
  };
  const all = readAll();
  all.push(r);
  writeAll(all);
  logger.info("budget.recurring.create", { id: r.id, interval: r.interval });
  return r;
}

export function update(id: string, patch: Partial<RecurringInput> & { active?: boolean }): Recurring | null {
  const all = readAll();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const cur = all[i];
  const merged: Recurring = { ...cur };
  if (patch.name !== undefined && String(patch.name).trim()) merged.name = String(patch.name).trim();
  if (patch.amount !== undefined && Number(patch.amount) > 0) merged.amount = Number(patch.amount);
  if (patch.interval === "week" || patch.interval === "month" || patch.interval === "year")
    merged.interval = patch.interval;
  if (patch.active !== undefined) merged.active = !!patch.active;
  if (patch.remindDays !== undefined) merged.remindDays = Math.max(0, Math.min(60, Number(patch.remindDays) || 0));
  if (patch.endDate !== undefined)
    merged.endDate = /^\d{4}-\d{2}-\d{2}$/.test(patch.endDate || "") ? patch.endDate : undefined;
  all[i] = merged;
  writeAll(all);
  return merged;
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** Провести ближайшее списание как обычную операцию и сдвинуть lastPaid. */
export async function markPaid(id: string): Promise<Transaction | null> {
  const all = readAll();
  const r = all.find((x) => x.id === id);
  if (!r) return null;
  const due = nextDue(r);
  if (!due) return null;
  const tx = await budget.create({
    type: r.type,
    amount: r.amount,
    category: r.category,
    note: r.name,
    date: due,
    currency: r.currency,
  });
  r.lastPaid = due;
  writeAll(all);
  return tx;
}

export function getUpcoming(days: number): Upcoming[] {
  return upcoming(readAll(), ymd(new Date()), days);
}

export function getForecast(currency = "RUB"): Forecast {
  return forecastMonth(budget.list(), readAll(), ymd(new Date()), currency.toUpperCase());
}
