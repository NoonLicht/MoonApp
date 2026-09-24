/* -------------------------------- Флибуста / Книги ----------------------- */

/** Книга из OPDS-фида Флибусты. */
export interface FlibustaBook {
  id: string; // "tag:book:..."
  bid: number; // числовой id для скачивания
  title: string;
  author: string;
  genres: string[];
  language: string | null;
  year: number | null;
  formats: string[]; // ["fb2","epub","mobi","pdf",...]
  sizeText: string; // "3074 Kb" и т.п.
  cover: string | null; // url к обложке
  description: string;
  updatedAt: string;
  fav?: boolean; // в избранном
  bm?: boolean; // в закладках
  addedAt?: string;
}

/** Жанр OPDS-фида. */
export interface BookGenre {
  title: string;
  href: string;
}

/** Результат фида/поиска (страница по size книг). */
export interface BooksFeedResult {
  items: FlibustaBook[];
  hasMore: boolean;
  flags: Record<string, { fav: boolean; bm: boolean }>;
  popularFallback?: boolean;
}

/** Результат скачивания книги. */
export interface BookDownloadResult {
  file: string;
  name: string;
  size: number;
  fmt: string;
  bid: number;
}
/**
 * Общие типы контрактов фронтенда. Зеркалит структуры бэкенда
 * (server/db.js tables, routes/*, server/ts/monitor.ts).
 */

/* ---------------------------------- Чат ----------------------------------- */
/* ========================== MySpace Tasks ========================== */

export interface TaskChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface TaskAttachment {
  name: string;
  url: string;
  type: string;
}

export type TaskStatus = "todo" | "in_progress" | "deferred" | "completed";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskRecurrence = "none" | "daily" | "weekly" | "weekdays" | "custom";

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  estimatedTime: number; // minutes
  actualTime: number; // minutes (tracked)
  recurrence: TaskRecurrence;
  dueDate: string | null; // ISO date
  reminderDateTime: string | null; // ISO datetime
  checklist: TaskChecklistItem[];
  attachments: TaskAttachment[];
  urls: string[];
  tags: string[];
  projectId: string;
  folder: string;
  location: string;
  dependencies: string[]; // taskId[] - blocked by
  backlinks: string[]; // [[Note]] or @Task references
  created_at: string;
  updated_at: string;
}

export interface TaskCreatePayload {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  estimatedTime?: number;
  dueDate?: string;
  reminderDateTime?: string;
  tags?: string[];
  projectId?: string;
  folder?: string;
  dependencies?: string[];
  recurrence?: TaskRecurrence;
}

export interface VaultFile {
  path: string;
  name: string;
  type: "note" | "folder" | "canvas";
  ext?: string;
  children?: VaultFile[];
}

export interface VaultFileContent {
  path: string;
  name: string;
  ext: string;
  content: string;
  frontmatter: Record<string, string>;
  tags: string[];
  wikiLinks: string[];
  outline: VaultOutlineEntry[];
  backlinks: VaultBacklink[];
}

export interface VaultOutlineEntry {
  level: number;
  text: string;
  line: number;
}

export interface VaultBacklink {
  path: string;
  name: string;
  type: "linked" | "unlinked";
  snippet: string;
}

export interface VaultSearchResult {
  path: string;
  name: string;
  snippet: string;
  matchStart: number;
}

/**
 * Результат ИИ-оформления заметки (POST /api/myspace/ai/format|regenerate).
 * `content` — готовый Markdown, который уже записан в файл заметки.
 */
export interface NotesAiResult {
  content: string;
  provider: string;
  model: string;
  /** Символов в готовом тексте. */
  chars: number;
  /** Символов в исходнике, из которого собрано оформление. */
  rawChars: number;
  /** Сколько блоков ушло в модель (длинная заметка режется по строкам). */
  blocks: number;
  /** true — текст собран «Регенерировать» из сохранённого исходника. */
  regenerated: boolean;
}

/** Провайдер для ИИ-оформления заметок (GET /api/myspace/ai/config). */
export interface NotesAiProvider {
  id: string;
  label: string;
  /** Каталог моделей провайдера (живой список уточняет /ai/models). */
  models: string[];
  /** Ключ провайдера сохранён в Настройках («Настройки → ИИ»). */
  hasKey: boolean;
}

/**
 * Выбранные провайдер и модель для ИИ-оформления заметок. Пустые myspace.ai.*
 * означают «как в AI-чате» (providerFromChat = true) — так работало раньше.
 */
export interface NotesAiConfig {
  providerId: string;
  /** true — свой провайдер не выбран, используется chat.provider. */
  providerFromChat: boolean;
  /** Провайдер AI-чата (для подписи «как в чате: deepseek»). */
  chatProvider: string;
  /** Выбранная модель ("" — подобрать автоматически по каталогу). */
  model: string;
  /** Ключ текущего провайдера сохранён. */
  hasKey: boolean;
  providers: NotesAiProvider[];
}

export interface VaultTag {
  tag: string;
  count: number;
}

