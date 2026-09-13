const fs = require("fs");
const path = require("path");
const { DIRS, FILES } = require("./config");

// Почти любое событие (включая клики) пишется в NDJSON-файл.
// Формат строки: {"ts","level","event","data"}
//
// Два независимых журнала:
//   1) logs/app.log  — рабочий лог, фильтруется настройками advanced.*
//      (logLevel — системные события, telemetry — события уровня "action");
//   2) logs/audit.log — ПОЛНЫЙ журнал без фильтров: пишутся все события.
//      Нужен для кнопки «Собрать логи» в Настройках: пользователь одним файлом
//      отдаёт разработчику всё — клики, навигацию, загрузки, ошибки,
//      предупреждения. Ротация: >8 МБ → audit.1.log (предыдущий архив).
//
// Настройки из advanced.* управляют записью в app.log:
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

/* --- Полный журнал (audit.log): без фильтров, с ротацией --- */
const AUDIT_FILE = path.join(DIRS.logs, "audit.log");
const AUDIT_ROTATED = path.join(DIRS.logs, "audit.1.log");
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;
let auditSize = -1;
let auditWrites = 0;

function rotateAuditIfNeeded() {
  try {
    if (auditSize < 0) auditSize = fs.existsSync(AUDIT_FILE) ? fs.statSync(AUDIT_FILE).size : 0;
    if (auditSize < AUDIT_MAX_BYTES) return;
    fs.renameSync(AUDIT_FILE, AUDIT_ROTATED); // предыдущий архив перезаписывается
    auditSize = 0;
  } catch { /* журнал не должен ронять приложение */ }
}

function appendAudit(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line);
    if (auditSize >= 0) auditSize += Buffer.byteLength(line);
    if (++auditWrites % 50 === 0) rotateAuditIfNeeded();
  } catch { /* ignore */ }
}

function append(entry) {
  // 1) Полный журнал — всегда.
  appendAudit(entry);
  // 2) Рабочий лог — по фильтрам настроек.
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
  // Явный уровень (используется приёмом событий с фронта: /api/log).
  log(level, event, data) {
    const lvl = ["error", "warn", "info", "action"].includes(level) ? level : "info";
    append({ level: lvl, event, data });
  },
  // Пути к журналам — нужны сборщику диагностического файла.
  files: { audit: AUDIT_FILE, auditRotated: AUDIT_ROTATED, app: FILES.log },
};

module.exports = logger;
