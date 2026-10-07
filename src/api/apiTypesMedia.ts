/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
// тот же origin: фронт и API вместе (Vite-proxy или раздача Express)

/* --- Типы новых модулей: Compressor / TTS / Sitebak --- */
export interface CompressorJob {
  id: string;
  name: string;
  size: number;
  stage: "queued" | "analyze" | "encode" | "done" | "error";
  progress: number;
  etaSec: number | null;
  steps: string[];
  error: string;
  done: boolean;
  outSize: number;
  codec: string;
  engine: string;
  engineUsed?: string;
  qualityMode: string;
  crf: number;
  targetKbps: number;
  maxKbps: number;
  speed: string;
  tenBit: boolean;
  targetHeight: string;
  audio: string;
  audioKbps: number;
  fallbacks?: string[];
  command?: string;
  durationSec?: number;
  info?: { width?: number; height?: number; codec?: string; fps?: string; bitRate?: number };
}
export interface CompressorHardware {
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  cpu: { name: string; coresPhysical: number; coresLogical: number };
  gpus: { vendor: string; name: string; tier: string }[];
  methods: Record<string, boolean>;
  recommended: {
    engine: string;
    codec: string;
    qualityMode: string;
    crf: number;
    speed: string;
    hwName: string;
    reason: string;
  };
  optimal: Record<string, any>;
  speedScales: Record<string, string[]>;
}
export interface CompressorPreset {
  id?: string;
  name?: string;
  createdAt?: number;
  params: Record<string, unknown>;
  targetMB?: number;
}
export interface TtsProfile {
  id: string;
  name: string;
  refFile?: string;
  engine?: "f5" | "xtts" | "llama";
  createdAt: number;
}
export interface TtsPreset {
  id: string;
  name: string;
  builtin?: boolean;
  engine: "f5" | "xtts" | "llama";
  params: Record<string, unknown>;
  refFile?: string;
  createdAt?: number;
}
export interface TtsHardware {
  gpu: {
    found: boolean;
    name: string;
    vramTotalGb: number;
    vramUsedGb: number;
    utilPct: number;
    driver: string;
  };
  cpu: { name: string; cores: number };
  platform: string;
  optimal: Record<string, unknown> & {
    precision?: string;
    nfe?: string;
    cfg?: string;
    vram?: number;
  };
}
export interface TtsChunk {
  text?: string;
  pauseMs?: number;
}
export interface TtsBookChapter {
  title: string;
  text: string;
}
export interface TtsBook {
  title: string;
  author: string;
  coverImage: string | null;
  chapters: TtsBookChapter[];
  format?: string;
  encoding?: string;
}
export interface TtsJob {
  id: string;
  engine: string;
  stage: string;
  progress: number;
  chunkIndex: number;
  chunksTotal: number;
  error: string;
  done: boolean;
  outSize: number;
  outFile?: string;
  vram?: { usedGb: number; totalGb: number; utilPct: number } | null;
  opts?: { format?: string; title?: string; author?: string };
  /**
   * Диагностика Python-окружения (когда рендер упал из-за отсутствующих
   * модулей/интерпретатора): код, путь к python и список ненайденных модулей.
   * По ней страница показывает понятный текст вместо «No module named 'torch'».
   */
  envError?: TtsEnvError;
  chunksPreview?: TtsChunk[];
}
/** Диагностика Python-окружения движка (см. server/ts/tts.ts → TtsEnvError). */
export interface TtsEnvError {
  code: string;
  cmd: string;
  detail: string;
  python: string;
  executable: string;
  missing: string[];
  installHint: string;
}
/** Состояние Python-окружения: GET /api/tts/env (см. server/ts/tts.ts). */
export interface TtsPythonEnv {
  ok: boolean;
  error: string;
  detail: string;
  cmd: string;
  python: string;
  executable: string;
  modules: Record<string, boolean>;
  missingF5: string[];
  missingXtts: string[];
  installF5: string;
  installXtts: string;
  checkedAt: number;
  cached: boolean;
  /** Прогресс фоновой установки окружения (см. server/ts/pyEnv.ts). */
  install?: PyInstallSnapshot;
}
/** Состояние задачи установки (общее с моделями распознавания: server/setupTask). */
export interface PyInstallTask {
  kind: string | null;
  state: "idle" | "working" | "done" | "error";
  id: string | null;
  progress: number;
  phase: string;
  error: string;
  received: number;
  total: number;
}
/** Снимок установки Python-окружения: шаги, текущий шаг и хвост вывода pip. */
export interface PyInstallSnapshot {
  state: PyInstallTask;
  /** Что делает задача: установка пакетов, удаление сборки torch или Python. */
  mode: "install" | "uninstall" | "python";
  engine: string;
  device: string;
  python: string;
  steps: string[];
  step: string;
  log: string[];
}
/**
 * План установки для одной сборки torch: cuda (индекс cu128) или cpu —
 * см. server/ts/pyEnv.ts.
 */
export interface PyPlan {
  device: string;
  approxMb: number;
  command: string;
  steps: string[];
}
/** Портативный Python 3.11 внутри storage (кнопки «Скачать»/«Удалить»). */
export interface PyPortable {
  installed: boolean;
  exe: string;
  version: string;
  /** Занято на диске вместе с поставленными пакетами (для подписи «Удалить»). */
  sizeMb: number;
  /** Объём архива, который надо скачать. */
  zipMb: number;
}
/** Ответ POST /api/tts/env/python/remove: сколько места освободили. */
export interface PyRemoved {
  ok: boolean;
  freedMb: number;
}
/** Ответ GET /api/tts/env/install: что будем качать и куда ставить. */
export interface PyInstallState {
  /** Рекомендуемая сборка по железу: cuda (есть карта NVIDIA) | cpu. */
  recommended: string;
  gpuName: string;
  chosen: string;
  /** Планы по обеим сборкам (ключи: cuda, cpu). */
  plans: Record<string, PyPlan>;
  /** Что с портативным Python 3.11. */
  portable: PyPortable;
  /** Версия текущего интерпретатора (по ней выбран пакет XTTS в командах). */
  pythonVersion: string;
  install: PyInstallSnapshot;
}
/** Найденный интерпретатор Python и наличие в нём нужных модулей. */
export interface PyInterpreter {
  cmd: string;
  args: string[];
  label: string;
  ok: boolean;
  error: string;
  detail: string;
  python: string;
  executable: string;
  modules: Record<string, boolean>;
  missingF5: string[];
  missingXtts: string[];
}
export interface SitebakJob {
  id: string;
  url: string;
  name: string;
  stage: string;
  progress: number;
  pages: number;
  origSize: number;
  bakSize: number;
  error: string;
  done: boolean;
  stats?: {
    pages: number;
    origSize: number;
    bakSize: number;
    savedPct: number;
    compression?: { textAlgo: string; ratio: number };
    rendered?: boolean;
  };
}
export interface SitebakArchive {
  id: string;
  name: string;
  site: string;
  createdAt: number;
  stats?: SitebakJob["stats"];
}
/** Страница внутри архива .sitebak (для встроенного просмотра). */
export interface ArchivePage {
  /** Путь внутри архива (hash.html) — по нему отдаётся сама страница. */
  path: string;
  /** <title> страницы (или имя файла, если заголовка нет). */
  title: string;
  /** Исходный адрес (canonical/og:url), если сохранился. */
  url: string;
  /** Размер распакованного HTML в байтах. */
  size: number;
}
/** Ответ GET /api/archive/:id/pages — список страниц архива. */
export interface ArchivePagesResult {
  id: string;
  site: string;
  name: string;
  total: number;
  pages: ArchivePage[];
}