export interface GraphNode {
  id: string;
  type: "note" | "task";
  label: string;
  noteId?: number;
  taskId?: number;
  done?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Conversation {
  id: number;
  provider: string;
  title: string;
  created_at: string;
  updated_at: string;
  pinned?: number;
}

export interface ChatMessage {
  id?: number;
  conversation_id?: number;
  role: "user" | "assistant";
  text: string;
  created_at?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
  stub: boolean;
  configured: boolean;
}

/* -------------------- Экспорт и импорт всех настроек ----------------------- */
/**
 * Отчёт импорта настроек (POST /api/settings/import).
 * skipped — пути, которые НЕ применились (неизвестный ключ или чужой тип):
 * показываем их пользователю, чтобы импорт не выглядел «полным» молча.
 */
export interface SettingsImportResult {
  ok: boolean;
  settings: Record<string, unknown>;
  applied: number;
  skipped: string[];
  keysApplied: number;
  keysSkipped: string[];
  ui: Record<string, string>;
  sourceVersion: string;
}

/* ------------------------------ Store / каталог ---------------------------- */

export interface AppItem {
  key: string; // "winget:<id>" | "catalog:<id>"
  id?: number;
  name: string;
  category: string;
  source: "winget" | "comss" | "custom" | string;
  wingetId?: string | null;
  version?: string | null;
  url?: string | null;
  favorite: boolean;
}

export interface BooksItem {
  id: number;
  title: string;
  author: string;
  year: number;
  fmt: string;
  tone: string;
  description: string;
}

export interface ArchiveItem {
  id: number;
  name: string;
  size_text: string;
  saved_at: string;
}

export interface BackupInfo {
  at: string;
  trigger: string;
}

/** Статус LibreHardwareMonitor (GET /api/monitor/lhm). */
export interface LhmStatus {
  wmi: boolean; // пространство root/LibreHardwareMonitor отвечает
  exePath: string | null; // найденный путь к LibreHardwareMonitor.exe
  pid: number | null; // запущен ли нами (PID процесса)
  bundled: boolean; // скачан ли headless-движок (LibreHardwareMonitorLib)
}

/** Статус FFmpeg + каталог поддерживаемых форматов (GET /api/convert/tools). */
export interface ConvertTools {
  ready: boolean;
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  categories: { id: string; inputs: string[]; outputs: string[] }[];
}

/** Результат конвертации (POST /api/convert). */
export interface ConvertResult {
  key: string;
  name: string;
  size: number;
  category: string;
  to: string;
}

/** Статус/прогресс тихой установки FFmpeg (GET /api/convert/install). */
export interface ConvertInstallStatus {
  state: "idle" | "working" | "done" | "error";
  progress: number; // 0..100 (скачивание)
  phase: string; // "download" | "extract" | ""
  error: string;
  installed: boolean; // ffmpeg.exe уже лежит в storage/ffmpeg/
}

/* -------------------------------- Видео ------------------------------------ */

/** Метаданные и доступные форматы с URL (GET /api/video/info). */
export interface VideoInfo {
  title: string;
  webUrl: string;
  duration: number | null;
  durationString: string;
  thumbnail: string | null;
  formats: VideoFormat[];
  heights: number[];
  subtitles: { [lang: string]: string[] };
  autoCaptions: { [lang: string]: string[] };
  isLive: boolean;
}

export interface VideoFormat {
  format_id: string;
  ext: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  note: string;
  filesize: number | null;
  tbr: number | null;
}

/** Результат запуска загрузки (POST /api/video/download). */
export interface VideoDownloadResult {
  id: string;
}

/** Прогресс загрузки (GET /api/video/status/:id). */
export interface VideoJobStatus {
  found?: boolean;
  id?: string;
  state: "running" | "done" | "error" | "not_found";
  progress?: number;
  error?: string;
  files?: { name: string; size: number; key: string }[];
}

/** Статус yt-dlp (GET /api/video/install). */
export interface YtdlpInstallStatus {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
  installed: boolean;
}

/* ------------------------------- Мониторинг -------------------------------- */

export interface TempSensor {
  id: string;
  name: string;
  hw: string;
  value: number | null;
}
export interface FanSensor {
  name: string;
  hw: string;
  rpm: number | null;
}
export interface ValueSensor {
  name: string;
  hw: string;
  value: number | null;
}

export interface GpuInfo {
  name: string;
  utilizationPercent: number | null;
  temperatureC: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  fanPercent: number | null;
  powerWatt: number | null;
}

export interface DiskInfo {
  drive: string;
  label: string;
  totalGb: number | null;
  freeGb: number | null;
  readMBs: number | null;
  writeMBs: number | null;
}

export interface NetIfaceInfo {
  name: string;
  rxKBs: number | null;
  txKBs: number | null;
  ipv4: string[];
  mac: string;
}

/** Ответ GET /api/monitor — реальная телеметрия + compat-поля. */
export interface MonitorSnapshot {
  timestamp: string;
  cpu: {
    model: string;
    coresPhysical: number | null;
    coresLogical: number;
    baseClockMhz: number | null;
    loadTotalPercent: number;
    loadPerCorePercent: number[];
    temperatureC: number | null;
    powerWatt: number | null;
    clockMhz: number | null;
  };
  memory: { totalMb: number; usedMb: number; freeMb: number; usedPercent: number };
  gpu: GpuInfo[];
  temperatures: TempSensor[];
  fans: FanSensor[];
  voltages: ValueSensor[];
  currents: ValueSensor[];
  powers: ValueSensor[];
  clocks: ValueSensor[];
  /** Полный срез сенсоров по железу (дерево датчиков HWiNFO-стиля). */
  sensorsAll: {
    id: string;
    name: string;
    type: string;
    parent: string;
    hw: string;
    value: number | null;
  }[];
  hardware: { id: string; name: string; type: string }[];
  disks: DiskInfo[];
  network: NetIfaceInfo[];
  system: {
    hostname: string;
    arch: string;
    platform: string;
    osName: string;
    osVersion: string;
    osBuild: string;
    uptimeSec: number;
    batteryPercent: number | null;
  };
  sources: { wmi: boolean; lhm: boolean; nvidiaSmi: boolean };
  /* Обратная совместимость со старым UI */
  stub: boolean;
  cpuTemp: number | null;
  gpuTemp: number | null;
  ram: number | null;
  vram: number | null;
  fan1: number | null;
  fan2: number | null;
  history: unknown[];
}

/* -------------------------------- appBridge -------------------------------- */
/* -------------------------------- Прокси ----------------------------------- */

/** Статус прокси. */
export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  pingMs: number | null;
  country: string | null;
  error: string;
  vlessLink: string;
  validLink: boolean;
  installed: boolean;
  singBoxVersion: string | null;
  childPid: number | null;
}

/** Сохранённый VLESS-профиль. */
export interface VlessProfile {
  id: string;
  link: string;
  name: string;
  updatedAt: string;
}

/* ------------------- Встроенный прокси (sing-box core) -------------------- */

/** Состояние ядра sing-box. */
export interface ProxyCoreStatus {
  running: boolean;
  enabled: boolean;
  error: string;
  socksPort: number;
  httpPort: number;
  // Раздельная готовность инбаундов: SOCKS нужен yt-dlp/агенту, HTTP — TMDB/LLM
  // и другому fetch-трафику. running=true означает "готовы оба"; если готов
  // только один — see server/proxyCore.js waitCoreReady().
  socksReady?: boolean;
  httpReady?: boolean;
  node: {
    protocol: string;
    tag: string;
    server: string;
    port: number;
    country?: string | null;
  } | null;
  childPid: number | null;
  install?: ProxyInstallStatus;
}

