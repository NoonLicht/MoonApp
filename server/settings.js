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
    autoUpdate: true,        // автообновление приложения (electron-updater)
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
    // Keep-alive страниц: посещённые страницы остаются смонтированными, поэтому
    // прогресс задач, введённый текст и позиция скролла сохраняются при
    // переключении. Ограничение — LRU по числу страниц и по времени простоя.
    keepPagesAlive: true,       // true — держать страницы в памяти, false — выгружать сразу
    keepPagesLimit: 6,          // сколько страниц держать смонтированными (LRU)
    unloadIdleMinutes: 5,       // выгружать простаивающие страницы через N минут (0 — никогда)
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

  // --- Видеосжатие (матрица энкодеров, см. server/encoders.js) ---
  compressor: {
    engine: "auto",          // auto | svtav1 | x265 | x264 | aom | rav1e | av1an | nvenc | qsv | amf | nvencc | qsvencc | vceencc
    codec: "av1",            // av1 | hevc | h264
    qualityMode: "crf",      // crf | bitrate | constrained
    crf: 23,                 // 0–51 (CQP для GPU-энкодеров)
    speed: "",               // пресет скорости энкодера (пусто = дефолт движка)
    tenBit: false,           // 10-bit цвет (архивное качество)
    targetHeight: "original",// original | 2160 | 1440 | 1080 | 720 | 480
    audio: "aac",            // copy | aac | opus
    audioKbps: 192,
    cleanupTemp: true,       // чистить временные файлы после сжатия
    customPresets: "",       // пользовательские пресеты (JSON-строка массива)
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

  // --- Lecture Recorder (whisper.cpp + VAD) ---
  lecture: {
    whisperBin: "",          // путь к whisper-cli/main.exe (пусто = автопоиск)
    model: "",               // путь к ggml-модели (пусто = автопоиск models/ggml-*.bin)
    language: "ru",          // язык лекции для Whisper
    threads: 4,              // потоки CPU-фолбэка (OpenBLAS/AVX2)
    initialPrompt: "Лекция по высшей математике, интегралы, дифференциалы, матрица, вектор, асимптота, теорема, производная, предел, множество",
    vadSilenceMs: 700,       // пауза для закрытия чанка (400..1200)
    vadMinChunkMs: 7000,     // целевой минимум чанка
    vadMaxChunkMs: 18000,    // целевой максимум чанка (мягкий сплит)
    vadForceSplitMs: 25000,  // принудительный сплит длинной речи
    vadPadMs: 150,           // пре/пост-ролл паддинг
    ollamaModel: "",         // модель Ollama для конспекта (пусто = llama3.2)
    outputDir: "",           // экспорт .md/.srt/.vtt (пусто = хранить в storage/lectures)
  },

  // --- Zapret / DPI bypass (Flowseal/zapret-discord-youtube) ---
  zapret: {
    dir: "",                 // путь к каталогу движка (пусто = автопоиск resources/zapret)
    mode: "process",         // process | service
    defaultStrategy: "general",
    gameFilterTcp: false,    // GameFilter: TCP-порты игр
    gameFilterUdp: false,    // GameFilter: UDP-порты игр
    customTargets: "",       // URL для диагностики через ; или с новой строки
    autoApplyBest: false,    // авто-применять лучшую стратегию после auto-tune
  },

  // --- Продвинутое / развитие ---
  advanced: {
    telemetry: false,        // TODO: анонимная статистика использования
    logLevel: "info",        // info | warn | error
    masterKey: "",           // TODO: мастер-ключ шифрования (пока env MOONAPP_MASTER_KEY)
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