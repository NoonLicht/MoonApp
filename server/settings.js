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
    closeToTray: false,      // TODO: закрытие окна сворачивает в трей вместо выхода
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

  // --- Видео (yt-dlp): значения по умолчанию для новой загрузки ---
  video: {
    defaultHeight: "best",   // best | 2160 | 1440 | 1080 | 720 | 480 — ограничение высоты
    embedThumbnail: true,    // вшивать обложку в файл (требует ffmpeg)
    downloadSubs: false,     // скачивать субтитры вместе с видео
  },

  // --- Музыка (yt-dlp): качество аудио по умолчанию ---
  music: {
    defaultQuality: "320 kbps", // 320/256/192/128 kbps | FLAC | OPUS | WAV | AAC
  },

  // --- Книги (Флибуста) ---
  books: {
    pageSize: 40,            // книг на страницу в локальном каталоге
    preferLiveSearch: false, // сразу искать через живой OPDS-поиск, а не локальную базу
  },

  // --- Видео / Музыка (это уже yt-dlp) ---
  media: {
    ytdlpPath: "",           // путь к yt-dlp (пусто = искать в PATH)
  },

  // --- My Space: поведение заметок ---
  myspace: {
    autosave: true,          // автосохранение заметки при вводе
    spellcheck: false,       // проверка орфографии в редакторе
  },

  // --- Голос / клонирование (F5-TTS) ---
  voice: {
    engine: "local",         // local | cloud
    model: "",
    defaultLanguage: "English",
    // F5-TTS hyperparameters (дефолты для студии).
    exaggeration: 1.0,       // 0.5–2.0 — выразительность/динамика
    cfgWeight: 2.0,          // 1.5–4.5 — строгость сходства с референсом
    chunkSize: 250,          // ~символов на чанк (разбивка по знакам препинания)
    precision: "fp16",       // fp16 (~4.5 ГБ VRAM) | fp32
    nfeSteps: 32,            // диффузионные шаги F5-TTS (32–48)
    vramGb: 4.5,             // зарезервируемый объём VRAM (информативно)
    loudnessTarget: -16,     // EBU R128 target LUFS для нормализации
    // Команда запуска F5-TTS (пусто = автопоиск: f5-tts_infer / python -m f5_tts)
    f5Cmd: "",
  },

  // --- Архиватор страниц (пока TODO) ---
  archiver: {
    defaultOptions: { css: true, images: true, fonts: true, removeScripts: false },
  },

  // --- Видеосжатие (3-ступенчатый пайплайн) ---
  compressor: {
    codec: "av1",            // av1 | hevc | h264
    crf: 22,                 // 0–50; 20–25 — sweet spot
    aiUpscale: true,         // Real-ESRGAN на GPU (если бинарь найден)
    aiScale: "2x",           // 2x | 4x
    aiModel: "realesr-animevideov3-x4", // быстрая видео-модель; x4plus — качество
    gpuFirst: false,         // быстрое кодирование через NVENC (файл чуть больше)
    gpuDeviceId: 0,          // ID GPU для Real-ESRGAN (gpus=Id:N)
    cleanupTemp: true,       // чистить промежуточные файлы после сжатия
  },

  // --- Web Archive / .sitebak ---
  sitebak: {
    maxConcurrent: 3,        // параллельных вкладок/браузеров Playwright
    crawlDelayMs: 500,       // пауза между запросами (вежливость)
    userAgent: "",           // пусто = стандартный Chromium UA
    zstdDictKb: 1024,        // словарь ZSTD для текстового блока (КБ)
    mediaFormat: "webp",     // original | lossless | webp | avif
    stripExif: true,
    stripScripts: true,
    blockAds: true,
    maxPages: 500,
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

function save() { saveWithLock(); } // оставлено для совместимости экспорта

function get(key) {
  const s = load();
  return key ? s[key] : s;
}

function set(patch) {
  const s = load();
  const clean = sanitizePatch(patch);
  Object.assign(s, deepMerge(s, clean));
  saveWithLock();
  return s;
}

// Белая схема (С8): принимаются только ключи, существующие в DEFAULTS, и только
// значения того же типа (number/string/boolean). Всё остальное отбрасывается —
// произвольный JSON больше не может попасть в settings.json.
function sanitizePatch(patch, schema = DEFAULTS, base = []) {
  const out = {};
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (!(k in schema)) continue;
    if (isPlainObject(schema[k])) {
      if (isPlainObject(v)) {
        const nested = sanitizePatch(v, schema[k], base.concat(k));
        if (Object.keys(nested).length) out[k] = nested;
      }
      continue;
    }
    const t = typeof schema[k];
    if (t === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (t === "boolean") {
      if (typeof v === "boolean") out[k] = v;
    } else if (t === "string") {
      if (typeof v === "string") out[k] = v.slice(0, 4000);
    }
  }
  return out;
}

// Запись с коротким файловым lock (С10): settings.json пишут два процесса
// (Express и electron-main с lastSize) — без блокировки возможна потеря записи.
function saveWithLock() {
  const lock = FILES.settings + ".lock";
  let fd = null;
  for (let i = 0; i < 20 && fd === null; i++) {
    try { fd = fs.openSync(lock, "wx"); } catch { const t0 = Date.now(); while (Date.now() - t0 < 50) { /* busy */ } }
  }
  try {
    if (fd === null) { // не дождались — пишем напрямую (лучше потерять гонку, чем запись)
      fs.writeFileSync(FILES.settings, JSON.stringify(cache, null, 2), "utf8");
    } else {
      const tmp = FILES.settings + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
      try { fs.renameSync(tmp, FILES.settings); }
      catch { fs.writeFileSync(FILES.settings, JSON.stringify(cache, null, 2), "utf8"); }
    }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
  }
  logger.info("settings.save", {});
}

module.exports = { load, get, set, DEFAULTS };