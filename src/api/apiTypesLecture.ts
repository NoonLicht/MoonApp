/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */

/* ================= Lecture Recorder (GigaAM / Whisper GGUF + VAD) ================= */

export interface LectureEngineStatus {
  ready: boolean;
  /** Файл активной модели Whisper GGUF (null — не скачана). */
  model: string | null;
  backend: string | null;
  language: string;
  activeSession: boolean;
  /** auto — видеокарта/Vulkan, off — только процессор. */
  gpu: "auto" | "off";
  threads: number;
  /** Какой движок расшифрует речь сейчас: GigaAM v3, Whisper GGUF или никакой. */
  asr?: "gigaam" | "whisper" | null;
  /** Выбранный пользователем движок (по умолчанию gigaam). */
  asrPreferred?: "gigaam" | "whisper";
  /** Модель GigaAM v3 скачана и рантайм ONNX доступен. */
  gigaamInstalled?: boolean;
  /** Скачана хотя бы одна модель Whisper GGUF. */
  whisperInstalled?: boolean;
}

/** Состояние движка GigaAM v3 (GET/POST /api/lecture/engine/gigaam). */
export interface LectureGigaamInfo {
  installed: boolean;
  runtime: boolean;
  sizeMb: number;
  downloadedMb: number;
  preferred: "gigaam" | "whisper";
  /** Язык лекции поддерживается GigaAM (ru/auto). */
  languageOk: boolean;
  task: LectureEngineTask;
  dir: string;
}

/** Прогресс текущего скачивания (одна задача за раз). */
export interface LectureEngineTask {
  kind: string | null;
  state: "idle" | "working" | "done" | "error";
  id: string | null;
  progress: number;
  phase: string;
  error: string;
  received: number;
  total: number;
  at: number;
}

export type WhisperQuant = "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0";

/** Файл Whisper GGUF: семейство (small, large-v3…) × квантование. */
export interface WhisperGgufModel {
  id: string;
  family: string;
  quant: WhisperQuant;
  note: "tiny" | "base" | "small" | "medium" | "turbo" | "large";
  sizeMb: number;
  downloaded: boolean;
  downloadedMb: number;
  active: boolean;
  isDefault: boolean;
}

/** GET/POST /api/lecture/engine/whisper: модели Whisper GGUF (transcribe.cpp). */
export interface WhisperGgufInfo {
  installed: boolean;
  runtime: boolean;
  activeModel: string;
  gpu: "auto" | "off";
  backend: string | null;
  models: WhisperGgufModel[];
  task: LectureEngineTask;
  dir: string;
  defaultQuant: WhisperQuant;
}
export interface LectureSession {
  id: number;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  raw_file: string;
  status: string;
  notes: string;
}
export interface LectureChunk {
  id: number;
  lecture_id: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  status: "pending" | "done" | "empty" | "error" | "vad_skip";
  error: string;
  file: string;
  /** Почему чанк пустой/пропущен: whisper_empty | noise | hum | low_speech_ratio | noise_burst. */
  reason?: string;
  /** Диагностика уровня: dBFS по RMS и по пику, доля речи, шумовой пол, порог, ZCR. */
  rms_db?: number;
  rms_peak_db?: number;
  speech_ratio?: number;
  noise_floor_db?: number;
  threshold_db?: number;
  zcr?: number;
  /** Дорожка: mic — микрофон/аудитория, sys — системный звук (эфир), recheck — найдено проверкой. */
  source?: "mic" | "sys" | "recheck" | string;
  /** Говорящий по диаризации (sherpa): «sys_0», «mic_2». Пусто — разбора не было. */
  speaker?: string;
  /** Доля доминирующего голоса в чанке (0..1): ниже 0.55 — в чанке звучали двое. */
  speakerRatio?: number;
}

/** Живые метрики VAD по дорожке (порог, шумовой пол, пропуски). */
export interface LectureVadMetrics {
  thresholdDb: number;
  noiseFloorDb: number;
  adaptive: boolean;
  zcrGate: boolean;
  lastZcr: number;
  skipped: number;
  skippedCount: number;
  recordingSec?: number;
  stats: {
    frames: number;
    speechFrames: number;
    rejected: number;
    chunks: number;
    loudFrames: number;
    noiseFrames: number;
    skippedMs: number;
  };
}

