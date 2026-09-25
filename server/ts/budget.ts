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

interface TxInput {
  type: TxType;
  amount: number | string;
  category: string;
  note?: string;
  date?: string;
}

function buildTx(input: TxInput): Transaction {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("invalid_amount");
  return {
    id: crypto.randomUUID(),
    type: input.type === "income" ? "income" : "expense",
    amount,
    category: String(input.category || "Другое").trim() || "Другое",
    note: String(input.note || ""),
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date! : new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
  };
}

export function create(input: TxInput): Transaction {
  const tx = buildTx(input);
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

/* --------------------------- CSV-импорт выписки --------------------------- */

/** Разбор одной CSV-строки с поддержкой "..." и экранированных "" внутри кавычек. */
function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === delimiter && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Приводит дату в разных распространённых форматах к YYYY-MM-DD. */
function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD.MM.YYYY или DD/MM/YYYY — типичный формат банковских выписок.
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Импорт операций из CSV. Понимает как «родной» формат (date,type,category,
 * amount,note — экспорт из этого же приложения), так и типичную банковскую
 * выписку (date,description,amount), где amount со знаком: отрицательный —
 * расход, положительный — доход. Разделитель — запятая или точка с запятой,
 * определяется по первой строке. Битые строки пропускаются, а не валят весь
 * импорт — CSV из банков часто содержит служебные/итоговые строки.
 */
export function importCsv(csvText: string): ImportResult {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { imported: 0, skipped: 0, errors: ["empty_file"] };

  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const header = parseCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());

  const idx = {
    date: header.findIndex((h) => /date|дата/.test(h)),
    type: header.findIndex((h) => /^type$|тип/.test(h)),
    amount: header.findIndex((h) => /amount|sum|сумма/.test(h)),
    category: header.findIndex((h) => /categor|категор/.test(h)),
    note: header.findIndex((h) => /note|desc|назначен|заметк|описан/.test(h)),
  };
  if (idx.amount === -1) return { imported: 0, skipped: 0, errors: ["no_amount_column"] };

  const errors: string[] = [];
  const toImport: Transaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], delimiter);
    try {
      const rawAmount = (cols[idx.amount] || "").replace(/\s/g, "").replace(",", ".");
      const num = parseFloat(rawAmount);
      if (!Number.isFinite(num) || num === 0) throw new Error("bad_amount");

      const type: TxType = idx.type !== -1 ? (/income|доход/i.test(cols[idx.type] || "") ? "income" : "expense") : num >= 0 ? "income" : "expense";
      const date = idx.date !== -1 ? normalizeDate(cols[idx.date] || "") : new Date().toISOString().slice(0, 10);
      if (!date) throw new Error("bad_date");

      toImport.push(
        buildTx({
          type,
          amount: Math.abs(num),
          category: idx.category !== -1 ? cols[idx.category] || "Импорт" : "Импорт",
          note: idx.note !== -1 ? cols[idx.note] || "" : "",
          date,
        }),
      );
    } catch {
      errors.push(`line_${i + 1}`);
    }
  }

  if (toImport.length > 0) {
    const all = readAll();
    all.push(...toImport);
    writeAll(all);
  }
  logger.info("budget.importCsv", { imported: toImport.length, skipped: errors.length });
  return { imported: toImport.length, skipped: errors.length, errors: errors.slice(0, 20) };
}
