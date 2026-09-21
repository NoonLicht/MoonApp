/**
 * settings.json — настройки (НЕ секреты! те живут в secrets.json).
 * Отдельно от БД, чтобы читать/писать быстрее при старте и проще бэкапить.
 * Всё разложено по секциям под каждую область приложения, включая будущие
 * (конвертер, медиа, голос и т.п.) — чтобы значения были заранее зарезервированы.
 *
 * TS-исходник, как server/ts/config.ts: компилируется в server/settings.js
 * командой `npm run compile:server`, поэтому require("./settings") из ~23
 * обычных .js-модулей работает без изменений. Модуль остаётся CommonJS
 * (`export =`), потому что потребители берут его объектом (settings.get(...)).
 *
 * Типизация осознанно мягкая: settings.json пользователь может править руками,
 * поэтому форма данных проверяется не компилятором, а sanitizePatch в рантайме
 * (только ключи из DEFAULTS и только совпадающие типы). Возврат get() остаётся
 * `any` — так же, как было в server/ts/settings.d.ts, который этот исходник
 * заменяет.
 */
import fs from "fs";
import config from "./config";
import logger from "./logger";

const { FILES } = config;

/** Дерево настроек: ключи секций и скалярные значения (проверка — sanitizePatch). */
interface SettingsTree {
  [key: string]: any;
}