/** Прогресс «Проверить пропуски» (повторная расшифровка потерянных участков). */
export interface LectureRecheckState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  total: number;
  found: number;
  restored: number;
  error: string;
  at: number;
  truncated: boolean;
}

/**
 * AI-конспект: собирается чанками через провайдера чата (DeepSeek и др.).
 * `blocks` — на сколько фрагментов разбили расшифровку, `truncated` — лекция
 * длиннее предохранителя (conspectusMaxChunks), `ofTotal` — сколько блоков
 * получилось бы целиком (для честного сообщения в UI).
 */
export interface LectureConspectusResult {
  markdown: string;
  model: string;
  blocks: number;
  truncated: boolean;
  ofTotal: number;
  /** true — конспект собран «Регенерировать» и заметки перезаписаны целиком. */
  replaced?: boolean;
}

/** Прогресс сборки конспекта (GET /lecture/:id/conspectus). */
export interface LectureConspectusState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  total: number;
  /** notes — идут черновые заметки по блокам, merge — сведение в конспект. */
  phase: "" | "notes" | "merge" | "done";
  model: string;
  error: string;
  truncated: boolean;
  at: number;
  /** Режим запуска (smart/auto/manual) и провайдер — для бейджа в панели. */
  trigger?: LectureConspectusTrigger;
  providerId?: string;
  autoMinChars?: number;
  /** Символы распознанного текста на момент запроса. */
  transcriptChars?: number;
  conspectusAt?: string;
  /** После сборки расшифровка заметно выросла — конспект стоит обновить. */
  stale?: boolean;
}

/**
 * Режим запуска конспекта: smart — авто с проверками (хватает ли текста, нет
 * ли уже собранного конспекта), auto — авто всегда, manual — только кнопкой.
 */
export type LectureConspectusTrigger = "smart" | "auto" | "manual";

/* ------------------------- Разделение говорящих (диаризация) ------------------------- */

/** Пакет диаризации: бинарь sherpa, модель сегментации, модель эмбеддингов. */
export interface LectureDiarizePackage {
  id: "bin" | "seg" | "emb" | string;
  sizeMb: number;
  dir: string;
  installed: boolean;
}

/** Задача установки пакета (прогресс скачивания/распаковки). */
export interface LectureDiarizeTask {
  kind: string | null;
  state: "idle" | "working" | "done" | "error";
  id: string | null;
  progress: number;
  /** download — качаем, extract — распаковываем архив. */
  phase: "" | "download" | "extract" | string;
  error: string;
  received: number;
  total: number;
  at: number;
}

/** Настройки диаризации (GET /lecture/diarize/setup → settings). */
export interface LectureDiarizeSettings {
  enabled: boolean;
  threshold: number;
  speakers: number;
  track: "auto" | "sys" | "mic";
  limits: { threshold: [number, number]; speakers: [number, number] };
  installed: { bin: string | null; seg: string | null; emb: string | null; ready: boolean };
  task: LectureDiarizeTask;
}

/** Состояние пакета диаризации: что установлено и что происходит сейчас. */
export interface LectureDiarizeSetup {
  ready: boolean;
  engine: {
    bin: string | null;
    seg: string | null;
    emb: string | null;
    version: string;
    dir: string;
  };
  packages: LectureDiarizePackage[];
  task: LectureDiarizeTask;
  settings: LectureDiarizeSettings;
}

/** Прогресс разбора говорящих в конкретной лекции. */
export interface LectureDiarizeState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  /** Какая дорожка считается сейчас: sys (эфир) или mic (аудитория). */
  phase: string;
  error: string;
  tracks: string[];
  speakers: number;
  at: number;
}

/** Провайдер конспекта: ярлык, каталог моделей и признак заданного ключа. */
export interface LectureProviderInfo {
  id: string;
  label: string;
  models: string[];
  hasKey: boolean;
}