/** Прогресс установки движка sing-box. */
export interface ProxyInstallStatus {
  state: string;
  progress: number;
  phase: string;
  error: string;
  errorDetail?: string;
  installed: boolean;
  path?: string | null;
  /** Проверенные пути к sing-box.exe — видны в UI, если движка нет. */
  candidates?: { path: string; exists: boolean }[];
}

/** Прогресс «пропинговать все». */
export interface ProxyPingStatus {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: number;
  currentId: number | null;
  currentName: string;
  startedAt: number;
  finishedAt: number;
  error: string;
  results: { id: number; name: string; ok: boolean; ttfbMs: number | null; error: string }[];
}

/** Узел подписки (компактная запись для UI). */
export interface ProxyNode {
  id: number;
  subId: number;
  name: string;
  protocol: string;
  server: string | null;
  port: number | null;
  pingMs: number | null;
  country: string;
  isSelected: boolean;
  /** Узел убран пользователем из списка (скрыт), но остаётся в подписке. */
  isExcluded: boolean;
  /** Транспорт узла: tcp/ws/grpc/… (xhttp движок не поддерживает). */
  transport?: string;
  /** Движок (sing-box) не умеет этот транспорт — узел запустить нельзя. */
  unsupported?: boolean;
}

/** Подписка с вложенными узлами. */
export interface ProxySubscription {
  id: number;
  name: string;
  url: string;
  last_updated: string;
  auto_update_enabled: number;
  nodes: ProxyNode[];
}

/** Правило «страница → прокси/direct». */
export interface ProxyPageRule {
  id: number;
  route_path: string;
  is_proxied: number;
}

/** Результат реального TTFB-пинга через SOCKS5. */
export interface ProxyLatency {
  state: "online" | "degraded" | "blocked" | "offline";
  latencyMs: number | null;
  targets: { url: string; state: string; status: number; ttfbMs: number | null; error: string }[];
  ip: string | null;
  country: string | null;
  isp: string | null;
  error?: string;
}
/* -------------------------------- Музыка / Аудио --------------------------- */

/** Результат поиска трека. */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  duration: number | null;
  durationString: string;
  thumbnail: string | null;
  webpageUrl: string;
}

/** Результат поиска. */
export interface MusicSearchResult {
  tracks: MusicTrack[];
  source: string;
}

/** Ответ /api/music/formats */
export interface MusicFormats {
  formats: string[];
  qualityMap: Record<string, { format: string; quality: number }>;
}

/** Ответ на старт скачивания. */
export interface MusicDownloadStart {
  id: string;
}

/** Статус джобы скачивания. */
export interface MusicJobStatus {
  id: string;
  state: "running" | "done" | "error" | string;
  progress: number;
  error: string;
  files: { name: string; size: number; key: string }[];
  found?: boolean;
}

/* ========================== MySpace Canvas / Holst ========================== */

export interface HolstFileEntry {
  name: string;
  path: string;
  updatedAt: string | null;
  thumbnail: string | null;
}

export interface HolstReadResult {
  name: string;
  data: any;
  error?: string;
}

export interface HolstWriteResult {
  ok: boolean;
  name: string;
}

/* ------------------------ Фильмы и сериалы (страница movies) ----------------- */

export type MediaKind = "movie" | "tv";

/** Краткая карточка тайтла (карусели, сетки, поиск). */
export interface MediaSummary {
  kind: MediaKind;
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  year: number | null;
  date: string | null;
  voteAverage: number;
  voteCount: number;
  popularity: number;
  genreIds: number[];
  adult: boolean;
}

export interface MediaCast {
  id: number;
  name: string;
  character: string;
  profile: string | null;
}
export interface MediaCrew {
  id: number;
  name: string;
  job: string;
  department: string;
  profile: string | null;
}
export interface MediaVideo {
  key: string;
  name: string;
  type: string;
  official?: boolean;
}
export interface MediaProvider {
  id: number;
  name: string;
  logo: string | null;
  displayPriority?: number;
}

/** Легальные площадки («где смотреть») по региону пользователя. */
export interface MediaProviders {
  region: string;
  link: string | null;
  flatrate: MediaProvider[];
  rent: MediaProvider[];
  buy: MediaProvider[];
}

export interface MediaGallery {
  backdrops: string[];
  posters: string[];
}
export interface MediaGenre {
  id: number;
  name: string;
}

/** Полная карточка тайтла (детали, каст, трейлеры, галерея, похожие). */
export interface MediaDetails extends MediaSummary {
  tagline: string;
  status: string;
  homepage: string;
  runtime: number | null;
  seasons: number;
  episodes: number;
  budget: number;
  revenue: number;
  genres: MediaGenre[];
  countries: string[];
  languages: string[];
  ageRating: string | null;
  imdbId: string | null;
  cast: MediaCast[];
  crew: MediaCrew[];
  videos: MediaVideo[];
  trailer: MediaVideo | null;
  gallery: MediaGallery;
  similar: MediaSummary[];
  recommendations: MediaSummary[];
  providers: MediaProviders;
}

/** Ответ подборки/трендов/discover. */
export interface MediaListResult {
  items: MediaSummary[];
  page: number;
  totalPages: number;
  /** Всего записей в подборке по данным TMDB (для счётчика «N из M»). */
  totalResults?: number;
  region?: string;
  category?: string;
}

export type MediaWatchStatus = "plan" | "watching" | "watched";

/** Запись личного списка просмотра. */
export interface MediaWatchlistEntry {
  id: number;
  kind: MediaKind;
  tmdb_id: number;
  title: string;
  poster: string;
  year: number | null;
  status: MediaWatchStatus;
  runtime: number | null;
  genres: (string | MediaGenre)[];
  added_at: string;
  updated_at: string;
}

/** Личная оценка 1–10. */
export interface MediaRatingEntry {
  id: number;
  kind: MediaKind;
  tmdb_id: number;
  title: string;
  rating: number;
  updated_at: string;
}

/** Запись статистики просмотра (одна на тайтл). */
export interface MediaWatchEntry {
  id: number;
  kind: MediaKind;
  tmdb_id: number;
  title: string;
  genres: (string | MediaGenre)[];
  cast: { name: string }[] | string[];
  runtime: number | null;
  progress: number;
  minutes: number;
  watched_at: string;
}