const DEFAULTS: SettingsTree = {
  // --- Общее / приложение ---
  general: {
    language: "ru",
    startPage: "store", // открывается при запуске
    // Автообновление (electron-updater). С 0.2.2 обновления ОБЯЗАТЕЛЬНЫ: проверка
    // идёт при каждом запуске, скачанное обновление нельзя отложить (см.
    // electron/main.js → showMandatoryUpdate). Ключ оставлен для совместимости
    // settings.json и всегда приводится к true (миграция ниже); выключателя в UI нет.
    autoUpdate: true,
    autoUpdateMigrated: false, // разовая миграция 0.2.2: включить обновления у старых установок
    autoLaunch: false, // автозапуск с Windows (electron/main.js → applyAutoLaunch)
    minimizeToTray: false, // сворачивание прячет окно в трей (electron/main.js)
    closeToTray: false, // закрытие окна сворачивает в трей вместо выхода
  },

  // --- Внешний вид ---
  appearance: {
    theme: "dark", // dark | midnight | light | sand | oled (oled = абсолютно чёрный фон)
    accent: "amber", // amber | violet | teal | coral | sky | rose
    reduceMotion: false, // вырубать анимации/blur-блобы
    density: "comfortable", // comfortable | compact
    opaqueBackground: false, // непрозрачный фон вместо полупрозрачного окна
  },

  // --- Производительность ---
  performance: {
    hardwareAcceleration: true, // аппаратное ускорение Chromium (см. electron/main.js)
    backgroundBlur: true, // future: сложные blur-эффекты интерфейса
    // Keep-alive страниц: посещённые страницы остаются смонтированными, поэтому
    // прогресс задач, введённый текст и позиция скролла сохраняются при
    // переключении. Ограничение — LRU по числу страниц и по времени простоя.
    keepPagesAlive: true, // true — держать страницы в памяти, false — выгружать сразу
    keepPagesLimit: 6, // сколько страниц держать смонтированными (LRU)
    unloadIdleMinutes: 5, // выгружать простаивающие страницы через N минут (0 — никогда)
  },

  // --- Окно ---
  window: {
    width: 1180,
    height: 820,
    rememberSize: true, // запоминать размер И позицию окна (electron/main.js)
  },

  // --- Чат / ИИ ---
  chat: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 1024,
    stream: true,
    contextMessages: 30, // сколько последних сообщений уходит в контекст
  },
  // --- Store / каталог загрузок ---
  store: {
    downloadDir: "", // пусто = дефолтная папка (storage/downloads)
    wingetAutoIndex: true, // автоиндексация всего каталога winget при старте
    pageSize: 40, // элементов на страницу в сетке магазина
  },

  // --- Конвертер файлов (это уже FFmpeg) ---
  converter: {
    ffmpegPath: "", // путь к ffmpeg (пусто = искать в PATH)
    preserveAudio: true, // сохранять звук при конвертации видео
  },

  // --- Видео (yt-dlp): значения по умолчанию для новой загрузки ---
  video: {
    defaultHeight: "best", // best | 2160 | 1440 | 1080 | 720 | 480 — ограничение высоты
    embedThumbnail: true, // вшивать обложку в файл (требует ffmpeg)
    downloadSubs: false, // скачивать субтитры вместе с видео
  },

  // --- Музыка (yt-dlp): качество аудио по умолчанию ---
  music: {
    defaultQuality: "320 kbps", // 320/256/192/128 kbps | FLAC | OPUS | WAV | AAC
  },

  // --- Книги (Флибуста) ---
  // Настроек нет намеренно: поиск и каталог работают напрямую через OPDS
  // Flibusta, локальной базы книг больше нет (server/flibusta.js).
  // Избранное и закладки хранятся в БД, а не в settings.json.

  // --- Видео / Музыка (это уже yt-dlp) ---
  media: {
    ytdlpPath: "", // путь к yt-dlp (пусто = искать в PATH)
  },

  // --- Фильмы и сериалы (страница «movies», каталог TMDB) ---
  // ВАЖНО: API-ключ TMDB тут НЕ хранится — он секрет и живёт в storage/secrets.json
  // (см. server/routes/movies.js → POST /api/movies/key). Здесь только настройки вида.
  movies: {
    language: "ru-RU", // язык метаданных TMDB (ru-RU, en-US, …)
    region: "RU", // регион для «где смотреть» (watch/providers)
    showAdult: false, // включать фильмы 18+ в выдачу
    cacheMinutes: 720, // время жизни кэша метаданных TMDB, минут
    // Галочка «хранить скачанный торрент после просмотра» (плеер и вкладка
    // «Скачанные»): true — файлы остаются на диске, false — завершённые раздачи,
    // которые никто не просил хранить, удаляются (освобождают место).
    keepTorrentFiles: true,
  },

  // --- Форум-трекер: поиск раздач (rutracker.org и phpBB-совместимые движки) ---
  // Адрес и параметры запросов живут здесь, чтобы движок можно было перенастроить
  // на другой форум без правки кода. Логин/пароль тут НЕ хранятся: это секрет
  // (storage/secrets.json, ключ "tracker", см. server/ts/trackerScraper.ts).
  trackers: {
    enabled: true, // показывать вкладку «Поиск раздач» в плеере
    // Движок площадки: "rutracker" (phpBB, вход обязателен) | "rutor" (utf-8,
    // поиск без входа). Переключение в UI применяет пресет целиком
    // (server/ts/trackerProviders.ts → applyTrackerPreset).
    // По умолчанию — rutor: он отвечает без Cloudflare, и вход для поиска не нужен.
    engine: "rutor",
    baseUrl: "https://rutor.info",
    label: "RuTor",
    loginPath: "/users.php", // страница входа (для поиска не требуется)
    searchPath: "/search/0/0/000/0/{q}", // {q} — запрос подставляется в путь
    searchMethod: "get", // post | get — как площадка принимает поиск
    searchParam: "q", // имя поля строки поиска
    topicPath: "/torrent/{id}",
    torrentPath: "https://d.rutor.info/download/{id}", // .torrent-файл раздачи
    encoding: "utf-8", // кодировка страниц и форм площадки
    // User-Agent для запросов; пусто — встроенный браузерный. Нужен, когда
    // cf_clearance из браузера привязан к конкретному UA.
    userAgent: "",
    minIntervalMs: 1200, // пауза между запросами к форуму (вежливость)
    timeoutMs: 20000,
    maxResults: 100, // максимум раздач в выдаче
    requireDownloadable: true, // показывать только то, что можно открыть в плеере
  },

  // --- My Space: поведение заметок ---
  myspace: {
    autosave: true, // автосохранение заметки при вводе
    spellcheck: false, // проверка орфографии в редакторе
    // ИИ-оформление заметок: свой провайдер и модель. Пусто — «как в AI-чате»
    // (chat.provider/chat.model). Отдельные поля нужны, чтобы выбранный для
    // заметок провайдер/модель сохранялись и не задавались заново каждый раз.
    ai: {
      provider: "", // "" — как в чате; иначе id провайдера (deepseek, openai, …)
      model: "", // "" — модель подберётся по каталогу провайдера (/models)
    },
  },

  // --- Голос / клонирование (F5-TTS) ---
  voice: {
    engine: "local", // local | cloud
    model: "",
    // Язык озвучки здесь больше НЕ хранится: движок всегда русский (TTS_LANGUAGE
    // в server/ts/tts.ts, LANGUAGE в server/engines/xtts_wrapper.py). Ключ
    // defaultLanguage (со значением «English» по умолчанию) убран — именно он
    // подсовывал английский язык русскому тексту, и XTTS читал кириллицу
    // английскими фонемами. Старое сохранённое значение просто отбрасывается
    // (см. sanitizePatch в этом файле).
    // F5-TTS hyperparameters (дефолты для студии).
    exaggeration: 1.0, // 0.5–2.0 — выразительность/динамика
    cfgWeight: 2.0, // 1.5–4.5 — строгость сходства с референсом
    chunkSize: 250, // ~символов на чанк (разбивка по знакам препинания)
    precision: "fp16", // fp16 (~4.5 ГБ VRAM) | fp32
    nfeSteps: 32, // диффузионные шаги F5-TTS (32–48)
    vramGb: 4.5, // зарезервируемый объём VRAM (информативно)
    loudnessTarget: -16, // EBU R128 target LUFS для нормализации
    // Команда запуска F5-TTS (пусто = автопоиск: f5-tts_infer / python -m f5_tts)
    f5Cmd: "",
    // Интерпретатор Python для сайдкаров движка (server/engines/*.py).
    // ВАЖНО: это НЕ обязательно тот python, что лежит в PATH — у пользователя
    // torch/f5_tts обычно стоят в venv или в отдельной установке (`py -3.11`).
    // Раньше настройки существовали только «в коде» (settings.get читал
    // необъявленный ключ), из-за чего рендер падал с «No module named 'torch'»,
    // а задать нужный интерпретатор из интерфейса было нельзя.
    pythonCmd: "python",
    // --- Расстановка ударений по смыслу (RUAccent, server/engines/ru_accent.py) ---
    // Модель омографов: tiny/tiny2/tiny2.1 (десятки МБ) либо turbo/turbo2/turbo3/
    // turbo3.1/big_poetry (350–690 МБ). По умолчанию tiny2.1: замеры на живых
    // текстах показали те же ударения, что у turbo3.1 с полным словарём.
    stressModel: "tiny2.1",
    // Лёгкий режим RUAccent (tiny_mode): без движка правил и предиктора нужности
    // ударения — 847 МБ памяти и ~80 МБ загрузки против 3 ГБ и ~680 МБ. Ударение
    // ставится всем словам с двумя и более гласными, что для озвучки и нужно.
    // false — полный режим: большой словарь ударений + правила (нужен больше
    // памяти, качество по замерам то же).
    stressLite: true,
  },
  // --- Архиватор страниц ---
  // Настроек нет: страницы архивирует движок Web Archive (.sitebak), а его
  // параметры живут в секции sitebak.* ниже. Старая секция archiver.defaultOptions
  // была легаси и ни на что не влияла — удалена.

  // --- Видеосжатие (матрица энкодеров, см. server/encoders.js) ---
  compressor: {
    engine: "auto", // auto | svtav1 | x265 | x264 | aom | rav1e | av1an | nvenc | qsv | amf | nvencc | qsvencc | vceencc
    codec: "av1", // av1 | hevc | h264
    qualityMode: "crf", // crf | bitrate | constrained
    crf: 23, // 0–51 (CQP для GPU-энкодеров)
    speed: "", // пресет скорости энкодера (пусто = дефолт движка)
    tenBit: false, // 10-bit цвет (архивное качество)
    targetHeight: "original", // original | 2160 | 1440 | 1080 | 720 | 480
    audio: "aac", // copy | aac | opus
    audioKbps: 192,
    cleanupTemp: true, // чистить временные файлы после сжатия
    customPresets: "", // пользовательские пресеты (JSON-строка массива)
  },

  // --- Апскейл медиа (ONNX-модели, см. server/upscale.js) ---
  upscaler: {
    model: "realesr-general-x4v3", // id модели из server/models.manifest.json
    model2: "", // вторая модель для смешивания результатов (пусто = выключено)
    blendAmount: 0, // 0–100: вес второй модели в смешивании
    scale: 4, // 2 | 3 | 4 — множитель модели
    targetW: 0, // 0 = без приведения к целевому размеру
    targetH: 0,
    tile: 0, // 0 = без тайлинга; иначе размер тайла в px (256/512 — экономия VRAM)
    overlap: 16, // перекрытие тайлов для склейки без швов
    threads: 0, // 0 = авто (по числу ядер CPU)
    provider: "auto", // auto | cpu | cuda | dml
    format: "png", // png | jpeg | webp | avif
    quality: 92, // качество для jpeg/webp/avif
    sharpen: 0, // 0–100: unsharp-маска после апскейла
    denoise: 0, // 0–100: лёгкое подавление шума до апскейла
    vcodec: "x264", // x264 | x265 | av1 — кодек результата видео
    vcrf: 20, // качество видео (CRF)
    audioAction: "copy", // copy | aac — что делать со звуковой дорожкой
    cleanupTemp: true, // чистить выгруженные кадры после сборки
    customPresets: "", // пользовательские пресеты (JSON-строка массива)
  },

  // --- Web Archive / .sitebak ---
  sitebak: {
    maxConcurrent: 3, // параллельных вкладок/браузеров Playwright
    crawlDelayMs: 500, // пауза между запросами (вежливость)
    userAgent: "", // пусто = стандартный Chromium UA
    zstdDictKb: 1024, // словарь ZSTD для текстового блока (КБ)
    mediaFormat: "webp", // original | lossless | webp | avif
    stripExif: true,
    stripScripts: true,
    blockAds: true,
    maxPages: 500,
  },

  // --- Мониторинг (пока TODO — реальный сбор телеметрии) ---
  monitor: {
    autoStart: false, // собирать телеметрию сразу после старта
    refreshInterval: "2s", // (устарело) 1s | 2s | 5s
    refreshMs: 500, // интервал опроса UI в миллисекундах (100–1000)
    lhmAutoStart: true, // автозапуск LibreHardwareMonitor для сенсоров
  },

  // --- Автобэкап ---
  backup: {
    auto: true,
    intervalHours: 24,
  },

  // --- Lecture Recorder (whisper.cpp + VAD) ---
  lecture: {
    whisperBin: "", // путь к whisper-cli/main.exe (пусто = автопоиск)
    model: "", // путь к ggml-модели (пусто = автопоиск models/ggml-*.bin)
    build: "auto", // auto | legacy | cpu | blas | cuda118 | cuda124 — сборка движка
    // Экспериментально: резидентный whisper-server.exe вместо перезапуска
    // whisper-cli.exe на каждый чанк (модель держится в памяти между чанками).
    // По умолчанию выключено — включается только если пользователь захотел
    // попробовать; при любой проблеме код сам откатывается на CLI (см. lecture.js).
    useResidentWhisper: false,
    modelId: "", // выбранная модель из каталога (пусто = авто: small → base → tiny)
    gpu: "auto", // auto — считать на NVIDIA (CUDA-сборка), off — всегда CPU
    deviceId: 0, // номер GPU для -dev (0 — первая видеокарта)
    language: "ru", // язык лекции для Whisper
    // 0 = все логические потоки CPU (см. resolveThreads в whisperEngine.ts),
    // положительное число — предел, заданный пользователем.
    threads: 0,
    initialPrompt:
      "Лекция по высшей математике, интегралы, дифференциалы, матрица, вектор, асимптота, теорема, производная, предел, множество",
    vadSilenceMs: 700, // пауза для закрытия чанка (400..1200)
    vadMinChunkMs: 7000, // целевой минимум чанка
    vadMaxChunkMs: 18000, // целевой максимум чанка (мягкий сплит)
    vadForceSplitMs: 25000, // принудительный сплит длинной речи
    vadPadMs: 150, // пре/пост-ролл паддинг
    // --- Аудиовход (страница лекций → панель «Аудио») ---
    // ВАЖНО: без выбранного устройства брался микрофон по умолчанию — часто это
    // микрофон веб-камеры, из-за чего запись звучала «из-под стола».
    micDeviceId: "", // "" — устройство по умолчанию, иначе deviceId из enumerateDevices
    micGain: 1, // усиление входа 0.5..4 (лечит тихие микрофоны)
    micAgc: false, // autoGainControl браузера (по умолчанию выключен, чтобы не «качать» уровень)
    // --- VAD: порог, адаптация, анти-шум ---
    vadRmsThreshold: 0.008, // стартовый порог RMS (0..1). −42 dBFS — типичная речь ≥ −30
    vadAdaptive: true, // подстраивать порог под шумовой пол записи
    vadThresholdFactor: 2.5, // порог = шумовой пол × этот множитель (≈ +8 дБ)
    vadMinSpeechRatio: 0.15, // доля речи в чанке ниже этой → «шум/гул», не в Whisper
    vadZcrGate: true, // отбрасывать широкополосный шум по ZCR (шипение системы)
    // --- AI-конспект: чанками через провайдера чата (DeepSeek и др.) ---
    // Раньше конспект шёл в локальный Ollama и обрезался до последних 14 000
    // символов — у длинной лекции терялось начало. Теперь расшифровка делится
    // на блоки и каждый уходит в модель отдельно (см. generateConspectus).
    // Провайдер по умолчанию — DeepSeek (лучшее соотношение цена/качество на
    // длинных русских текстах). Пустая строка означала бы «взять из настроек
    // чата», поэтому её по-прежнему понимаем, но сама настройка заполнена.
    conspectusProvider: "deepseek", // "" — как в чате (chat.provider); "deepseek" — явно DeepSeek
    conspectusModel: "", // "" — узнать из /models провайдера (для DeepSeek — deepseek-chat)
    // Режим запуска: smart — сам после окончания записи, но только если есть что
    // конспектировать (см. maybeAutoConspectus); auto — всегда; manual — только кнопкой.
    conspectusTrigger: "smart",
    conspectusAutoMinChars: 1200, // smart: не тратить запросы, если расшифровки меньше N символов
    // --- Разделение говорящих (sherpa-onnx diarization) ---
    // Двухдорожечный режим даёт «эфир = лектор, микрофон = аудитория», но внутри
    // дорожки говорящие не разделены. Sherpa кластеризует голоса (см. diarize.js).
    // По умолчанию ВЫКЛЮЧЕНО: разбор длинной лекции занимает минуты CPU, и
    // запускать его после каждой записи без спроса — плохая идея.
    diarizeEnabled: false, // true — разбирать говорящих сразу после остановки записи
    diarizeTrack: "auto", // auto — обе дорожки (sys + mic), иначе только выбранная
    diarizeThreshold: 0.5, // порог кластеризации (0.3..0.9): меньше → больше говорящих
    diarizeSpeakers: -1, // -1 — определить автоматически; >0 — точное число говорящих
    conspectusChunkChars: 6000, // символов расшифровки в одном запросе к модели
    conspectusOverlapChars: 600, // «шов»: сколько символов предыдущего блока передаём как контекст
    conspectusMaxChunks: 60, // предохранитель: не больше N блоков за прогон
    outputDir: "", // экспорт .md/.srt/.vtt (пусто = хранить в storage/lectures)
  },

  // --- Zapret / DPI bypass (Flowseal/zapret-discord-youtube) ---
  zapret: {
    dir: "", // путь к каталогу движка (пусто = автопоиск resources/zapret)
    // process — winws как elevated-процесс: открывает ОКНО КОНСОЛИ, которое
    //           висит в панели задач и не закрывается отдельно от обхода;
    // service — winws как служба Windows (это пункты 1/2 в service.bat:
    //           Install Service → выбор профиля / Remove Services). Окна нет.
    // По умолчанию — служба, чтобы запуск конфига не оставлял консоль.
    mode: "service",
    modeMigratedToService: false, // разовая миграция старого "process" → service (см. load)
    defaultStrategy: "general",
    gameFilterTcp: false, // GameFilter: TCP-порты игр
    gameFilterUdp: false, // GameFilter: UDP-порты игр
    customTargets: "", // URL для диагностики через ; или с новой строки
    autoApplyBest: false, // авто-применять лучшую стратегию после auto-tune
  },

  // --- TG WS Proxy (Flowseal/tg-ws-proxy): MTProto→WebSocket для Telegram ---
  tgws: {
    // Пусто = автопоиск: сначала скачанный бинарь в storage/tgwsproxy, затем
    // вшитый в сборку server/vendor/tgwsproxy.
    exePath: "",
    host: "127.0.0.1", // на каком адресе слушать MTProto-прокси
    port: 1443, // порт прокси: его же указывают в Telegram Desktop
    // Секрет прокси. Пусто = сгенерировать один раз и сохранить: иначе Telegram
    // ломался бы при каждом перезапуске (в самом движке секрет случайный).
    secret: "",
    autoStart: false, // поднимать прокси при старте приложения
  },

  // --- Продвинутое / развитие ---
  advanced: {
    telemetry: false, // анонимная статистика использования (logger: action-события)
    logLevel: "info", // debug | info | warn | error — минимальная важность для app.log
    masterKey: "", // мастер-ключ AES для секретов без Electron (server/security.js)

    // ВНИМАНИЕ: ключи, которых нет в DEFAULTS, отбрасываются sanitizePatch при
    // сохранении. window.lastSize/lastPos пишет main-процесс напрямую (patchSettings).
  },
};
/** Обычный объект (не null, не массив) — секция настроек. */
function isPlainObject(v: unknown): v is SettingsTree {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Глубокое слияние: base (дефолты) перекрывается extra (сохранёнными).
function deepMerge(base: unknown, extra: unknown): SettingsTree {
  const b = base as SettingsTree;
  const out: SettingsTree = Array.isArray(base)
    ? (base.slice() as unknown as SettingsTree)
    : { ...b };
  for (const k of Object.keys((extra as SettingsTree) || {})) {
    const bv = b?.[k];
    const ev = (extra as SettingsTree)[k];
    if (isPlainObject(bv) && isPlainObject(ev)) out[k] = deepMerge(bv, ev);
    else if (ev !== undefined) out[k] = ev;
  }
  return out;
}

let cache: SettingsTree | null = null;

/** Настройки с диска, слитые с DEFAULTS. Читается один раз за процесс. */
function load(): SettingsTree {
  if (cache) return cache;
  // Файл ДО слияния с DEFAULTS: нужен миграциям, которые различают «ключа в файле
  // нет» и «ключ есть со значением из DEFAULTS».
  let fileTrackers: SettingsTree | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.settings, "utf8"));
    fileTrackers = (raw && raw.trackers) || null;
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  // Разовая миграция (0.2.2): обновления стали обязательными — проверка идёт при
  // каждом запуске, а скачанное обновление нельзя отложить («Позже» больше нет).
  // Установки, где автообновление было выключено, включаем один раз: маркер
  // autoUpdateMigrated остаётся в settings.json, повторно значение не правится.
  // После try/catch дерево настроек гарантированно есть (обе ветки его создают).
  const s = cache as SettingsTree;
  const general = s.general as SettingsTree | undefined;
  if (general && general.autoUpdateMigrated !== true) {
    general.autoUpdate = true;
    general.autoUpdateMigrated = true;
    // Пишем сразу: иначе в settings.json осталось бы старое false до следующей
    // записи настроек, и «Собрать логи» показывал бы расхождение с реальностью.
    try {
      saveWithLock();
    } catch {
      /* файл только для чтения — не критично */
    }
  }
  // Разовая миграция (0.1.x): раньше запуск конфига всегда шёл процессом и
  // оставлял окно консоли в панели задач. Переводим сохранённые настройки на
  // режим службы (без окна); пользователь может вернуть process переключателем.
  const zapret = s.zapret as SettingsTree | undefined;
  if (zapret && zapret.modeMigratedToService !== true) {
    zapret.mode = "service";
    zapret.modeMigratedToService = true;
  }
  // Разовая миграция: AI-конспект больше не ходит в Ollama (провайдер и модель
  // берутся из настроек чата), поэтому ключ ollamaModel удаляем — иначе в файле
  // остаётся «мёртвое» поле, которое путает при разборе настроек.
  const lecture = s.lecture as SettingsTree | undefined;
  if (lecture && Object.prototype.hasOwnProperty.call(lecture, "ollamaModel")) {
    delete lecture.ollamaModel;
    try {
      saveWithLock();
    } catch {
      /* файл только для чтения — не критично */
    }
  }
  // Разовая миграция: трекер по умолчанию стал rutor (он отвечает без Cloudflare
  // и не требует входа). У настроек, сохранённых ДО появления поля `engine`, движок
  // определяем по адресу площадки: иначе пресет rutor (utf-8, поиск в пути, разбор
  // tr.gai) применился бы к выдаче rutracker и поиск сломался бы на разметке.
  const trackers = s.trackers as SettingsTree | undefined;
  if (trackers && fileTrackers && fileTrackers.engine === undefined) {
    const url = String(fileTrackers.baseUrl || trackers.baseUrl || "");
    if (url && !/rutor\./i.test(url)) {
      trackers.engine = "rutracker";
      try {
        saveWithLock();
      } catch {
        /* файл только для чтения — не критично */
      }
    }
  }
  return s;
}