/** Пресет системного промпта конспекта (встроенный или свой). */
export interface LectureConspectusPreset {
  id: string;
  label: string;
  systemPrompt: string;
  builtin?: boolean;
}

/** Настройки ИИ-конспекта (GET/POST /lecture/conspectus/settings). */
export interface LectureConspectusSettings {
  providerId: string;
  /** true — провайдер наследуется от настроек AI-чата (conspectusProvider = ""). */
  providerFromChat: boolean;
  chatProvider: string;
  hasKey: boolean;
  model: string;
  trigger: LectureConspectusTrigger;
  autoMinChars: number;
  chunkChars: number;
  overlapChars: number;
  maxChunks: number;
  /** Свой системный промпт; пусто — используется пресет presetId. */
  systemPrompt: string;
  presetId: string;
  maxTokens: number;
  presets: LectureConspectusPreset[];
  triggerOptions: LectureConspectusTrigger[];
  providers: LectureProviderInfo[];
}

/** Настройки аудиовхода: микрофон, гейн, порог VAD. */
export interface LectureAudioSettings {
  micDeviceId: string;
  micGain: number;
  micAgc: boolean;
  /** Потоковая расшифровка (бета): черновой текст сегмента до паузы (см. LectureStatus.draft). */
  streaming: boolean;
  vad: {
    rmsThreshold: number;
    thresholdDb: number;
    adaptive: boolean;
    thresholdFactor: number;
    minSpeechRatio: number;
    zcrGate: boolean;
    silenceMs: number;
    minChunkMs: number;
    maxChunkMs: number;
    forceSplitMs: number;
  };
  limits: {
    micGain: [number, number];
    rmsThreshold: [number, number];
    thresholdFactor: [number, number];
    minSpeechRatio: [number, number];
  };
}

/**
 * Патч аудионастроек для POST /lecture/audio: страница присылает только те поля,
 * которые реально меняет (остальные остаются прежними). Выведен из
 * LectureAudioSettings, чтобы подмножество полей нельзя было рассинхронизировать:
 * раньше этот же список жил ещё и inline-типом в LectureAudioPanel.
 */
export type LectureAudioPatch = Partial<
  Pick<LectureAudioSettings, "micDeviceId" | "micGain" | "micAgc" | "streaming">
> & {
  vad?: Partial<
    Pick<
      LectureAudioSettings["vad"],
      "rmsThreshold" | "adaptive" | "thresholdFactor" | "minSpeechRatio" | "zcrGate"
    >
  >;
};

export interface LectureStatus {
  lecture: LectureSession;
  chunks: LectureChunk[];
  live: boolean;
  queue: number;
  transcribing: boolean;
  recordingSec: number;
  vadStats: { frames: number; speechFrames: number; rejected: number; chunks: number } | null;
  /** Живая диагностика по дорожкам (mic/sys): порог, шумовой пол, пропуски. */
  vad?: Record<string, LectureVadMetrics> | null;
  recheck?: LectureRecheckState;
  lastError: string;
  /**
   * Потоковая расшифровка (бета): черновой текст незакрытого сегмента по
   * дорожкам (mic/sys) — появляется до паузы и заменяется финальным чанком,
   * когда VAD его закроет. null — сессия не идёт; "" — сегмент закрыт/тишина.
   */
  draft?: { mic: string; sys: string } | null;
  whisper: LectureEngineStatus;
}
export interface LectureCreateResult {
  id: number;
  sampleRate: number;
  channels: number;
  vad: {
    silenceMs: number;
    minChunkMs: number;
    maxChunkMs: number;
    forceSplitMs: number;
    padMs: number;
  };
  whisper: LectureEngineStatus;
}

/** Карточка Foresight: вопрос со встречи и найденный в личной базе ответ. */
export interface ForesightCard {
  id: string;
  question: string;
  /** Когда прозвучал (мс от начала записи); 0 для вопроса, заданного вручную. */
  atMs: number;
  status: "searching" | "done" | "none" | "error";
  answer: string;
  sources: { source: string; ref: string; title: string; snippet: string; score: number }[];
  manual: boolean;
}
