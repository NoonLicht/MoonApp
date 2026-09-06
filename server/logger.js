const fs = require("fs");
const { FILES } = require("./config");

// Почти любое событие (включая клики) пишется в NDJSON-файл.
// Формат строки: {"ts","level","event","data"}
//
// Настройки из advanced.* управляют записью:
//   advanced.logLevel = "error" | "warn" | "info" — минимальный уровень системных событий;
//   advanced.telemetry = false — события уровня "action" (клики, навигация) не пишутся.
// Файл настроек читается напрямую (без require("./settings")), т.к. settings.js
// сам использует logger — так избегаем циклической зависимости.
let cachedFilter = null;
let cachedAt = 0;

function levelFilter() {
  const now = Date.now();
  if (cachedFilter && now - cachedAt < 10_000) return cachedFilter;
  cachedAt = now;
  let logLevel = "info";
  let telemetry = false;
  try {
    const advanced = JSON.parse(fs.readFileSync(FILES.settings, "utf8"))?.advanced || {};
    if (["error", "warn", "info"].includes(advanced.logLevel)) logLevel = advanced.logLevel;
    telemetry = !!advanced.telemetry;
  } catch { /* настроек нет — дефолты */ }
  cachedFilter = { logLevel, telemetry };
  return cachedFilter;
}

// Порог для системных событий: error < warn < info.
const LEVEL_RANK = { error: 0, warn: 1, info: 2, action: 3 };

function append(entry) {
  const { logLevel, telemetry } = levelFilter();
  const rank = LEVEL_RANK[entry.level] ?? 3;
  // action (телеметрия юзера) пишется только при включённой advanced.telemetry,
  // системные события фильтруются по advanced.logLevel.
  if (entry.level === "action") {
    if (!telemetry) return;
  } else if (rank < LEVEL_RANK[logLevel]) {
    return;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    fs.appendFileSync(FILES.log, line);
  } catch {
    /* чтоб лог не ронял приложение */
  }
}

const logger = {
  info(event, data) { append({ level: "info", event, data }); },
  warn(event, data) { append({ level: "warn", event, data }); },
  error(event, data) { append({ level: "error", event, data }); },
  // Действия юзера: клики, навигация и т.д.
  action(event, data) { append({ level: "action", event, data }); },
};

module.exports = logger;