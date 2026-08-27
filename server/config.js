const path = require("path");
const fs = require("fs");

// Пути к данным приложения. В разработке storage/ живёт рядом с проектом,
// а в собранном exe Electron подсовывает сюда свой userData-каталог.
const STORAGE_DIR =
  process.env.PERSONAL_APP_STORAGE || path.join(__dirname, "..", "storage");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const DIRS = {
  storage: ensureDir(STORAGE_DIR),
  logs: ensureDir(path.join(STORAGE_DIR, "logs")),
  backups: ensureDir(path.join(STORAGE_DIR, "backups")),
  downloads: ensureDir(path.join(STORAGE_DIR, "downloads")),
  // Конвертер: сюда падают временные файлы (in) и результаты (out).
  convert: ensureDir(path.join(STORAGE_DIR, "convert")),
  convertIn: ensureDir(path.join(STORAGE_DIR, "convert", "in")),
  convertOut: ensureDir(path.join(STORAGE_DIR, "convert", "out")),
};

const FILES = {
  data: path.join(DIRS.storage, "data.json"),
  settings: path.join(DIRS.storage, "settings.json"),
  secrets: path.join(DIRS.storage, "secrets.json"),
  log: path.join(DIRS.logs, "app.log"),
};

module.exports = { DIRS, FILES, PORT: 4000 };