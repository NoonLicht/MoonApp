/**
 * «Контракты с собой»: правило вида «не больше 2 часов видео в день» или
 * «не больше 15 000 на еду в месяц». Приложение сверяет его с реальными
 * данными и мягко сообщает статус — без уведомлений и тревожных сигналов.
 */
import fs from "fs";
import path from "path";
import { categoryOf, type AppCategory, type HourStats } from "./attentionMap";

export type Metric =
  | "category_minutes_day"
  | "app_minutes_day"
  | "spend_day"
  | "spend_month"
  | "category_spend_month";

export interface Contract {
  id: string;
  label: string;
  metric: Metric;
  /** Категория приложений, имя процесса или категория трат — по метрике. */
  target: string;
  limit: number;
  createdAt: number;
}

export interface Snapshot {
  /** Секунды по приложениям за сегодня. */
  appSecondsToday: Record<string, number>;
  spendToday: number;
  spendMonth: number;
  spendByCategoryMonth: Record<string, number>;
}

export type Status = "ok" | "near" | "over";

export interface Evaluation {
  contract: Contract;
  value: number;
  ratio: number;
  status: Status;
  /** Единица для показа: минуты или деньги. */
  unit: "min" | "money";
}

export const NEAR_RATIO = 0.8;

const CATEGORIES: AppCategory[] = ["browser", "dev", "chat", "media", "game", "office", "other"];

export function isValid(c: Partial<Contract>): string | null {
  const metrics: Metric[] = [
    "category_minutes_day",
    "app_minutes_day",
    "spend_day",
    "spend_month",
    "category_spend_month",
  ];
  if (!c.metric || !metrics.includes(c.metric)) return "bad_metric";
  if (!(Number(c.limit) > 0)) return "bad_limit";
  if (c.metric === "category_minutes_day" && !CATEGORIES.includes(c.target as AppCategory)) return "bad_target";
  if ((c.metric === "app_minutes_day" || c.metric === "category_spend_month") && !String(c.target ?? "").trim())
    return "bad_target";
  return null;
}

export function evaluate(c: Contract, s: Snapshot): Evaluation {
  let value = 0;
  let unit: Evaluation["unit"] = "money";
  switch (c.metric) {
    case "category_minutes_day": {
      unit = "min";
      let sec = 0;
      for (const [app, v] of Object.entries(s.appSecondsToday)) if (categoryOf(app) === c.target) sec += v;
      value = sec / 60;
      break;
    }
    case "app_minutes_day": {
      unit = "min";
      const want = c.target.trim().toLowerCase();
      let sec = 0;
      for (const [app, v] of Object.entries(s.appSecondsToday)) if (app.toLowerCase() === want) sec += v;
      value = sec / 60;
      break;
    }
    case "spend_day":
      value = s.spendToday;
      break;
    case "spend_month":
      value = s.spendMonth;
      break;
    case "category_spend_month": {
      const want = c.target.trim().toLowerCase();
      for (const [cat, v] of Object.entries(s.spendByCategoryMonth))
        if (cat.toLowerCase() === want) value += v;
      break;
    }
  }
  value = Math.round(value * 10) / 10;
  const ratio = c.limit > 0 ? value / c.limit : 0;
  return {
    contract: c,
    value,
    ratio: Math.round(ratio * 100) / 100,
    status: ratio > 1 ? "over" : ratio >= NEAR_RATIO ? "near" : "ok",
    unit,
  };
}

/** Секунды по приложениям за локальный день из почасовой статистики. */
export function appSecondsFor(stats: HourStats, date: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const apps of Object.values(stats[date] ?? {}))
    for (const [app, sec] of Object.entries(apps)) out[app] = (out[app] ?? 0) + sec;
  return out;
}

export function spendSnapshot(
  txs: { type: string; amount: number; category: string; date: string }[],
  date: string,
): Pick<Snapshot, "spendToday" | "spendMonth" | "spendByCategoryMonth"> {
  const month = date.slice(0, 7);
  let day = 0;
  let mon = 0;
  const by: Record<string, number> = {};
  for (const t of txs) {
    if (t.type !== "expense" || t.date > date) continue;
    if (t.date === date) day += t.amount;
    if (t.date.startsWith(month)) {
      mon += t.amount;
      by[t.category] = (by[t.category] ?? 0) + t.amount;
    }
  }
  return { spendToday: day, spendMonth: mon, spendByCategoryMonth: by };
}

let seq = 0;
export function makeContract(p: Omit<Contract, "id" | "createdAt">, now: number): Contract {
  return {
    ...p,
    label: p.label.trim().slice(0, 100),
    target: String(p.target ?? "").trim().slice(0, 60),
    limit: Number(p.limit),
    id: `${now.toString(36)}${(seq++ % 1296).toString(36)}`,
    createdAt: now,
  };
}

// ---------------- хранение ----------------

function file(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "self-contracts.json");
}

export function load(f = file()): Contract[] {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function save(list: Contract[], f = file()): void {
  fs.writeFileSync(f, JSON.stringify(list), "utf8");
}