export interface MediaState {
  watchlist: MediaWatchlistEntry | null;
  rating: MediaRatingEntry | null;
  watch: MediaWatchEntry | null;
}

export interface MediaLibrary {
  watchlist: MediaWatchlistEntry[];
  ratings: MediaRatingEntry[];
  stats: MediaWatchEntry[];
}

/** Агрегированная статистика просмотров. */
export interface MediaStats {
  totalTitles: number;
  totalMinutes: number;
  totalHours: number;
  completed: number;
  watchlist: { plan: number; watching: number; watched: number };
  avgRating: number;
  ratingCount: number;
  ratingHistogram: { value: number; count: number }[];
  topGenres: { name: string; count: number }[];
  topActors: { name: string; count: number }[];
  monthly: { month: string; count: number }[];
}

/**
 * Откуда взялся ключ TMDB: secret — пользователь ввёл свой, bundled — вшит в
 * сборку приложения (работает «из коробки»), none — ключа нет вовсе.
 */
export type MediaKeySource = "secret" | "bundled" | "none";

/** Статус страницы: есть ли ключ TMDB и движок торрентов. */
export interface MediaStatus {
  hasKey: boolean;
  keySource: MediaKeySource;
  engine: { installed: boolean; client?: boolean; error?: string };
  settings: {
    language?: string;
    region?: string;
    showAdult?: boolean;
    cacheMinutes?: number;
  };
}

/* --- Торрент-плеер (источник задаёт пользователь: magnet/.torrent) --- */

export interface TorrentFile {
  index: number;
  name: string;
  path: string;
  length: number;
  mime: string;
  progress: number;
  playable: boolean;
}

export interface TorrentAddResult {
  infoHash: string;
  name: string;
  length: number;
  files: TorrentFile[];
}

export interface TorrentStatus {
  infoHash: string;
  name: string;
  ready: boolean;
  done: boolean;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  downloaded: number;
  uploaded: number;
  length: number;
  peers: number;
  timeRemaining: number | null;
  ratio: number;
  files: TorrentFile[];
}

/**
 * Загрузка торрента в реестре плеера (вкладка «Скачанные»).
 * Живёт в БД, поэтому загрузки видны и после перезапуска приложения.
 */
export interface TorrentDownload {
  infoHash: string;
  name: string;
  /** Название фильма/сериала: по нему окно плеера восстанавливается. */
  title: string;
  /** id раздачи на трекере (если открывали из поиска раздач). */
  releaseId: string | null;
  magnet: string | null;
  source: "magnet" | "tracker" | "file";
  length: number;
  /** downloading — качается, paused — остановлено, done — загружено. */
  state: "downloading" | "paused" | "done";
  /** Галочка «хранить скачанный торрент после просмотра». */
  kept: boolean;
  /** Секунда, на которой остановился просмотр (продолжаем с неё). */
  position: number;
  addedAt: string;
  updatedAt: string;
  /** Раздача сейчас в движке: есть живой прогресс/скорость. */
  active: boolean;
  progress: number;
  downloadSpeed: number;
  peers: number;
  downloaded: number;
}

/** Ответ реестра загрузок: список + общая галочка «хранить после просмотра». */
export interface TorrentDownloadsResult {
  items: TorrentDownload[];
  keepDefault: boolean;
}

/** Готовность ffmpeg/ffprobe: выбор дорожек и переупаковка на лету. */
export interface FfmpegStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  path: string | null;
  version: string | null;
  /** Где искали бинарь — показываем, если не нашли (куда положить файл). */
  searched: string[];
}

/* --- Форум-трекер: поиск раздач (rutracker.org и phpBB-совместимые) --- */

/**
 * Движок площадки (какой парсер и способ поиска использовать):
 *  - "rutracker" — phpBB-форум: cp1251, POST-поиск по `nm`, выдача в таблице;
 *  - "rutor" — rutor.info: utf-8, поиск частью пути `/search/0/0/000/0/<запрос>`,
 *    вход не нужен, выдача в строках `tr.gai`/`tr.tum`.
 */
export type TrackerEngine = "rutracker" | "rutor";

/** Трекер, доступный для переключения (список приходит в статусе). */
export interface TrackerPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Нужен ли вход: у rutor поиск работает без логина. */
  requiresLogin: boolean;
}

