/**
 * Центральный журнал «проблем» — то, о чём пользователь может сообщить одной кнопкой.
 *
 * Зачем отдельно от logger: logger пишет ВСЁ (клики, навигацию, отладку), и найти в нём
 * сбой тяжело. Здесь только ошибки и предупреждения, причём одинаковые склеиваются в одну
 * запись со счётчиком (иначе цикл с ошибкой за минуту забьёт журнал).
 *
 * Хранилище — storage/logs/problems.json (последние MAX_PROBLEMS записей). Запись
 * синхронная и атомарная (tmp + rename), чтобы крэш посреди записи не оставил битый файл.
 * Секреты в сообщения попадать не должны, но на всякий случай `redact` вырезает
 * похожие на ключи/токены строки и пользовательский каталог.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import config from "./config";

const { DIRS } = config;

export const MAX_PROBLEMS = 200;
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;

export type ProblemLevel = "warn" | "error";

export interface Problem {
  /** Отпечаток (источник + нормализованное сообщение) — по нему записи склеиваются. */
  id: string;
  level: ProblemLevel;
  /** Модуль-источник: "whisper", "backup", "ui" и т.п. */
  source: string;
  message: string;
  stack?: string;
  /** Сколько раз повторилось. */
  count: number;
  firstAt: number;
  lastAt: number;
  /** Произвольные безопасные подробности (без секретов). */
  context?: Record<string, string | number | boolean>;
}

function file(): string {
  return path.join(DIRS.logs, "problems.json");
}

/** Вырезает токены/ключи и домашний каталог пользователя. */
export function redact(text: string): string {
  let out = text;
  const home = os.homedir();
  if (home && home.length > 3) out = out.split(home).join("~");
  return out
    .replace(/\b(sk|pk|ghp|gho|xox[abp]|AIza)[-_A-Za-z0-9]{16,}/g, "[секрет]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [секрет]")
    .replace(/([?&](?:token|key|api_key|apikey|password|secret)=)[^&\s]+/gi, "$1[секрет]");
}

function normalizeForId(message: string): string {
  // числа, UUID и пути меняются от раза к разу — не должны плодить «разные» проблемы
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[A-Za-z]:\[^\s'"]+/g, "<path>")
    .replace(/\d+/g, "#")
    .slice(0, 200);
}

function read(): Problem[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(parsed) ? (parsed as Problem[]) : [];
  } catch {
    return [];
  }
}

function write(items: Problem[]): void {
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(items), "utf8");
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* временного файла может не быть — это нормально */
    }
  }
}

export interface ReportInput {
  source: string;
  error: unknown;
  level?: ProblemLevel;
  context?: Problem["context"];
}

/** Записать проблему. Никогда не бросает — журнал не должен ронять вызывающий код. */
export function reportProblem(input: ReportInput): Problem | null {
  try {
    const err = input.error;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = redact(rawMessage).slice(0, MAX_MESSAGE);
    const stack =
      err instanceof Error && err.stack ? redact(err.stack).slice(0, MAX_STACK) : undefined;
    const id = crypto
      .createHash("sha1")
      .update(`${input.source}\u0000${normalizeForId(message)}`)
      .digest("hex")
      .slice(0, 12);
    const now = Date.now();
    const items = read();
    const existing = items.find((p) => p.id === id);
    let result: Problem;
    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
      if (input.level === "error") existing.level = "error";
      result = existing;
    } else {
      result = {
        id,
        level: input.level ?? "error",
        source: input.source,
        message,
        stack,
        count: 1,
        firstAt: now,
        lastAt: now,
        context: input.context,
      };
      items.push(result);
    }
    items.sort((a, b) => b.lastAt - a.lastAt);
    write(items.slice(0, MAX_PROBLEMS));
    return result;
  } catch {
    return null;
  }
}

/** Проблемы от новых к старым. */
export function listProblems(): Problem[] {
  return read().sort((a, b) => b.lastAt - a.lastAt);
}

export function clearProblems(): void {
  write([]);
}

/** Текст для диагностики: компактно, без стеков (стеки — в zip). */
export function summarize(items: Problem[] = listProblems()): string {
  if (!items.length) return "Проблем не зафиксировано.";
  return items
    .map((p) => {
      const when = new Date(p.lastAt).toISOString();
      return `[${p.level}] ${p.source} ×${p.count} (${when}) ${p.message}`;
    })
    .join("\n");
}
