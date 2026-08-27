const fs = require("fs");
const { FILES } = require("./config");

// Почти любое событие (включая клики) пишется в NDJSON-файл.
// Формат строки: {"ts","level","event","data"}
function append(entry) {
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