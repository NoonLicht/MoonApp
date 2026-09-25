/**
 * Пути к данным приложения. Основной источник — process.env.MOONAPP_STORAGE:
 * его выставляет electron/storagePath.js (в собранной сборке это storage\
 * рядом с exe). Если переменной нет (сервер запущен напрямую/из тестов),
 * спрашиваем тот же резолвер, чтобы путь НИКОГДА не оказался внутри
 * app.asar (там запись невозможна), и лишь затем — dev-фолбэк storage/ рядом
 * с исходниками.
 *
 * TS-исходник, как server/ts/logger.ts: компилируется в server/config.js
 * командой `npm run compile:server`, поэтому require("./config") из ~30
 * обычных .js-модулей работает без изменений. Модуль остаётся CommonJS
 * (`export =`), потому что потребители делают `const { DIRS, FILES } = require("./config")`.
 */
import path from "path";
import fs from "fs";

const STORAGE_DIR = ((): string => {
  if (process.env.MOONAPP_STORAGE) return process.env.MOONAPP_STORAGE;
  try {
    // Путь указан «как из собранного server/config.js»: из server/ts/ tsc его
    // разрешить не может, поэтому это обычный require с локальным типом.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolved = (require("../electron/storagePath") as { STORAGE_DIR?: string }).STORAGE_DIR;
    if (resolved) return resolved;
  } catch {
    /* не Electron-окружение (чистый Node/тесты) */
  }
  return path.join(__dirname, "..", "storage");
})();

/** Создать каталог (если нужно) и вернуть его путь. */
function ensureDir(p: string): string {
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
  // Метафайлы .torrent добавленных раздач: по ним загрузка возобновляется после
  // остановки/перезапуска (см. server/ts/torrent.ts → resumeDownload).
  torrentMeta: ensureDir(path.join(STORAGE_DIR, "torrents", "meta")),
  // Извлечённые из видео субтитры (WebVTT) и служебные файлы плеера.
  torrentSubs: ensureDir(path.join(STORAGE_DIR, "torrents", "subs")),
  // Форум-трекер (поиск раздач): файлы сессий (куки bb_data/sid) и служебные данные.
  trackers: ensureDir(path.join(STORAGE_DIR, "trackers")),
  // Конвертер: сюда падают временные файлы (in) и результаты (out).
  convert: ensureDir(path.join(STORAGE_DIR, "convert")),
  convertIn: ensureDir(path.join(STORAGE_DIR, "convert", "in")),
  convertOut: ensureDir(path.join(STORAGE_DIR, "convert", "out")),
  // Видеосжатие: исходники, промежуточные и готовые файлы.
  compressorIn: ensureDir(path.join(STORAGE_DIR, "compressor", "in")),
  compressorOut: ensureDir(path.join(STORAGE_DIR, "compressor", "out")),
  // Апскейл медиа: исходники/результаты и ONNX-модели.
  // Модели качаются по требованию (scripts/fetch-models.js) и живут вне asar:
  // onnxruntime-node читает их с диска обычным путём.
  upscaleIn: ensureDir(path.join(STORAGE_DIR, "upscale", "in")),
  upscaleOut: ensureDir(path.join(STORAGE_DIR, "upscale", "out")),
  upscaleModels: ensureDir(path.join(STORAGE_DIR, "models", "upscale")),
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
  // Картинки, вставленные в заметки (файл/буфер обмена) — вставка ![alt](url)
  // ссылается на /api/myspace-vault/assets/:id, отдающий файл отсюда.
  vaultAssets: ensureDir(path.join(STORAGE_DIR, "vault", "assets")),
  notes: ensureDir(path.join(STORAGE_DIR, "notes")),
  // Games launcher: библиотека игр/приложений + версионные бэкапы сохранений.
  games: ensureDir(path.join(STORAGE_DIR, "games")),
  gameSaves: ensureDir(path.join(STORAGE_DIR, "games", "saves")),
  // Быстрые голосовые заметки: короткие записи + их расшифровки (не путать
  // с полноценными лекциями в DIRS.lectures).
  quickNotes: ensureDir(path.join(STORAGE_DIR, "quicknotes")),
  quickNotesTmp: ensureDir(path.join(STORAGE_DIR, "quicknotes", "tmp")),
  // OCR: кэш скачанных языковых моделей tesseract.js (rus/eng .traineddata).
  ocr: ensureDir(path.join(STORAGE_DIR, "ocr")),
};
const FILES = {
  data: path.join(DIRS.storage, "data.json"),
  settings: path.join(DIRS.storage, "settings.json"),
  secrets: path.join(DIRS.storage, "secrets.json"),
  passwordVault: path.join(DIRS.storage, "password-vault.json"),
  bookmarks: path.join(DIRS.storage, "bookmarks.json"),
  musicPlaylists: path.join(DIRS.storage, "music-playlists.json"),
  gamesLibrary: path.join(DIRS.games, "library.json"),
  automationLaunchers: path.join(DIRS.storage, "automation-launchers.json"),
  budgetTransactions: path.join(DIRS.storage, "budget-transactions.json"),
  quickNotesIndex: path.join(DIRS.quickNotes, "index.json"),
  notesGitConfig: path.join(DIRS.storage, "notes-git.json"),
  appTimeTracker: path.join(DIRS.storage, "app-time-tracker.json"),
  conspectusPresets: path.join(DIRS.storage, "conspectus_presets.json"),
  log: path.join(DIRS.logs, "app.log"),
};

/** Порт локального API-сервера. */
const PORT = 4000;

/**
 * Путь к бинарю в server/vendor/<...>, который кладётся в комплект инсталлятора
 * (build.asarUnpack — см. package.json). Обычный path.join(__dirname, "vendor", ...)
 * внутри упакованной сборки возвращает путь ВНУТРИ app.asar — для fs-чтения это
 * не проблема (Electron сам подставляет .unpacked), но child_process.spawn(),
 * в отличие от execFile, asar не разворачивает и падает с ENOENT на живом файле.
 * https://www.electronjs.org/docs/latest/tutorial/asar-archives
 */
function vendorPath(...segments: string[]): string {
  const p = path.join(__dirname, "vendor", ...segments);
  const marker = `${path.sep}app.asar${path.sep}`;
  return p.includes(marker) ? p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

export = { DIRS, FILES, PORT, vendorPath };
