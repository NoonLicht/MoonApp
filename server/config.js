const path = require("path");
const fs = require("fs");

// Пути к данным приложения. Основной источник — process.env.MOONAPP_STORAGE:
// его выставляет electron/storagePath.js (в собранной сборке это storage\
// рядом с exe). Если переменной нет (сервер запущен напрямую/из тестов),
// спрашиваем тот же резолвер, чтобы путь НИКОГДА не оказался внутри
// app.asar (там запись невозможна), и лишь затем — dev-фолбэк storage/ рядом
// с исходниками.
const STORAGE_DIR = (() => {
  if (process.env.MOONAPP_STORAGE) return process.env.MOONAPP_STORAGE;
  try {
    const resolved = require("../electron/storagePath").STORAGE_DIR;
    if (resolved) return resolved;
  } catch { /* не Electron-окружение (чистый Node/тесты) */ }
  return path.join(__dirname, "..", "storage");
})();

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const DIRS = {
  storage: ensureDir(STORAGE_DIR),
  logs: ensureDir(path.join(STORAGE_DIR, "logs")),
  backups: ensureDir(path.join(STORAGE_DIR, "backups")),
  // Загрузки приложения (книги, файлы из Store и т.п.).
  downloads: ensureDir(path.join(STORAGE_DIR, "downloads")),
  // Торрент-плеер (страница «Фильмы и Сериалы»): кэш скачанных кусков.
  // ВАЖНО: содержимое — пользовательский торрент, который он открыл сам.
  torrents: ensureDir(path.join(STORAGE_DIR, "torrents")),
  // Конвертер: сюда падают временные файлы (in) и результаты (out).
  convert: ensureDir(path.join(STORAGE_DIR, "convert")),
  convertIn: ensureDir(path.join(STORAGE_DIR, "convert", "in")),
  convertOut: ensureDir(path.join(STORAGE_DIR, "convert", "out")),
  // Видеосжатие: исходники, промежуточные и готовые файлы.
  compressorIn: ensureDir(path.join(STORAGE_DIR, "compressor", "in")),
  compressorOut: ensureDir(path.join(STORAGE_DIR, "compressor", "out")),
  // TTS: референсы голоса, чанки, готовые аудиокниги, профили.
  tts: ensureDir(path.join(STORAGE_DIR, "tts")),
  // Web Archive: рабочие папки краулера, распакованные архивы и .sitebak.
  sitebak: ensureDir(path.join(STORAGE_DIR, "sitebak")),
  sitebakExtracted: ensureDir(path.join(STORAGE_DIR, "sitebak", "extracted")),
  // Lecture Recorder: raw WAV (fail-safe), чанки VAD и расшифровки.
  lectures: ensureDir(path.join(STORAGE_DIR, "lectures")),
  // DPI Bypass (zapret): сюда качается и распаковывается релиз с GitHub.
  zapret: ensureDir(path.join(STORAGE_DIR, "zapret")),
  tmp: ensureDir(path.join(STORAGE_DIR, "tmp")),
  // --- Папки самозагружаемых бинарников (создаём сразу, а не «лениво») ---
  // Раньше они появлялись только после первой установки соответствующего
  // движка, из-за чего на свежей установке в storage не хватало подпапок.
  ffmpeg: ensureDir(path.join(STORAGE_DIR, "ffmpeg")),
  ytdlp: ensureDir(path.join(STORAGE_DIR, "ytdlp")),
  singbox: ensureDir(path.join(STORAGE_DIR, "singbox")),
  // LHM: артефакты мониторинга (pid.txt и т.п.) — вне asar.
  bin: ensureDir(path.join(STORAGE_DIR, "bin")),
  binLhm: ensureDir(path.join(STORAGE_DIR, "bin", "lhm")),
  // My Space: хранилище заметок и холстов + старый редактор заметок.
  vault: ensureDir(path.join(STORAGE_DIR, "vault")),
  vaultNotes: ensureDir(path.join(STORAGE_DIR, "vault", "notes")),
  vaultHolts: ensureDir(path.join(STORAGE_DIR, "vault", "holts")),
  notes: ensureDir(path.join(STORAGE_DIR, "notes")),
};

const FILES = {
  data: path.join(DIRS.storage, "data.json"),
  settings: path.join(DIRS.storage, "settings.json"),
  secrets: path.join(DIRS.storage, "secrets.json"),
  log: path.join(DIRS.logs, "app.log"),
};

module.exports = { DIRS, FILES, PORT: 4000 };