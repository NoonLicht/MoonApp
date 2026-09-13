/* -------------------------------- Флибуста / Книги ----------------------- */

/** Книга из OPDS-фида Флибусты. */
export interface FlibustaBook {
  id: string;            // "tag:book:..."
  bid: number;           // числовой id для скачивания
  title: string;
  author: string;
  genres: string[];
  language: string | null;
  year: number | null;
  formats: string[];     // ["fb2","epub","mobi","pdf",...]
  sizeText: string;      // "3074 Kb" и т.п.
  cover: string | null;  // url к обложке
  description: string;
  updatedAt: string;
  fav?: boolean;         // в избранном
  bm?: boolean;          // в закладках
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
  estimatedTime: number;       // minutes
  actualTime: number;          // minutes (tracked)
  recurrence: TaskRecurrence;
  dueDate: string | null;      // ISO date
  reminderDateTime: string | null; // ISO datetime
  checklist: TaskChecklistItem[];
  attachments: TaskAttachment[];
  urls: string[];
  tags: string[];
  projectId: string;
  folder: string;
  location: string;
  dependencies: string[];      // taskId[] - blocked by
  backlinks: string[];         // [[Note]] or @Task references
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

/* ------------------------------ Store / каталог ---------------------------- */

export interface AppItem {
  key: string;                 // "winget:<id>" | "catalog:<id>"
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
  wmi: boolean;            // пространство root/LibreHardwareMonitor отвечает
  exePath: string | null;  // найденный путь к LibreHardwareMonitor.exe
  pid: number | null;      // запущен ли нами (PID процесса)
  bundled: boolean;        // скачан ли headless-движок (LibreHardwareMonitorLib)
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
  progress: number;   // 0..100 (скачивание)
  phase: string;      // "download" | "extract" | ""
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

export interface TempSensor { id: string; name: string; hw: string; value: number | null }
export interface FanSensor { name: string; hw: string; rpm: number | null }
export interface ValueSensor { name: string; hw: string; value: number | null }

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
  sensorsAll: { id: string; name: string; type: string; parent: string; hw: string; value: number | null }[];
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
      // Обновления приложения (работают только в packaged-сборке).
      checkUpdates?: () => Promise<{ ok: boolean; available?: boolean; version?: string | null; reason?: string }>;
      toggleAutoUpdate?: () => Promise<{ ok: boolean; enabled?: boolean; reason?: string }>;
      downloadUpdate?: () => Promise<{ ok: boolean; available?: boolean; version?: string | null; downloading?: boolean; reason?: string }>;
    };
  }
}
