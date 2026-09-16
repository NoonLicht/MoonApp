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

/** Статус страницы: есть ли ключ TMDB и движок торрентов. */
export interface MediaStatus {
  hasKey: boolean;
  engine: { installed: boolean; client?: boolean; error?: string };
  settings: { language?: string; region?: string; showAdult?: boolean; cacheMinutes?: number };
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
    };
  }
}