/** Метаданные, разобранные из названия раздачи. */
export interface TrackerReleaseMeta {
  resolution: string | null;
  codec: string | null;
  audio: string[];
  releaseGroup: string | null;
  source: string | null;
  hdr: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

export interface TrackerRelease {
  id: string;
  title: string;
  size: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  downloads: number;
  topicUrl: string | null;
  torrentUrl: string | null;
  magnet: string | null;
  meta: TrackerReleaseMeta;
}

export interface TrackerSearchResult {
  query: string;
  items: TrackerRelease[];
  total: number;
  cached: boolean;
  via: "proxy" | "direct";
}

export interface TrackerStatus {
  enabled: boolean;
  configured: boolean;
  hasCredentials: boolean;
  label: string;
  baseUrl: string;
  /** Движок площадки: "rutracker" (phpBB, вход обязателен) | "rutor". */
  engine: TrackerEngine;
  /** Нужен ли вход для поиска: у rutor — нет (UI не просит логин). */
  requiresLogin: boolean;
  /** Доступные трекеры для переключателя. */
  presets: TrackerPreset[];
  /**
   * Сессия форума: ok=true при РЕАЛЬНОМ входе (кука bb_data) у движков с входом,
   * а у движков без входа (rutor) — «готово к поиску».
   */
  session: { ok: boolean; updatedAt: string | null };
  /** Имена куки сессии (значения не раскрываются): видно, есть ли cf_clearance. */
  cookieNames: string[];
  lastError: { code: string; message: string; at: string } | null;
  /**
   * Окно входа (Chromium приложения). available=false вне Electron — тогда
   * остаётся автоподхват куки из браузеров или ручная вставка.
   */
  chromium: { available: boolean; partition: string; loggedIn: boolean };
  /** Страница входа: её открывает окно входа. */
  loginUrl: string;
  /** SOCKS-прокси поиска (null — напрямую): окно входа берёт тот же. */
  proxyUrl: string | null;
  /**
   * UA для окна входа: пусто — приложение подставит обычный Chrome от версии своего
   * Chromium (без «Electron/…» в отпечатке, иначе Cloudflare не пропускает).
   */
  userAgent: string;
  /** Доступность ffmpeg/ffprobe (нужны для выбора дорожек и субтитров). */
  ffmpeg?: boolean;
  ffprobe?: boolean;
}

/**
 * Диагностика ответа внешнего источника (форума): по ней видно, что именно
 * пришло — Cloudflare-челлендж, форма входа или другая вёрстка.
 */
export interface TrackerErrorDetails {
  status?: number;
  bytes?: number;
  url?: string;
  snippet?: string;
  authorized?: boolean;
  loginForm?: boolean;
  cloudflare?: boolean;
  /**
   * Каким транспортом уходил запрос: «chromium» — сетевой стек окна входа (тогда
   * cf_clearance подходит), «fetch» — обычный запрос сервера (Cloudflare считает его
   * ботом). Видно в диагностике ошибки.
   */
  transport?: string;
  /** UA, которым представились форуму: cf_clearance привязан к паре «IP + UA». */
  userAgent?: string;
  /** Прокси страницы «Фильмы» (null — напрямую); окно входа берёт тот же. */
  proxy?: string | null;
  /** Имена куки нашей сессии форума. */
  cookies?: string[];
  /** Есть ли кука входа (bb_data) — без неё поиск уходит гостем. */
  hasLogin?: boolean;
}

/**
 * Что нашли в конкретном браузере/профиле при автоподхвате куки. Показывается
 * пользователю, чтобы он понимал, кого именно надо открыть и войти на форум.
 */
export interface BrowserProbe {
  id: string;
  browser: string;
  profile: string;
  version: string;
  cookies: number;
  reason: string;
  /** База куки занята запущенным браузером: нужно закрыть браузер и повторить. */
  locked?: boolean;
  /** Профиль шифрует куки app-bound (v20): читает только сам браузер. */
  appBound?: boolean;
}

/** Патч настроек форума: логин/пароль уходят в секреты, не в settings.json. */
export interface TrackerConfigPatch {
  enabled?: boolean;
  /** Движок площадки: обычно меняется через /tracker/preset, а не вручную. */
  engine?: TrackerEngine;
  baseUrl?: string;
  label?: string;
  loginPath?: string;
  searchPath?: string;
  searchMethod?: "get" | "post";
  searchParam?: string;
  topicPath?: string;
  torrentPath?: string;
  encoding?: string;
  /** UA для запросов (важно, когда cf_clearance привязан к UA браузера). */
  userAgent?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxResults?: number;
  requireDownloadable?: boolean;
  login?: string;
  password?: string;
}

/* --- Дорожки и субтитры файла раздачи (Сценарий Б) --- */

export interface TorrentMediaFileList extends TorrentAddResult {
  /** true — медиафайлов нет, показаны все файлы раздачи. */
  noMedia: boolean;
}

export interface TorrentAudioTrack {
  /** Относительный индекс (идёт в remux как ?audio=). */
  index: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  label: string;
  codec: string;
  channels: number;
  isDefault: boolean;
  isOriginal: boolean;
}

export interface TorrentSubtitleTrack {
  /** Для дорожек контейнера — относительный индекс, у внешних файлов будет -1. */
  index: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  label: string;
  codec: string;
  isDefault: boolean;
  forced: boolean;
  /** Внешний файл .srt/.vtt из раздачи (читается через ?file=). */
  external?: boolean;
  fileIndex?: number;
}

/**
 * Как файл раздачи воспроизводится в Chromium (решает бэкенд по ffprobe):
 *  direct — <video> читает файл сам; remux — переупаковка в MP4 (видео копируется,
 *  звук → AAC); transcode — видео тоже перекодируется; unsupported — нет FFmpeg.
 */
export type PlaybackMode = "direct" | "remux" | "transcode" | "unsupported";

export interface TorrentPlaybackPlan {
  mode: PlaybackMode;
  /** true — видео копируется без потерь, false — перекодируется в H.264. */
  videoCopy: boolean;
  /** Причина выбора режима: native | container | audio_codec | codec | ffmpeg_missing. */
  reason: string;
}

/**
 * Куда реально встанет перемотка.
 *
 * При копировании видео (`copy=1`) сервер выравнивает старт по ключевому кадру —
 * иначе видео и звук начинаются в разных точках. При точном seek (`copy=0`) видео
 * перекодируется, `startSec` равна запрошенной секунде, и выравнивание не нужно.
 */
export interface TorrentSeekInfo {
  /** Секунда, которую запросил плеер. */
  requested: number;
  /** Секунда, с которой реально начнётся поток (шкала и позиция берут её). */
  startSec: number;
  /** true — старт сдвинут к ключевому кадру раньше запрошенной секунды. */
  keyframe: boolean;
  /**
   * true — секунда точная: поток начнёт ровно с неё (перекодирование), выравнивание
   * по ключевому кадру не требуется. Плеер по этому признаку ставит `&aligned=1`.
   */
  exact: boolean;
}

export interface TorrentTrackList {
  infoHash: string;
  index: number;
  file: { name: string; length: number; mime: string };
  durationSec: number;
  video: { codec: string; width: number; height: number; hdr: boolean } | null;
  audio: TorrentAudioTrack[];
  subtitles: TorrentSubtitleTrack[];
  ffmpeg: boolean;
  defaultAudio: number;
  /** План воспроизведения (может отсутствовать у старого бэкенда). */
  plan?: TorrentPlaybackPlan;
}

declare global {
  interface Window {
    appBridge?: {
      version: () => string;
      platform: string;
      getToken: () => string | null;
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      // Открыть каталог установки приложения (кнопка в верхней панели).
      openAppDir?: () => Promise<{ ok: boolean; dir?: string; error?: string }>;
      /**
       * Автозапуск с Windows: применить настройку сразу (реестр Run меняет
       * main-процесс). reason: "dev" — в не-собранной версии автозапуск не ставим.
       */
      applyAutoLaunch?: () => Promise<{
        ok: boolean;
        openAtLogin?: boolean;
        reason?: string;
      }>;
      // Обновления приложения (работают только в packaged-сборке). С 0.2.2
      // обновления обязательны: включение/выключение не предусмотрено.
      checkUpdates?: () => Promise<{
        ok: boolean;
        available?: boolean;
        version?: string | null;
        reason?: string;
      }>;
      downloadUpdate?: () => Promise<{
        ok: boolean;
        available?: boolean;
        version?: string | null;
        downloading?: boolean;
        reason?: string;
      }>;
      /**
       * Режим захвата звука: "loopback" — системный звук (WASAPI через
       * setDisplayMediaRequestHandler в electron/main.js), "default" — обычный
       * выбор экрана. Без loopback getDisplayMedia в Electron отдаёт видео и
       * звук выбранного источника, а не звук системы (см. страницу лекций).
       */
      setCaptureMode?: (
        mode: "loopback" | "default",
      ) => Promise<{ ok: boolean; mode?: string; error?: string }>;
      /**
       * Окно входа на форум (Chromium приложения): открывается страница входа, и
       * когда пользователь вошёл — возвращаются куки его сессии. Единственный путь
       * сквозь Cloudflare-проверку: Chrome/Edge 127+ шифруют куки app-bound ключом,
       * прочитать их снаружи нельзя (см. electron/main.js → tracker:login-window).
       */
      openTrackerLogin?: (opts: {
        url: string;
        proxyRules?: string | null;
        /** UA окна: пусто — приложение берёт обычный Chrome своей версии. */
        userAgent?: string;
      }) => Promise<{
        ok: boolean;
        error?: string;
        reason?: string;
        loggedIn?: boolean;
        /** Окно прошло проверку Cloudflare (в куках есть cf_clearance). */
        hasCf?: boolean;
        names?: string[];
        cookieHeader?: string;
        userAgent?: string;
      }>;
      /** Прокси Chromium: применить rules или снять (null). */
      applyProxySession?: (cfg: { proxyRules: string } | null) => Promise<{ ok: boolean }>;
    };
  }
}

/* ------------------------------- Апскейл медиа ------------------------------- */
/*
 * Страница «Апскейл медиа» работает на встроенном ONNX-рантайме
 * (server/ts/upscale.ts → server/upscale.js). Типы ниже — контракт с
 * POST/GET /api/upscale: их поля совпадают с серверным UpJob/UpParams.
 */

/** Модель ONNX из server/models.manifest.json + статус загрузки файла. */
export interface UpModelInfo {
  id: string;
  label: string;
  /** upscale — апскейлер, interp — интерполятор кадров: списки в UI не смешиваются. */
  kind: "upscale" | "interp";
  scale: number;
  /** У интерполятора — во сколько раз больше кадров даёт пара. */
  mult: number;
  /** Максимум множителя плавности: у CAIN 2, у RIFE/IFRNet — до 4. */
  multMax: number;
  arch: string;
  /** Схема входов интерполятора (у апскейлеров пусто). */
  inputSig: string;
  /**
   * Сколько кадров модель принимает за один run (факт из каталога): 1 — жёстко
   * один кадр за проход (пачка невозможна, настройка пачки в UI скрывается),
   * 0 — неизвестно (движок пробует сам), больше 1 — верхний предел пачки.
   * У интерполятора — сколько тайлов пары считается за один run.
   */
  batch: number;
  /** Кратность сторон входа (1 — требования нет): движок выравнивает тайл (Real-CUGAN). */
  align: number;
  /** Рекомендованный провайдер модели ("" — как в настройках; "cpu" — не идёт на GPU). */
  provider: string;
  /**
   * Собранный движок TensorRT этой модели («512/…engine», пусто — не собран):
   * имя файла движка — хеш графа, поэтому связь держит реестр на сервере.
   */
  trtEngine: string;
  file: string;
  sizeMb: number;
  license: string;
  url: string;
  /** Путь на диске (storage/models/upscale/<file>). */
  path: string;
  available: boolean;
  /** Файл ONNX лежит на диске (false у «тензорных»: ONNX убран, движок на месте). */
  onnxOnDisk: boolean;
  /** Категории для фильтра в панели моделей (photo/video/anime/fast/…). */
  tags: string[];
  /** Оптимальные настройки именно этой модели («Применить» в панели). */
  rec: {
    scale?: number;
    tile?: number;
    overlap?: number;
    sharpen?: number;
    denoise?: number;
    interpMult?: number;
    sceneCut?: number;
  };
  /** Измерено на реальном инференсе (мс, множитель) — для подсказки. */
  measured: string;
  /** sha256 из манифеста (пусто — хеш не задан, проверки при загрузке нет). */
  sha256: string;
  /** Что это за модель и для чего (короткое описание из манифеста). */
  hint: string;
  /** Прогресс текущей загрузки модели (null — не качается). */
  downloading: { gotMb: number; totalMb: number; percent: number } | null;
}

/** Параметры задания апскейла (зеркало серверного normalizeParams). */
export interface UpParams {
  model: string;
  /** Вторая модель для смешивания результатов (пусто = выключено). */
  model2: string;
  blendAmount: number;
  scale: number;
  targetW: number;
  targetH: number;
  tile: number;
  overlap: number;
  threads: number;
  provider: string;
  format: string;
  quality: number;
  sharpen: number;
  denoise: number;
  vcodec: string;
  vcrf: number;
  audioAction: string;
  presetId: string;
  /** off | ffmpeg (minterpolate) | model (ONNX RIFE/CAIN). */
  interpMode: string;
  /** id ONNX-интерполятора (kind="interp"); пусто — первый скачанный. */
  interpModel: string;
  /** Во сколько раз больше кадров: 2 | 3 | 4. */
  interpMult: number;
  /** mci (движение) | blend (смешивание) | dup (дубли). */
  minterpolateMode: string;
  /**
   * Где считать вставки: decode — до апскейла (интерполятор по исходным кадрам,
   * апскейлер получает в 2–4 раза больше кадров), encode — после апскейла.
   * У minterpolate это сторона фильтра, у ONNX-модели — сторона движка.
   */
  minterpolateSide: string;
  /** Порог смены сцены 0–100: выше — дубли вместо интерполяции. */
  sceneCutThreshold: number;
  /** Кадров за один вызов session.run (1 | 2 | 4). */
  batchFrames: number;
  /**
   * Пачка ТАЙЛОВ интерполятора (вторая настройка пачки): сколько тайлов пары
   * считать одним session.run (0 — «Авто»). 0/1 — по тайлу за раз.
   */
  interpBatch: number;
  /** Обработать только первые N кадров видео (0 — весь файл). */
  frameLimit: number;
  /** Замедление результата: 1 — как есть, 0.5 — вдвое, 0.25 — вчетверо медленнее. */
  slowMotion: number;
  /**
   * Считать кодирование и декодирование на видеокарте, если она есть
   * (NVENC/QSV/AMF + аппаратный декодер). Выключено — всё делает CPU.
   */
  hwAccel: boolean;
}

/** Задание апскейла: UI опрашивает его состояние. */
export interface UpJob extends UpParams {
  id: string;
  kind: "photo" | "video";
  createdAt: number;
  startedAt: number;
  name: string;
  size: number;
  stage: "queued" | "analyze" | "upscale" | "encode" | "done" | "error" | "stopped";
  progress: number;
  etaSec: number | null;
  done: boolean;
  error: string;
  outSize: number;
  outWidth: number;
  outHeight: number;
  /** Расширение результата (png/jpg/webp/avif | mp4/mkv) — для имени файла. */
  outExt: string;
  engineUsed: string;
  providerUsed: string;
  /** Кодировщик результата: «NVENC» / «SVT-AV1» / «x264» (что реально сработало). */
  encoderUsed: string;
  /** Пачка кадров, с которой считали (для «Авто» — фактически подобранная). */
  batchUsed: number;
  /**
   * Пачка ТАЙЛОВ интерполятора, с которой считали (0 — интерполяция выключена или
   * модель принимает только один тайл за run).
   */
  interpBatchUsed: number;
  /**
   * Почему пачка не используется, если она выключена: "" — используется или не
   * запрашивалась, "unsupported" — граф принимает один кадр, "mixed" — смешивание
   * двух моделей, "nomodel" — без апскейла.
   */
  batchReason?: string;
  /** Задание на паузе: кадры и процессы живут, обработка стоит. */
  paused?: boolean;
  framesDone: number;
  framesTotal: number;
  fps: number;
  /** Частота кадров результата: бейдж «25 → 50 fps». */
  fpsOut: number;
  info: {
    width?: number;
    height?: number;
    codec?: string;
    fps?: number;
    duration?: number;
  };
}

/** Пресет апскейла: системный (id) или пользовательский (name + поля). */
export interface UpPreset {
  id?: string;
  name?: string;
  kind?: "photo" | "video";
  model: string;
  scale: number;
  format?: string;
  quality?: number;
  tile?: number;
  overlap?: number;
  sharpen?: number;
  denoise?: number;
  provider?: string;
  targetW?: number;
  targetH?: number;
  vcodec?: string;
  vcrf?: number;
  audioAction?: string;
  /** Пресеты плавности (см. UpParams.interp*). */
  interpMode?: string;
  interpModel?: string;
  interpMult?: number;
  minterpolateMode?: string;
  minterpolateSide?: string;
  sceneCutThreshold?: number;
  batchFrames?: number;
  interpBatch?: number;
  frameLimit?: number;
  slowMotion?: number;
}

/** Состояние рантайма и железа для страницы апскейла. */
export interface UpHardware {
  runtime: boolean;
  /** Детали рантайма: версия, путь и причина отказа — для диагностики. */
  runtimeInfo?: UpRuntimeInfo;
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  cpu: { name: string; coresPhysical: number; coresLogical: number };
  /**
   * План аппаратного ускорения: какой декодер и кодировщики реально доступны
   * сборке ffmpeg («NVENC», «QSV», «x264»…). Пусто — считаем на CPU.
   */
  gpu?: { decode: string; x264: string; x265: string; av1: string; hardware: boolean };
  models: UpModelInfo[];
  /** Провайдеры ONNX Runtime в этой сборке (cpu/dml/cuda/tensorrt/webgpu). */
  providers?: string[];
  /** TensorRT: есть ли провайдер и что уже собрано (движки в кэше). */
  trt?: UpTrtStatus;
  /** GPU-пакет (CUDA/TensorRT): установлен ли и что в нём собрано. */
  pack?: UpPackStatus;
}

/** Состояние TensorRT: провайдер в сборке + собранные движки (.engine). */
export interface UpTrtStatus {
  available: boolean;
  /** Что вообще есть в рантайме — для подсказки «почему кнопка недоступна». */
  backends: string[];
  dir: string;
  engines: { file: string; sizeMb: number; mtime: number }[];
}

/**
 * Что вернула сборка движка: без этого ответа кнопка «Собрать движок» выглядела
 * как «ничего не произошло» — повторный клик мгновенно грузит готовый движок из
 * кэша, а счётчик файлов не меняется.
 */
export interface UpTrtBuild {
  ok: boolean;
  /** Сколько заняла операция (мс). */
  ms: number;
  /** Размер входа, под который собран движок (он же — размер тайла). */
  profile: number;
  /** Новые файлы движка: пусто — движок уже был в кэше. */
  engines: { file: string; sizeMb: number }[];
  /** Движок взят из кэша, а не собран сейчас. */
  reused: boolean;
  /** Файл движка этой модели («512/…engine»). */
  engine: string;
  engineMb: number;
  /** Сколько движков собрано всего. */
  total: number;
  /** Сколько МБ освободило удаление ONNX (0 — файл оставлен или уже удалён). */
  onnxFreedMb: number;
}

/**
 * Замер скорости модели: считается на этой машине (видеокарта, драйвер, движок
 * TensorRT у каждого свои), поэтому цифры хранятся локально и не приходят из
 * каталога. Экран замеров — окно каталога моделей.
 */
export interface UpBenchEntry {
  model: string;
  /** Провайдер, на котором реально считалось (cuda/tensorrt/dml/cpu). */
  provider: string;
  /** Тайл замера: один тайл — один вход графа. */
  tile: number;
  /** Пачка кадров замера: замер времени всегда идёт одиночными кадрами (= 1). */
  batch: number;
  /**
   * Сколько кадров модель принимает за один проход — проверено на этой машине:
   * 1 — только по одному кадру, 0 — не проверяли, больше 1 — предел пачки.
   */
  batchMax: number;
  /** Лучшее время одного тайла, мс. */
  ms: number;
  /** Оценка полного кадра 848×480 (все тайлы), мс. */
  frameMs: number;
  /** Кадров эталонного размера в секунду. */
  fps: number;
  /** Тайлов в эталонном кадре. */
  tiles: number;
  /** Сколько прогонов измерили (без прогрева). */
  runs: number;
  /** Движок TensorRT, если считалось на нём. */
  engine: string;
  /** Когда замер сделан (мс). */
  when: number;
}

/** Ответ GET/POST /api/upscale/bench: модель → список замеров. */
export interface UpBenchState {
  results: Record<string, UpBenchEntry[]>;
  /** Эталонный кадр замера (848×480) — по нему считается fps. */
  frame?: { w: number; h: number };
  runs?: number;
}

export interface UpBenchSingle extends UpBenchState {
  entry: UpBenchEntry;
}

/**
 * Что нужно панели настроек от железа: план кодировщиков ffmpeg плюс
 * провайдеры ONNX Runtime и состояние TensorRT (кнопка точности).
 */
export type UpGpuInfo = NonNullable<UpHardware["gpu"]> & {
  providers?: string[];
  trt?: UpTrtStatus;
  pack?: UpPackStatus;
};

/**
 * GPU-пакет: своя сборка ONNX-рантайма с провайдерами CUDA/TensorRT (качается
 * отдельно, кладётся в storage). Без него работает обычный путь DirectML/CPU.
 */
export interface UpPackStatus {
  installed: boolean;
  /** Куда ставится пак: storage/ort-gpu/<платформа-архитектура>. */
  dir: string;
  /** Путь к своему биндингу (пусто, если пака нет). */
  binding: string;
  /** Что собрано: например «cuda+tensorrt». */
  provider: string;
  /** Версия ONNX Runtime в паке. */
  version: string;
}

/** Ступень пака из индекса: что именно качается. */
export interface UpPackStep {
  id: string;
  /** Подпись кнопки: «CUDA», «TensorRT». */
  title: string;
  file: string;
  mb: number;
  url: string;
  sha256?: string;
}

/** Индекс паков из репозитория MoonApp-Ort-GPU (или своего зеркала). */
export interface UpPackIndex {
  version: string;
  ort: string;
  cuda: string;
  tensorrt?: string;
  /** Что нужно от железа: показываем до скачивания. */
  requires?: string;
  steps: UpPackStep[];
}

/** Прогресс одной ступени (для полосы загрузки в настройках). */
export interface UpPackProgress {
  step: string;
  /** download | unpack | done | error. */
  state: string;
  percent: number;
  gotMb: number;
  totalMb: number;
  error: string;
}

/** Ответ GET /api/upscale/gpu-pack: установленное, прогресс и индекс. */
export interface UpPackState extends UpPackStatus {
  /** Сколько места занимает установленный пак (МБ). */
  mb: number;
  /** Какая ступень ставится прямо сейчас (пусто — ничего). */
  busy: string;
  states: Record<string, UpPackProgress>;
  /** Провайдеры рантайма, в котором мы работаем сейчас. */
  backends: string[];
  /** Пак поставлен, но заработает только после перезапуска приложения. */
  restart: boolean;
  index: UpPackIndex | null;
  error: string;
}

/** Состояние ONNX-рантайма: где найден и почему не найден. */
export interface UpRuntimeInfo {
  available: boolean;
  version: string;
  path: string;
  error: string;
  /** Непусто — подключён свой биндинг из GPU-пака (CUDA/TensorRT), а не npm-модуль. */
  pack?: string;
}

/** Ответ GET /api/upscale/models. */
/** Апскейл: состояние каталога моделей (GET /api/upscale/models). */
export interface UpModelsState {
  runtime: boolean;
  dir: string;
  models: UpModelInfo[];
  /** Состояние загрузок по id: working/done/error (для полосы прогресса). */
  downloads?: Record<string, { state: string; error: string }>;
  /** Откуда взят каталог и когда обновлялся (для строки статуса в панели). */
  manifest?: UpManifestInfo;
  /** TensorRT: доступность провайдера и собранные движки. */
  trt?: UpTrtStatus;
}

/**
 * Источник каталога моделей: `remote` — манифест скачан кнопкой «Обновить
 * каталог» (лежит в storage), `bundled` — вшитый в сборку (первый запуск/офлайн).
 */
export interface UpManifestInfo {
  source: "remote" | "bundled";
  path: string;
  /** Основной адрес обновления (GitHub или свой из MOONAPP_MANIFEST_URL). */
  url: string;
  count: number;
  /** Когда каталог скачивали (ISO) или "" для вшитого. */
  updatedAt: string;
}

/** Результат POST /api/upscale/models/sync — что изменилось после обновления. */
export interface UpManifestSync {
  ok: boolean;
  url: string;
  count: number;
  added: string[];
  removed: string[];
  changed: string[];
  updatedAt: string;
  manifest: UpManifestInfo;
}

/** Ответ POST /api/upscale/probe (тип медиа определяется по расширению). */
export interface UpProbe {
  kind: "photo" | "video";
  width: number;
  height: number;
  fps: number;
  /** Точная частота дробью (если ffprobe её дал) — для оценки и интерполяции. */
  fpsNum?: number;
  fpsDen?: number;
  duration: number;
  hasAudio: boolean;
  hasSubs: boolean;
  codec: string;
  size: number;
}

/** Ответ POST /api/upscale/estimate: что получится и сколько это займёт. */
export interface UpEstimate {
  kind: "photo" | "video";
  outWidth: number;
  outHeight: number;
  /** Кадров исходника (с учётом лимита) и кадров результата. */
  inFrames: number;
  outFrames: number;
  fpsOut: number;
  durationSec: number;
  slowMotion: number;
  totalMegapixels: number;
  /** Ожидаемое время в секундах; null — на этой машине ещё не считали заданий. */
  etaSec: number | null;
  /** Предупреждения (ключи i18n up.est_*): нет модели/рантайма, слишком долго и т.п. */
  warnings: string[];
}

/** Ответ GET /api/upscale/presets. */
export interface UpPresets {
  system: UpPreset[];
  custom: UpPreset[];
  defaults: Record<string, unknown>;
}

/* ------------------- Диспетчер фоновых задач (server/ts/taskRegistry.ts) ------------------- */

/** Задача любого движка (компрессия/апскейл/озвучка/лекции/архив) в едином виде. */
export interface TmTask {
  id: string;
  engine: string;
  label: string;
  stage: string;
  /** 0..100, либо -1, если прогресс неизвестен (напр. живая запись лекции). */
  progress: number;
  createdAt: number;
  done: boolean;
  error?: string | null;
  canCancel: boolean;
  canPause: boolean;
  paused: boolean;
}
