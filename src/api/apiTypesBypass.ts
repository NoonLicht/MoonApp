/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */

/* ================= Zapret / DPI Bypass ================= */

export interface ZapretEngine {
  found: boolean;
  dir: string | null;
  installDir: string;
  winws: string | null;
  binDir: string | null;
  serviceBat: string | null;
  listsDir: string | null;
  version: string | null;
  gameFilter: "all" | "tcp" | "udp" | "off";
}
export interface ZapretStrategy {
  id: string;
  name: string;
  label: string;
  group: "base" | "alt" | "fake-tls-auto" | "simple-fake" | "exp";
  file: string;
  filePath: string;
  args: string;
  winwsCmd: string;
  index: number;
}
export interface ZapretBatFile {
  name: string;
  file: string;
  sizeKb: number;
  kind: "strategy" | "service";
  args: string;
}
export interface ZapretUpdate {
  engine: ZapretEngine;
  installed: string | null;
  installedAt: string | null;
  latest: string | null;
  hasUpdate: boolean;
  downloadUrl: string | null;
  assetName: string | null;
  sizeBytes: number;
  publishedAt: string | null;
  htmlUrl: string;
  notes: string;
  error: string;
  repo: string;
}
export interface ZapretInstallState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
  tag: string | null;
  at: number;
  engine: ZapretEngine;
  installed: string | null;
}
/**
 * TG WS Proxy — локальный MTProto-прокси для Telegram Desktop
 * (Flowseal/tg-ws-proxy). Состояние блока на странице Bypass.
 */
export interface TgwsStatus {
  /** Бинарь найден (скачан в storage/tgwsproxy или вшит в сборку). */
  installed: boolean;
  exePath: string;
  /** Версия скачанного релиза (пусто для вшитого бинаря). */
  version: string;
  running: boolean;
  pid: number;
  /** Процесс поднимается: PyInstaller распаковывается, порт ещё закрыт. */
  starting: boolean;
  host: string;
  port: number;
  /** Секрет прокси (32 hex без префикса dd) — вводят в Telegram Desktop. */
  secret: string;
  /** Ссылка tg://proxy… для авто-настройки Telegram. */
  link: string;
  /** Порт занят чужим процессом (или прежним запуском) — старт невозможен. */
  portBusy: boolean;
  uptimeMs: number;
  /** Поднимать прокси при старте приложения (переключатель в блоке). */
  autoStart: boolean;
  downloading: boolean;
  /** Прогресс скачивания движка, 0..100. */
  progress: number;
  /** Код последней ошибки (tgws_port_busy и т.п.) — UI переводит его сам. */
  error: string;
  log: string[];
}

/** Что можно менять в блоке (POST /tgws/settings и /tgws/start). */
export interface TgwsSettingsPatch {
  exePath?: string;
  host?: string;
  port?: number;
  /** Пусто — сбросить: новый секрет сгенерируется при запуске. */
  secret?: string;
  autoStart?: boolean;
}

export interface ZapretStatus {
  active: boolean;
  process: { running: boolean; pid: number | null; memKb: number | null };
  service: { installed: boolean; running: boolean; raw: string; strategyFile?: string };
  mode: string;
  profile: { strategyId: string; customArgs: string; mode: string } | null;
  log: string[];
  engine: ZapretEngine;
  strategy: string | null;
  version: string | null;
  gameFilter: string;
}
export interface ZapretTargetResult {
  id: string;
  name: string;
  kind: "http" | "udp";
  url?: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  packetDrop: boolean;
}
export interface ZapretDiagnostics {
  allOk: boolean;
  okCount: number;
  total: number;
  avgLatency: number;
  results: ZapretTargetResult[];
  at: number;
}
export interface ZapretAutoTuneResult {
  tried: {
    strategyId: string;
    allOk: boolean;
    okCount?: number;
    total?: number;
    avgLatency?: number;
    score?: number;
    error?: string;
  }[];
  best: string | null;
  applied: string | null;
}
export interface ZapretProfile {
  id: number;
  name: string;
  batch_file_path: string;
  custom_args: string;
  is_active: number;
  is_service: number;
  created_at: string;
}
export interface ZapretDomain {
  id: number;
  domain: string;
  type: "include" | "exclude";
  is_enabled: number;
}
export interface ZapretPayload {
  name: string;
  path: string;
  sizeKb: number;
}
export interface ZapretList {
  name: string;
  content: string;
}

/* --- Проверка конфигов (service.bat → utils/test zapret.ps1) --- */

export interface ZapretCheckResult {
  strategyId: string;
  file: string;
  okCount: number;
  error: number;
  unsup: number;
  pingOk: number;
  pingFail: number;
  finished: boolean;
  failedToStart: boolean;
}
export interface ZapretCheckLight {
  strategy_id: string;
  file: string;
  ok: number;
  ok_count: number;
  error: number;
  unsup: number;
  ping_ok: number;
  ping_fail: number;
  checked_at: string;
  run_started_at: string;
}
export interface ZapretCheckState {
  state: "idle" | "working" | "done" | "error";
  mode: "check" | "diag" | "lists" | null;
  label: string;
  running: boolean;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  error: string;
  best: string | null;
  bestId: string | null;
  progress: { done: number; total: number; current: string | null };
  results: ZapretCheckResult[];
  log: string[];
  logCursor: number;
  lights: Record<string, ZapretCheckLight>;
}
