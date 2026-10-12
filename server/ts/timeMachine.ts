/**
 * «Машина времени»: состояние данных на выбранную дату. Только чтение —
 * живые данные приложения не переписываются.
 *
 * Источники:
 *  - заметки и доски — снимки git-репозитория vault (notesGit.snapshot);
 *  - траты — операции с датой не позже выбранной;
 *  - задачи — по created_at; статус «выполнена» учитывается, только если
 *    задача обновлялась не позже даты (иначе тогда она ещё была открыта) —
 *    истории смены статусов приложение не хранит, это приближение;
 *  - дневник — запись этого дня.
 *
 * Здесь — чистая логика над массивами; чтение репозитория и файлов — в routes.
 */

export interface CommitInfo {
  oid: string;
  timestamp: number;
  message: string;
}

export interface TxLite {
  type: "income" | "expense";
  amount: number;
  category: string;
  date: string;
  currency?: string;
  rates?: Record<string, number> | null;
}

export interface TaskLite {
  id: string;
  title: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  dueDate?: string | null;
}

const DAY_MS = 86_400_000;

/** Конец локального дня YYYY-MM-DD в мс (включительно). */
export function endOfDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
}

export function dateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Последний коммит не позже момента ts; null — на эту дату истории ещё нет. */
export function pickCommit(commits: CommitInfo[], ts: number): CommitInfo | null {
  let best: CommitInfo | null = null;
  for (const c of commits) {
    if (c.timestamp <= ts && (!best || c.timestamp > best.timestamp)) best = c;
  }
  return best;
}

/** Границы ползунка: от самой ранней записи до сегодня. */
export function rangeOf(p: {
  commits: CommitInfo[];
  txDates: string[];
  taskCreated: string[];
  diaryDates: string[];
  now?: number;
}): { from: string; to: string } {
  const now = p.now ?? Date.now();
  const times: number[] = [now];
  for (const c of p.commits) times.push(c.timestamp);
  for (const d of [...p.txDates, ...p.diaryDates]) {
    const t = endOfDay(d);
    if (Number.isFinite(t)) times.push(t - DAY_MS + 1);
  }
  for (const s of p.taskCreated) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) times.push(t);
  }
  return { from: dateKey(Math.min(...times)), to: dateKey(now) };
}

export interface BudgetState {
  count: number;
  income: number;
  expense: number;
  balance: number;
  /** Траты по категориям за месяц выбранной даты, по убыванию. */
  monthByCategory: { category: string; amount: number }[];
}

/** Сумма в рублях: по курсу операции, если он сохранён; иначе как есть для RUB. */
function toRub(t: TxLite): number {
  const cur = (t.currency || "RUB").toUpperCase();
  if (cur === "RUB") return t.amount;
  const r = t.rates?.[cur];
  return typeof r === "number" && r > 0 ? t.amount * r : t.amount;
}

export function budgetAsOf(txs: TxLite[], date: string): BudgetState {
  const upTo = txs.filter((t) => t.date <= date);
  let income = 0;
  let expense = 0;
  const month = date.slice(0, 7);
  const cats = new Map<string, number>();
  for (const t of upTo) {
    const v = toRub(t);
    if (t.type === "income") income += v;
    else {
      expense += v;
      if (t.date.startsWith(month)) cats.set(t.category, (cats.get(t.category) ?? 0) + v);
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    count: upTo.length,
    income: r(income),
    expense: r(expense),
    balance: r(income - expense),
    monthByCategory: [...cats.entries()]
      .map(([category, amount]) => ({ category, amount: r(amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export interface TaskState {
  id: string;
  title: string;
  status: "open" | "done";
  dueDate: string | null;
}

export function tasksAsOf(tasks: TaskLite[], date: string): TaskState[] {
  const end = endOfDay(date);
  const out: TaskState[] = [];
  for (const t of tasks) {
    const created = t.created_at ? Date.parse(t.created_at) : NaN;
    if (Number.isFinite(created) && created > end) continue;
    const updated = t.updated_at ? Date.parse(t.updated_at) : NaN;
    const isDone = t.status === "completed" || t.status === "done";
    const doneThen = isDone && Number.isFinite(updated) && updated <= end;
    out.push({
      id: t.id,
      title: t.title,
      status: doneThen ? "done" : "open",
      dueDate: t.dueDate ?? null,
    });
  }
  return out;
}

/** Итоговая сумма сводки по дате — для подписи под ползунком. */
export function describeShift(fromDate: string, toDate: string): number {
  const a = endOfDay(fromDate);
  const b = endOfDay(toDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** Пора ли делать автоснимок. */
export function shouldSnapshot(lastAt: number, now: number, hours: number): boolean {
  return now - lastAt >= Math.max(1, hours) * 3_600_000;
}

/** Имя файла для копии, восстановленной из прошлого: рядом с исходным, ничего не затирает. */
export function restoredName(notePath: string, date: string, exists: (p: string) => boolean): string {
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(notePath) ?? [];
  const base = m[1] ?? notePath;
  const ext = m[2] ?? "";
  let candidate = `${base} (из ${date})${ext}`;
  for (let i = 2; exists(candidate) && i < 100; i++) candidate = `${base} (из ${date}) ${i}${ext}`;
  return candidate;
}
