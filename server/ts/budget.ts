/**
 * Бюджет/финансы: локальный трекер доходов/расходов по категориям +
 * помесячная агрегация для графиков. Никаких банковских интеграций —
 * только ручной ввод, хранится в одном JSON-файле, как остальные простые
 * стораджи проекта (bookmarks.ts, musicPlaylists.ts).
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";

const { FILES } = config;

export type TxType = "income" | "expense";

export interface Transaction {
  id: string;
  type: TxType;
  amount: number;
  category: string;
  note: string;
  date: string; // YYYY-MM-DD
  createdAt: number;
}

export const DEFAULT_CATEGORIES = {
  expense: ["Еда", "Транспорт", "Жильё", "Развлечения", "Здоровье", "Подписки", "Другое"],
  income: ["Зарплата", "Подработка", "Подарки", "Другое"],
};

function readAll(): Transaction[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.budgetTransactions, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(items: Transaction[]): void {
  fs.writeFileSync(FILES.budgetTransactions, JSON.stringify(items, null, 2), "utf8");
}

export function list(): Transaction[] {
  return readAll().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

export function create(input: {
  type: TxType;
  amount: number;
  category: string;
  note?: string;
  date?: string;
}): Transaction {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("invalid_amount");
  const tx: Transaction = {
    id: crypto.randomUUID(),
    type: input.type === "income" ? "income" : "expense",
    amount,
    category: String(input.category || "Другое").trim() || "Другое",
    note: String(input.note || ""),
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date! : new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
  };
  const all = readAll();
  all.push(tx);
  writeAll(all);
  logger.info("budget.create", { id: tx.id, type: tx.type, amount: tx.amount });
  return tx;
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export interface MonthSummary {
  month: string; // YYYY-MM
  income: number;
  expense: number;
  byCategory: Record<string, number>; // только расходы, для пирога
}

/** Агрегация по месяцам за последние N месяцев (включая текущий), от старых к новым. */
export function monthlySummary(months = 6): MonthSummary[] {
  const all = readAll();
  const now = new Date();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const byMonth = new Map<string, MonthSummary>(
    keys.map((k) => [k, { month: k, income: 0, expense: 0, byCategory: {} }]),
  );
  for (const tx of all) {
    const key = tx.date.slice(0, 7);
    const bucket = byMonth.get(key);
    if (!bucket) continue;
    if (tx.type === "income") bucket.income += tx.amount;
    else {
      bucket.expense += tx.amount;
      bucket.byCategory[tx.category] = (bucket.byCategory[tx.category] || 0) + tx.amount;
    }
  }
  return keys.map((k) => byMonth.get(k)!);
}
