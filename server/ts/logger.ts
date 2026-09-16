/**
 * Журналирование событий в два NDJSON-файла.
 *
 * Формат строки: {"ts","level","event","data"}
 *
 * Два независимых журнала:
 *   1) logs/app.log  — рабочий лог, фильтруется настройками advanced.*
 *      (logLevel — системные события, telemetry — события уровня "action");
 *   2) logs/audit.log — ПОЛНЫЙ журнал без фильтров: пишутся все события.
 *      Нужен для кнопки «Собрать логи» в Настройках: пользователь одним файлом
 *      отдаёт разработчику всё — клики, навигацию, загрузки, ошибки,
 *      предупреждения. Ротация: >8 МБ → audit.1.log (предыдущий архив).
 *
 * Настройки из advanced.* управляют записью в app.log:
 *   advanced.logLevel = "debug" | "info" | "warn" | "error" — минимальная
 *     ВАЖНОСТЬ события (ниже порога — не пишется);
 *   advanced.telemetry = false — события уровня "action" (клики, навигация) не пишутся.
 *
 * TS-исходник, как server/ts/monitor.ts: компилируется в server/logger.js
 * командой `npm run compile:server`. Модуль остаётся CommonJS (`export =`),
 * потому что ~50 обычных .js-модулей делают require("./logger") и ждут объект с
 * методами напрямую, а не { default: ... }.
 */
import fs from "fs";
import path from "path";
import config from "./config";

const { DIRS, FILES } = config;

/** Уровень важности события в журнале. */
type LogLevel = "debug" | "info" | "warn" | "error" | "action";

/** Одна запись журнала: {"ts","level","event","data"}. */
interface LogEntry {
  level: LogLevel;
  event: string;
  data?: unknown;
}

/** Фильтры рабочего журнала, прочитанные из advanced.* настроек. */
interface LevelFilter {
  logLevel: LogLevel;
  telemetry: boolean;
}
// Файл настроек читается напрямую (без require("./settings")), т.к. settings.js
// сам использует logger — так избегаем циклической зависимости.
let cachedFilter: LevelFilter | null = null;
let cachedAt = 0;

/** Уровни системных событий (action — телеметрия пользователя, не важность). */
const SYSTEM_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Фильтры записи в app.log; кэш на 10 секунд, чтобы не читать файл на каждое событие. */
function levelFilter(): LevelFilter {
  const now = Date.now();
  if (cachedFilter && now - cachedAt < 10_000) return cachedFilter;
  cachedAt = now;
  let logLevel: LogLevel = "info";
  let telemetry = false;
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.settings, "utf8")) as {
      advanced?: { logLevel?: unknown; telemetry?: unknown };
    };
    const advanced = raw?.advanced ?? {};
    if (
      typeof advanced.logLevel === "string" &&
      (SYSTEM_LEVELS as string[]).includes(advanced.logLevel)
    ) {
      logLevel = advanced.logLevel as LogLevel;
    }
    telemetry = !!advanced.telemetry;
  } catch {
    /* настроек нет — дефолты */
  }
  cachedFilter = { logLevel, telemetry };
  return cachedFilter;
}
// Важность системных событий: debug < info < warn < error. Пишем всё, что не
// ниже выбранного порога (logLevel="info" → info+warn+error). Раньше порядок был
// обратным, из-за чего при дефолтном "info" в app.log попадали ТОЛЬКО info, а
// ошибки/предупреждения молча отбрасывались.
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, action: 4 };

/* --- Полный журнал (audit.log): без фильтров, с ротацией --- */
const AUDIT_FILE = path.join(DIRS.logs, "audit.log");
const AUDIT_ROTATED = path.join(DIRS.logs, "audit.1.log");
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;
let auditSize = -1;
let auditWrites = 0;

function rotateAuditIfNeeded(): void {
  try {
    if (auditSize < 0) auditSize = fs.existsSync(AUDIT_FILE) ? fs.statSync(AUDIT_FILE).size : 0;
    if (auditSize < AUDIT_MAX_BYTES) return;
    fs.renameSync(AUDIT_FILE, AUDIT_ROTATED); // предыдущий архив перезаписывается
    auditSize = 0;
  } catch {
    /* журнал не должен ронять приложение */
  }
}

function appendAudit(entry: LogEntry): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line);
    if (auditSize >= 0) auditSize += Buffer.byteLength(line);
    if (++auditWrites % 50 === 0) rotateAuditIfNeeded();
  } catch {
    /* ignore */
  }
}
/** Запись события: audit.log — всегда, app.log — по фильтрам настроек. */
function append(entry: LogEntry): void {
  // 1) Полный журнал — всегда.
  appendAudit(entry);
  // 2) Рабочий лог — по фильтрам настроек.
  const { logLevel, telemetry } = levelFilter();
  const rank = LEVEL_RANK[entry.level] ?? LEVEL_RANK.info;
  // action (телеметрия юзера) пишется только при включённой advanced.telemetry,
  // системные события фильтруются по advanced.logLevel (минимальная важность).
  if (entry.level === "action") {
    if (!telemetry) return;
  } else if (rank < (LEVEL_RANK[logLevel] ?? LEVEL_RANK.info)) {
    return;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    fs.appendFileSync(FILES.log, line);
  } catch {
    /* чтоб лог не ронял приложение */
  }
}

/** Публичный интерфейс модуля — то, что видят require("./logger") в .js-коде. */
interface Logger {
  debug(event: string, data?: unknown): void;
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  /** Действия юзера: клики, навигация и т.д. */
  action(event: string, data?: unknown): void;
  /** Явный уровень (используется приёмом событий с фронта: /api/log). */
  log(level: string, event: string, data?: unknown): void;
  /** Пути к журналам — нужны сборщику диагностического файла. */
  files: { audit: string; auditRotated: string; app: string };
}

const logger: Logger = {
  debug(event, data) {
    append({ level: "debug", event, data });
  },
  info(event, data) {
    append({ level: "info", event, data });
  },
  warn(event, data) {
    append({ level: "warn", event, data });
  },
  error(event, data) {
    append({ level: "error", event, data });
  },
  action(event, data) {
    append({ level: "action", event, data });
  },
  log(level, event, data) {
    const lvl = (["debug", "error", "warn", "info", "action"] as string[]).includes(level)
      ? (level as LogLevel)
      : "info";
    append({ level: lvl, event, data });
  },
  files: { audit: AUDIT_FILE, auditRotated: AUDIT_ROTATED, app: FILES.log },
};

export = logger;