/** Секция настроек по ключу или всё дерево (key не задан). */
function get(key?: string): any {
  const s = load();
  return key ? s[key] : s;
}

/** Частичное обновление: принимаются только известные ключи DEFAULTS. */
function set(patch: SettingsTree): SettingsTree {
  const s = load();
  const clean = sanitizePatch(patch);
  Object.assign(s, deepMerge(s, clean));
  saveWithLock();
  return s;
}

// Белая схема (С8): принимаются только ключи, существующие в DEFAULTS, и только
// значения того же типа (number/string/boolean). Всё остальное отбрасывается —
// произвольный JSON больше не может попасть в settings.json.
// skipped (необязательный массив) собирает пути отброшенных ключей — это нужно
// импорту настроек: пользователь должен видеть, что именно не применилось.
function sanitizePatch(
  patch: SettingsTree | null | undefined,
  schema: SettingsTree = DEFAULTS,
  base: string[] = [],
  skipped: string[] | null = null,
): SettingsTree {
  const out: SettingsTree = {};
  const note = (k: string): void => {
    if (skipped) skipped.push(base.concat(k).join("."));
  };
  const src: SettingsTree = patch || {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (!(k in schema)) {
      note(k);
      continue;
    }
    if (isPlainObject(schema[k])) {
      if (isPlainObject(v)) {
        const nested = sanitizePatch(v, schema[k], base.concat(k), skipped);
        if (Object.keys(nested).length) out[k] = nested;
      } else {
        note(k);
      }
      continue;
    }
    const t = typeof schema[k];
    if (t === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
      else note(k);
    } else if (t === "boolean") {
      if (typeof v === "boolean") out[k] = v;
      else note(k);
    } else if (t === "string") {
      if (typeof v === "string") out[k] = v.slice(0, 4000);
      else note(k);
    } else {
      note(k);
    }
  }
  return out;
}
/** Отчёт об импорте: применённое, отброшенное и итоговое дерево настроек. */
interface ImportResult {
  settings: SettingsTree;
  applied: SettingsTree;
  skipped: string[];
}

