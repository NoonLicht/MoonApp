const fs = require("fs");
const path = require("path");
const { DIRS, FILES } = require("./config");
const settings = require("./settings");
const logger = require("./logger");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Собирает бэкап: данные + настройки + секреты в storage/backups/<timestamp>/.
// Возвращает путь или null, если что-то упало.
function createBackup(trigger = "manual") {
  try {
    // Пersist дебаунсится (М8) — перед копированием сбрасываем буфер на диск.
    try {
      require("./db").flush();
    } catch {
      /* noop */
    }
    const dir = path.join(DIRS.backups, stamp());
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(FILES.data)) fs.copyFileSync(FILES.data, path.join(dir, "data.json"));
    if (fs.existsSync(FILES.settings))
      fs.copyFileSync(FILES.settings, path.join(dir, "settings.json"));
    if (fs.existsSync(FILES.secrets))
      fs.copyFileSync(FILES.secrets, path.join(dir, "secrets.json"));

    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ trigger, at: new Date().toISOString() }, null, 2),
    );

    rotate();
    logger.info("backup.created", { trigger, dir });
    return dir;
  } catch (e) {
    logger.error("backup.failed", { trigger, error: e.message });
    return null;
  }
}

// Оставляем только последние N бэкапов.
function rotate() {
  const all = fs
    .readdirSync(DIRS.backups)
    .map((n) => ({ n, t: fs.statSync(path.join(DIRS.backups, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const keep = settings.get("backup").keep ?? 5;
  all.slice(keep).forEach(({ n }) => {
    try {
      fs.rmSync(path.join(DIRS.backups, n), { recursive: true, force: true });
    } catch {}
  });
}

let timer = null;
// Автобэкапы по расписанию (интервал в часах).
function startAuto() {
  if (timer) clearInterval(timer);
  const hours = settings.get("backup").intervalHours;
  const ms = Math.max(1, hours) * 60 * 60 * 1000;
  timer = setInterval(() => {
    if (settings.get("backup").auto) createBackup("auto");
  }, ms);
  timer.unref?.();
  logger.info("backup.scheduler", { intervalHours: hours });
}

function list() {
  return fs
    .readdirSync(DIRS.backups)
    .filter((n) => fs.existsSync(path.join(DIRS.backups, n, "meta.json")))
    .map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DIRS.backups, n, "meta.json"), "utf8"));
      } catch {
        return {
          at: new Date(fs.statSync(path.join(DIRS.backups, n)).mtimeMs).toISOString(),
          trigger: "?",
        };
      }
    })
    .reverse();
}

module.exports = { createBackup, startAuto, list, rotate };
