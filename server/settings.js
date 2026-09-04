const fs = require("fs");
const { FILES } = require("./config");
const logger = require("./logger");

// settings.json — настройки (НЕ секреты! те живут в secrets.json).
// Отдельно от БД, чтобы читать/писать быстрее при старте и проще бэкапить.
// Всё разложено по секциям под каждую область приложения, включая будущие
// (конвертер, медиа, голос и т.п.) — чтобы значения были заранее зарезервированы.
const DEFAULTS = {
  // --- Общее / приложение ---
  general: {
    language: "ru",
    startPage: "store",      // открывается при запуске
    autoLaunch: false,       // TODO: автозапуск с Windows
    minimizeToTray: false,   // TODO: свёрнутая кнопка в трей
  },

  // --- Внешний вид ---
  appearance: {
    theme: "dark",           // dark | light
    accent: "amber",         // amber | violet | teal | coral
    reduceMotion: false,     // TODO: вырубать анимации/blur-блобы
    fontSize: 14,            // TODO: базовый размер шрифта
    density: "comfortable",  // future: comfortable | compact
  },

  // --- Производительность ---
  performance: {
    hardwareAcceleration: true, // аппаратное ускорение Chromium (см. electron/main.js)
    backgroundBlur: true,       // future: сложные blur-эффекты интерфейса
  },

  // --- Окно ---
  window: {
    width: 1180,
    height: 820,
    rememberSize: true,      // future: запоминать размер/позицию окна
  },

  // --- Чат / ИИ ---
  chat: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 1024,
    stream: true,
    contextMessages: 30,     // сколько последних сообщений уходит в контекст
  },

  // --- Store / каталог загрузок ---
  store: {
    downloadDir: "",         // пусто = дефолтная папка (storage/downloads)
    wingetAutoIndex: true,   // автоиндексация всего каталога winget при старте
    pageSize: 40,            // элементов на страницу в сетке магазина
  },

  // --- Конвертер файлов (это уже FFmpeg) ---
  converter: {
    ffmpegPath: "",          // путь к ffmpeg (пусто = искать в PATH)
    preserveAudio: true,     // сохранять звук при конвертации видео
  },

  // --- Видео / Музыка (это уже yt-dlp) ---
  media: {
    ytdlpPath: "",           // путь к yt-dlp (пусто = искать в PATH)
  },

  // --- Голос / клонирование (пока TODO — локальный TTS) ---
  voice: {
    engine: "local",         // local | cloud
    model: "",
    defaultLanguage: "English",
  },

  // --- Архиватор страниц (пока TODO) ---
  archiver: {
    defaultOptions: { css: true, images: true, fonts: true, removeScripts: false },
  },

  // --- Мониторинг (пока TODO — реальный сбор телеметрии) ---
  monitor: {
    autoStart: false,        // собирать телеметрию сразу после старта
    refreshInterval: "2s",   // (устарело) 1s | 2s | 5s
    refreshMs: 500,          // интервал опроса UI в миллисекундах (100–1000)
    lhmAutoStart: true,      // автозапуск LibreHardwareMonitor для сенсоров
  },

  // --- Автобэкап ---
  backup: {
    auto: true,
    intervalHours: 24,
  },

  // --- Продвинутое / развитие ---
  advanced: {
    telemetry: false,        // TODO: анонимная статистика использования
    logLevel: "info",        // info | warn | error
    masterKey: "",           // TODO: мастер-ключ шифрования (пока env PERSONAL_APP_MASTER_KEY)
  },
};

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Глубокое слияние: base (дефолты) перекрывается extra (сохранёнными).
function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(extra || {})) {
    const b = base?.[k];
    const e = extra[k];
    if (isPlainObject(b) && isPlainObject(e)) out[k] = deepMerge(b, e);
    else if (e !== undefined) out[k] = e;
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.settings, "utf8"));
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save() {
  fs.writeFileSync(FILES.settings, JSON.stringify(cache, null, 2), "utf8");
  logger.info("settings.save", {});
}

function get(key) {
  const s = load();
  return key ? s[key] : s;
}

function set(patch) {
  const s = load();
  Object.assign(s, deepMerge(s, patch));
  save();
  return s;
}

module.exports = { load, get, set, DEFAULTS };