/**
 * Импорт настроек ЦЕЛИКОМ из файла экспорта (Настройки → «Импорт»).
 *
 * Отличие от set(): принимает объект всех настроек и возвращает отчёт — что
 * применилось (applied) и что отброшено (skipped: неизвестные ключи, чужие типы).
 * Фильтр тот же, что у PATCH: файл могли отредактировать руками, и записывать
 * строку вместо числа нельзя — страница потом падала бы на приведении типов.
 *
 * Ключи, которых НЕТ в файле, остаются как были: так импорт не затирает то, что
 * пишет main-процесс (window.lastSize и т.п.) и появившееся в новых версиях.
 */
function importAll(patch: SettingsTree | null | undefined): ImportResult {
  const skipped: string[] = [];
  const clean = sanitizePatch(patch || {}, DEFAULTS, [], skipped);
  const s = load();
  Object.assign(s, deepMerge(s, clean));
  saveWithLock();
  logger.info("settings.import_all", {
    applied: Object.keys(clean).length,
    skipped: skipped.length,
  });
  return { settings: s, applied: clean, skipped };
}

// Запись с коротким файловым lock (С10): settings.json пишут два процесса
// (Express и electron-main с lastSize) — без блокировки возможна потеря записи.
function saveWithLock(): void {
  const lock = FILES.settings + ".lock";
  let fd: number | null = null;
  for (let i = 0; i < 20 && fd === null; i++) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      const t0 = Date.now();
      while (Date.now() - t0 < 50) {
        /* busy */
      }
    }
  }
  try {
    if (fd === null) {
      // не дождались — пишем напрямую (лучше потерять гонку, чем запись)
      fs.writeFileSync(FILES.settings, JSON.stringify(cache, null, 2), "utf8");
    } else {
      const tmp = FILES.settings + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
      try {
        fs.renameSync(tmp, FILES.settings);
      } catch {
        fs.writeFileSync(FILES.settings, JSON.stringify(cache, null, 2), "utf8");
      }
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  logger.info("settings.save", {});
}

export = { load, get, set, DEFAULTS, importAll, sanitizePatch };
