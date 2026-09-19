/**
 * Торрент-движок для страницы «Фильмы и Сериалы».
 *
 * Назначение: воспроизведение/скачивание торрента, который пользователь открыл
 * САМ (вставил magnet-ссылку или загрузил .torrent-файл). Это dual-use
 * инструмент общего назначения — как любой BitTorrent-клиент. Приложение НЕ
 * ищет и НЕ подбирает торренты и не парсит трекеры: источник задаёт пользователь
 * и сам отвечает за то, что контент был легальным (публичное достояние,
 * собственные файлы, Linux-дистрибутивы и т.п.).
 *
 * Как работает стриминг:
 *  - WebTorrent качает куски в storage/torrents (последовательный приоритет по
 *    запрашиваемому диапазону);
 *  - HTTP-роут /api/movies/torrent/stream поддерживает Range-запросы и отдаёт
 *    поток из файла — HTML5 <video> умеет проигрывать прямо из него.
 *
 * Движок подключается «лениво» (require) — если пакет webtorrent отсутствует,
 * роуты возвращают понятный код engine_missing, а не падают.
 *
 * TS-исходник, как server/ts/download.ts: компилируется в server/torrent.js
 * командой `npm run compile:server`. Типы webtorrent описаны минимальным
 * структурным контрактом ниже — своей сборки типов у пакета нет.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import { stmts } from "./db";

const { DIRS } = config;

/** Файл внутри торрента (структурный срез webtorrent). */
export interface TorrentFile {
  name: string;
  path: string;
  length: number;
  progress?: number;
  _startPiece?: number;
  _endPiece?: number;
  createReadStream(opts: { start?: number; end?: number }): NodeJS.ReadableStream;
}

/** Торрент (структурный срез webtorrent). */
export interface TorrentLike {
  infoHash: string;
  name?: string;
  ready?: boolean;
  done?: boolean;
  progress?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  downloaded?: number;
  uploaded?: number;
  length?: number;
  numPeers?: number;
  timeRemaining?: number;
  ratio?: number;
  /** Стратегия выбора кусков: "sequential" — качать по порядку (нужно стриму). */
  strategy?: string;
  files: TorrentFile[];
  pieces?: unknown[];
  on(event: string, cb: (...args: never[]) => void): unknown;
  removeListener(event: string, cb: (...args: never[]) => void): unknown;
  deselect(start: number, end: number, priority: number | boolean): void;
  select(start: number, end: number, priority: number): void;
}

/** Клиент webtorrent (структурный срез). */
export interface TorrentClient {
  torrents: TorrentLike[];
  add(source: unknown, opts?: { path?: string }): TorrentLike;
  get(id: unknown): TorrentLike | undefined;
  remove(id: string, opts?: { destroyStore?: boolean }): void;
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}

type WebTorrentCtor = new (opts: { maxConns: number; torrentPort: number }) => TorrentClient;

let WebTorrent: WebTorrentCtor | null = null;
let client: TorrentClient | null = null;

/** Коды MIME для стриминга (нужны <video>). Без внешних зависимостей. */
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
};

/** MIME по расширению (неизвестное → application/octet-stream). */
export function mimeOf(name: unknown): string {
  return MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

/** Ошибка с кодом — роуты разбирают её и отдают понятный ответ фронту. */
export interface TorrentError extends Error {
  code: string;
}

/** Информация об ошибке с кодом (для роутов). */
function torrentError(code: string, message?: string): TorrentError {
  const e = new Error(message || code) as TorrentError;
  e.code = code;
  return e;
}

/** Ленивая загрузка webtorrent (CommonJS-версия 1.x — совместима с Electron/Node). */
function engine(): WebTorrentCtor {
  if (WebTorrent) return WebTorrent;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    WebTorrent = require("webtorrent") as WebTorrentCtor;
  } catch (e) {
    throw torrentError(
      "engine_missing",
      `WebTorrent engine is not installed: ${(e as Error).message}`,
    );
  }
  return WebTorrent;
}

/** Единственный клиент на процесс. */
function getClient(): TorrentClient {
  if (client) return client;
  const WT = engine();
  client = new WT({ maxConns: 55, torrentPort: 0 });
  client.on("error", (e) =>
    logger.warn("torrent.client_error", {
      error: (e as Error)?.message || String(e),
    }),
  );
  return client;
}

/** Файл торрента для фронта: размер, MIME и признак «это можно проиграть». */
export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
  mime: string;
  progress: number;
  playable: boolean;
}

/** Краткое описание файла торрента для фронта. */
function fileInfo(file: TorrentFile, index: number): TorrentFileInfo {
  return {
    index,
    name: file.name,
    path: file.path,
    length: file.length,
    mime: mimeOf(file.name),
    progress: Number(file.progress) || 0,
    // Играбельные «медиа»-файлы (по расширению/размеру).
    playable:
      /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg|ogv|mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(
        file.name,
      ),
  };
}

/** Дождаться метаданных (список файлов) у торрента. */
function waitForMetadata(torrent: TorrentLike, timeoutMs = 60000): Promise<void> {
  if (torrent.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        torrentError(
          "metadata_timeout",
          `torrent metadata is not ready after ${timeoutMs} ms ` +
            "(нет пиров/DHT недоступен или magnet без метаданных)",
        ),
      );
    }, timeoutMs);
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (e: unknown): void => {
      cleanup();
      reject(torrentError("torrent_error", (e as Error)?.message || String(e)));
    };
    function cleanup(): void {
      clearTimeout(timer);
      torrent.removeListener("ready", onReady);
      torrent.removeListener("error", onError);
    }
    torrent.on("ready", onReady);
    torrent.on("error", onError);
  });
}

/** Итог добавления торрента: метаданные и список файлов. */
export interface TorrentAdded {
  infoHash: string;
  name: string;
  length: number;
  files: TorrentFileInfo[];
}

/** Откуда добавлена раздача: влияет на способ возобновления после остановки. */
export type TorrentSourceKind = "magnet" | "tracker" | "file";

/** Что известно о раздаче в момент добавления (идёт в реестр «Скачанные»). */
export interface AddOptions {
  /** Название фильма/сериала: по нему окно плеера восстанавливается. */
  title?: string;
  /** id раздачи на трекере (нужен, чтобы снова достать .torrent). */
  releaseId?: string;
  /** magnet-ссылка, если добавляем по ней (тогда .torrent не нужен). */
  magnet?: string;
  /** Галочка «хранить файлы после просмотра»; по умолчанию — из настроек. */
  kept?: boolean;
}

/** Уже навешенные обработчики «готово»: по одному на раздачу, без дублей. */
const doneHooked = new Set<string>();

/**
 * Общая часть add()/getTorrentFileList(): запомнить раздачу в реестре, положить
 * .torrent-метафайл (по нему загрузка возобновляется) и отметить завершение.
 */
function registerDownload(
  torrent: TorrentLike,
  source: unknown,
  opts: AddOptions,
  info: { name: string; length: number },
): void {
  const hash = String(torrent.infoHash || "").toLowerCase();
  const isBuffer = Buffer.isBuffer(source) || source instanceof Uint8Array;
  if (isBuffer) {
    try {
      fs.writeFileSync(metaPath(hash), Buffer.from(source as Uint8Array));
    } catch (e) {
      logger.warn("torrent.meta_save_failed", { error: (e as Error).message });
    }
  }
  // magnet может не прийти (загрузка .torrent-файлом) — тогда берём magnetURI
  // самого торрента: он тоже годится для возобновления.
  const magnet =
    opts.magnet ||
    (typeof source === "string" && /^magnet:/i.test(source) ? String(source) : null) ||
    String((torrent as TorrentLike & { magnetURI?: string }).magnetURI || "") ||
    null;
  rememberDownload({
    infoHash: hash,
    name: info.name,
    title: opts.title,
    releaseId: opts.releaseId ?? null,
    magnet,
    source: isBuffer ? "file" : "magnet",
    length: info.length,
    kept: opts.kept == null ? keepFilesByDefault() : !!opts.kept,
    state: torrent.done ? "done" : "downloading",
  });
  if (!doneHooked.has(hash)) {
    doneHooked.add(hash);
    torrent.on("done", () => setDownloadState(hash, "done"));
  }
}

/**
 * Добавить торрент (magnet-строка или Buffer .torrent) и дождаться метаданных.
 * Повторное добавление того же торрента не падает — возвращаем существующий.
 *
 * Раздача попадает в реестр (torrent_downloads): вкладка «Скачанные» показывает её
 * и после перезапуска, а .torrent кладётся в storage/torrents/meta — по нему
 * загрузка возобновляется после остановки (resumeDownload).
 */
export async function add(source: unknown, opts: AddOptions = {}): Promise<TorrentAdded> {
  const c = getClient();
  let torrent: TorrentLike | null = null;
  try {
    torrent = c.add(source, { path: DIRS.torrents });
  } catch {
    // Дубликат или некорректный источник — пробуем получить уже добавленный.
    try {
      torrent = c.get(source) || null;
    } catch {
      /* и такого торрента нет — обработаем ниже */
    }
  }
  if (!torrent) throw torrentError("bad_source", "cannot add torrent (invalid magnet/.torrent)");

  await waitForMetadata(torrent);
  const info = {
    infoHash: torrent.infoHash,
    name: torrent.name || "",
    length: Number(torrent.length) || 0,
    files: torrent.files.map((f, i) => fileInfo(f, i)),
  };
  registerDownload(torrent, source, opts, { name: info.name, length: info.length });
  logger.action("movies.torrent_added", {
    infoHash: info.infoHash,
    name: info.name,
    files: info.files.length,
  });
  return info;
}


/* ====== Реестр загрузок: «Скачанные», пауза, возобновление, удаление ====== */

/**
 * Галочка «хранить скачанный торрент после просмотра» (settings.movies.
 * keepTorrentFiles, переключается в плеере и на вкладке «Скачанные»).
 * По умолчанию файлы СОХРАНЯЕМ: удалять данные пользователя без спроса нельзя.
 */
export function keepFilesByDefault(): boolean {
  try {
    const cfg = (settings.get("movies") || {}) as { keepTorrentFiles?: boolean };
    return cfg.keepTorrentFiles !== false;
  } catch {
    return true;
  }
}

/** Путь .torrent-метафайла раздачи (нужен для возобновления загрузки). */
function metaPath(infoHash: string): string {
  return path.join(DIRS.torrentMeta, String(infoHash || "").toLowerCase() + ".torrent");
}

/** Запись реестра загрузок: то, что видно на вкладке «Скачанные». */
export interface TorrentDownload {
  infoHash: string;
  name: string;
  /** Название фильма/сериала — по нему восстанавливается окно плеера. */
  title: string;
  /** id раздачи на трекере (если открывали из поиска раздач). */
  releaseId: string | null;
  magnet: string | null;
  source: TorrentSourceKind;
  length: number;
  /** downloading — качается, paused — остановлено, done — загружено. */
  state: "downloading" | "paused" | "done";
  /** Галочка «хранить файлы после просмотра». */
  kept: boolean;
  /** Секунда, на которой остановился просмотр. */
  position: number;
  addedAt: string;
  updatedAt: string;
  /** Раздача сейчас в движке (есть живой прогресс) или только запись реестра. */
  active: boolean;
  progress: number;
  downloadSpeed: number;
  peers: number;
  downloaded: number;
}

/** Запомнить/обновить раздачу в реестре (ключ — infoHash). */
export function rememberDownload(entry: {
  infoHash: string;
  name?: string;
  title?: string;
  releaseId?: string | null;
  magnet?: string | null;
  source?: TorrentSourceKind;
  length?: number;
  kept?: boolean;
  state?: TorrentDownload["state"];
}): void {
  const infoHash = String(entry.infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return;
  const prev = (stmts.tdGet.get(infoHash) || {}) as Record<string, unknown>;
  const prevKept = prev.kept === 0 || prev.kept === false ? false : true;
  stmts.tdUpsert.run({
    info_hash: infoHash,
    name: String(entry.name || prev.name || ""),
    // Пустым значением не затираем: плеер может открыть раздачу без названия.
    title: String(entry.title || prev.title || ""),
    release_id: entry.releaseId == null ? (prev.release_id ?? null) : String(entry.releaseId),
    magnet: entry.magnet == null ? (prev.magnet ?? null) : String(entry.magnet),
    source: String(entry.source || prev.source || "file"),
    length: Number(entry.length || prev.length || 0),
    state: String(entry.state || prev.state || "downloading"),
    kept: entry.kept == null ? prevKept : !!entry.kept,
    position: Number(prev.position || 0),
  });
}

/** Состояние загрузки в реестре (downloading/paused/done). */
export function setDownloadState(infoHash: unknown, state: TorrentDownload["state"]): void {
  stmts.tdPatch.run(String(infoHash || "").toLowerCase(), { state });
}

/** Галочка «хранить файлы после просмотра» для конкретной раздачи. */
export function setDownloadKept(infoHash: unknown, kept: unknown): void {
  stmts.tdPatch.run(String(infoHash || "").toLowerCase(), { kept: !!kept });
}

/** Запомнить секунду просмотра, чтобы в следующий раз продолжить с неё. */
export function setDownloadPosition(infoHash: unknown, position: unknown): void {
  const sec = Math.max(0, Math.floor(Number(position) || 0));
  stmts.tdPatch.run(String(infoHash || "").toLowerCase(), { position: sec });
}

/** Список загрузок с живым прогрессом (для вкладки «Скачанные»). */
export function listDownloads(): TorrentDownload[] {
  return (stmts.tdAll.all() as Record<string, unknown>[]).map((r) => {
    const infoHash = String(r.info_hash || "");
    const live = status(infoHash);
    const state = String(r.state || "downloading") as TorrentDownload["state"];
    return {
      infoHash,
      name: String(r.name || live?.name || ""),
      title: String(r.title || ""),
      releaseId: r.release_id == null ? null : String(r.release_id),
      magnet: r.magnet == null ? null : String(r.magnet),
      source: String(r.source || "file") as TorrentSourceKind,
      length: Number(r.length || live?.length || 0),
      state,
      kept: !(r.kept === 0 || r.kept === false),
      position: Number(r.position || 0),
      addedAt: String(r.added_at || ""),
      updatedAt: String(r.updated_at || ""),
      active: !!live,
      progress: live ? live.progress : state === "done" ? 1 : 0,
      downloadSpeed: live ? live.downloadSpeed : 0,
      peers: live ? live.peers : 0,
      downloaded: live ? live.downloaded : 0,
    };
  });
}

/** Загрузка по названию тайтла — чтобы окно плеера восстановилось при повторном клике. */
export function downloadForTitle(title: unknown): TorrentDownload | null {
  const want = String(title || "").trim().toLowerCase();
  if (!want) return null;
  return listDownloads().find((d) => d.title.trim().toLowerCase() === want) || null;
}

/** Убрать запись реестра (после удаления раздачи). */
export function forgetDownload(infoHash: unknown): void {
  stmts.tdDelete.run(String(infoHash || "").toLowerCase());
}

/**
 * ОСТАНОВИТЬ загрузку, ничего не удаляя: раздача снимается с клиента (канал и
 * диск больше не трогаются), а куски остаются в storage/torrents — возобновление
 * (resumeDownload) продолжит с того же места.
 */
export function stopDownload(infoHash: unknown): { stopped: boolean; state: string } {
  const hash = String(infoHash || "").toLowerCase();
  const entry = stmts.tdGet.get(hash);
  const stopped = remove(hash).removed;
  if (entry) setDownloadState(hash, "paused");
  logger.action("movies.torrent_stopped", { infoHash: hash, stopped });
  return { stopped, state: "paused" };
}

/**
 * Возобновить остановленную загрузку: берём .torrent-метафайл (или magnet из
 * реестра) и добавляем раздачу снова — докачка идёт с уже скачанных кусков.
 */
export async function resumeDownload(infoHash: unknown): Promise<TorrentAdded> {
  const hash = String(infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) throw torrentError("bad_source", "bad infoHash");
  const entry = (stmts.tdGet.get(hash) || {}) as Record<string, unknown>;
  const file = metaPath(hash);
  let source: unknown = null;
  if (fs.existsSync(file)) source = fs.readFileSync(file);
  else if (entry.magnet) source = String(entry.magnet);
  if (!source) {
    throw torrentError("no_torrent", "нет .torrent-метафайла и magnet — возобновить нечем");
  }
  stmts.tdPatch.run(hash, { state: "downloading" });
  return add(source, {
    title: String(entry.title || ""),
    releaseId: entry.release_id == null ? undefined : String(entry.release_id),
    magnet: entry.magnet == null ? undefined : String(entry.magnet),
    kept: !(entry.kept === 0 || entry.kept === false),
  });
}

/**
 * Удалить раздачу: остановить загрузку и (files=true) стереть скачанные файлы.
 * files=false — «убрать из списка, файлы оставить на диске».
 */
export function purgeDownload(
  infoHash: unknown,
  { files = true }: { files?: boolean } = {},
): { removed: boolean; files: boolean } {
  const hash = String(infoHash || "").toLowerCase();
  const entry = (stmts.tdGet.get(hash) || {}) as Record<string, unknown>;
  const name = String(entry.name || "");
  if (client) {
    try {
      client.remove(hash, { destroyStore: !!files });
    } catch {
      /* раздачи могло уже не быть в клиенте */
    }
  }
  if (files && name) {
    // destroyStore у webtorrent чистит только свои куски, поэтому папку раздачи
    // убираем сами — иначе «удалённый» фильм продолжал бы занимать место.
    try {
      fs.rmSync(path.join(DIRS.torrents, path.basename(name)), { recursive: true, force: true });
    } catch (e) {
      logger.warn("torrent.purge_files_failed", { error: (e as Error).message, name });
    }
  }
  try {
    fs.rmSync(metaPath(hash), { force: true });
  } catch {
    /* метафайла могло не быть */
  }
  forgetDownload(hash);
  doneHooked.delete(hash);
  logger.action("movies.torrent_purged", { infoHash: hash, files: !!files });
  return { removed: true, files: !!files };
}

/**
 * Освободить место: удалить завершённые раздачи, которые не просили хранить.
 * Вызывается, когда пользователь выключает «хранить после просмотра».
 */
export function purgeUnkept(): number {
  let removed = 0;
  for (const d of listDownloads()) {
    if (!d.kept && d.state === "done") {
      purgeDownload(d.infoHash, { files: true });
      removed++;
    }
  }
  return removed;
}

/** Есть ли движок (для понятной ошибки на фронте). */
export function engineStatus(): { installed: boolean; client: boolean; error?: string } {
  try {
    engine();
    return { installed: true, client: !!client };
  } catch (e) {
    return { installed: false, client: false, error: (e as Error).message };
  }
}

/** Состояние торрента для поллинга из UI. */
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
  files: TorrentFileInfo[];
}

/** Текущее состояние торрента (прогресс/скорость/пиры/файлы) или null. */
export function status(infoHash: unknown): TorrentStatus | null {
  if (!client || !infoHash) return null;
  const torrent = client.get(String(infoHash));
  if (!torrent) return null;
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || "",
    ready: !!torrent.ready,
    done: !!torrent.done,
    progress: Number(torrent.progress) || 0,
    downloadSpeed: Number(torrent.downloadSpeed) || 0,
    uploadSpeed: Number(torrent.uploadSpeed) || 0,
    downloaded: Number(torrent.downloaded) || 0,
    uploaded: Number(torrent.uploaded) || 0,
    length: Number(torrent.length) || 0,
    peers: Number(torrent.numPeers) || 0,
    timeRemaining: Number.isFinite(torrent.timeRemaining)
      ? (torrent.timeRemaining as number)
      : null,
    ratio: Number(torrent.ratio) || 0,
    files: (torrent.files || []).map((f, i) => fileInfo(f, i)),
  };
}

/** Найти файл по индексу с проверкой диапазона. */
function fileAt(infoHash: unknown, index: unknown): { torrent: TorrentLike; file: TorrentFile } {
  if (!client) throw torrentError("no_torrent", "torrent client is not running");
  const torrent = client.get(String(infoHash));
  if (!torrent) throw torrentError("no_torrent", "torrent is not added");
  if (!torrent.ready) throw torrentError("no_metadata", "torrent metadata is not ready yet");
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= torrent.files.length) {
    throw torrentError("bad_file", "file index out of range");
  }
  return { torrent, file: torrent.files[idx] };
}

/**
 * Метаданные файла для HTTP-ответа (Range-роут): размер, MIME, имя.
 * Приоритизируем загрузку именно этого файла (остальные не качаем).
 */
export function streamInfo(
  infoHash: unknown,
  index: unknown,
): { name: string; length: number; mime: string } {
  const { torrent, file } = fileAt(infoHash, index);
  try {
    // Выделяем куски только выбранного файла — остальное не тратит канал.
    torrent.deselect(0, (torrent.pieces?.length ?? 0) - 1, false);
    torrent.select(file._startPiece ?? 0, file._endPiece ?? 0, 0);
    // Последовательная стратегия: куски приходят по порядку, поэтому смотреть
    // можно ВО ВРЕМЯ скачивания (не ждём редкие куски в конце файла).
    torrent.strategy = "sequential";
  } catch {
    /* внутренние поля могут отличаться — не критично */
  }
  return { name: file.name, length: file.length, mime: mimeOf(file.name) };
}

/**
 * ReadStream выбранного файла (для Range-запроса). start/end — байты.
 * Возвращает Node-стрим, который роут пайпит в ответ.
 */
export function createReadStream(
  infoHash: unknown,
  index: unknown,
  { start, end }: { start?: number; end?: number } = {},
): NodeJS.ReadableStream {
  const { file } = fileAt(infoHash, index);
  const opts: { start?: number; end?: number } = {};
  if (Number.isFinite(start)) opts.start = start;
  if (Number.isFinite(end)) opts.end = end;
  return file.createReadStream(opts);
}

/** Прибрать торрент (остановить загрузку; куски в кэше остаются). */
export function remove(infoHash: unknown): { removed: boolean } {
  if (!client) return { removed: false };
  try {
    const torrent = client.get(String(infoHash));
    if (!torrent) return { removed: false };
    client.remove(String(infoHash), { destroyStore: false });
    logger.action("movies.torrent_removed", { infoHash: String(infoHash) });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/** Список активных торрентов. */
export function active(): { infoHash: string; name: string; progress: number; peers: number }[] {
  if (!client) return [];
  return client.torrents.map((t) => ({
    infoHash: t.infoHash,
    name: t.name || "",
    progress: t.progress || 0,
    peers: t.numPeers || 0,
  }));
}

/* ====== Сценарий А: несколько файлов в торренте (серии и т.п.) ====== */

/**
 * Расширения, которые могут открыться в плеере. Требование модуля — фильтровать
 * .mkv/.mp4/.avi; дополнительно оставлены соседние контейнеры (.m4v/.mov/.webm/
 * .ts), иначе раздачи с сериями в .ts выглядели бы «пустыми».
 */
const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|mpg|mpeg|ogv)$/i;

/** Файл раздачи — медиа (можно пробовать проиграть)? */
export function isMediaFile(name: unknown): boolean {
  return MEDIA_EXT_RE.test(String(name || ""));
}

/** Результат getTorrentFileList: медиафайлы + признак «медиа не нашлось». */
export interface TorrentFileList extends TorrentAdded {
  /** true — медиафайлов в раздаче нет, показаны все файлы (честно и без пустого UI). */
  noMedia: boolean;
}

/**
 * Метаданные торрента ДО начала полного скачивания: список файлов с индексами,
 * именами и размерами. По умолчанию — только медиафайлы, отсортированные по
 * размеру (сверху самый крупный: обычно это фильм или первая серия).
 *
 * torrentInput: magnet-строка | Buffer .torrent | base64 .torrent | infoHash
 * (infoHash — если торрент уже добавлен в клиент; повторно не добавляем).
 */
export async function getTorrentFileList(
  torrentInput: unknown,
  opts: AddOptions & { mediaOnly?: boolean } = {},
): Promise<TorrentFileList> {
  const mediaOnly = opts.mediaOnly !== false;
  const c = getClient();
  const input = typeof torrentInput === "string" ? torrentInput.trim() : torrentInput;

  let torrent: TorrentLike | null;
  // Источник в исходном виде: реестру «Скачанные» нужен magnet или .torrent,
  // чтобы загрузку можно было возобновить (по infoHash этого не сделать).
  let registrySource: unknown = input;
  if (typeof input === "string" && /^[a-f0-9]{40}$/i.test(input)) {
    torrent = c.get(input) || null;
    if (!torrent) throw torrentError("no_torrent", "torrent with this infoHash is not added");
  } else {
    let source: unknown = input;
    if (typeof input === "string" && !/^magnet:/i.test(input)) {
      // Строка не magnet — считаем её base64 от .torrent (так его отдаёт фронт).
      const buf = Buffer.from(input, "base64");
      if (!buf.length) throw torrentError("bad_source", "cannot decode .torrent payload");
      source = buf;
    }
    registrySource = source;
    try {
      torrent = c.add(source, { path: DIRS.torrents });
    } catch {
      // Дубликат или уже добавленный торрент — берём существующий.
      torrent = c.get(source as string) || null;
    }
    if (!torrent) throw torrentError("bad_source", "cannot add torrent (invalid magnet/.torrent)");
  }

  await waitForMetadata(torrent);
  // Раздача из поиска раздач/файла тоже попадает в реестр «Скачанные».
  registerDownload(torrent, registrySource, opts, {
    name: torrent.name || "",
    length: Number(torrent.length) || 0,
  });
  const all = torrent.files.map((f, i) => fileInfo(f, i));
  const media = all.filter((f) => isMediaFile(f.name));
  const noMedia = media.length === 0;
  const files = (mediaOnly && !noMedia ? media : all).sort((a, b) => b.length - a.length);

  logger.action("movies.torrent_filelist", {
    infoHash: torrent.infoHash,
    files: all.length,
    media: media.length,
  });
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || "",
    length: Number(torrent.length) || 0,
    files,
    noMedia,
  };
}

/**
 * Переключить воспроизводимый файл раздачи (например, серию): куски выбранного
 * файла получают приоритет, остальные снимаются с загрузки, чтобы канал не
 * тратился на другие серии. Возвращает метаданные файла — URL стрима строит фронт
 * (`/api/movies/torrent/stream/:infoHash/:index`).
 */
export function selectTorrentFile(infoHash: unknown, index: unknown): TorrentFileInfo {
  const { torrent, file } = fileAt(infoHash, index);
  try {
    torrent.deselect(0, (torrent.pieces?.length ?? 0) - 1, false);
    torrent.select(file._startPiece ?? 0, file._endPiece ?? 0, 0);
  } catch {
    /* внутренние поля могут отличаться — не критично */
  }
  return fileInfo(file, Number(index));
}

/** Сброс клиента — только для тестов и аварийного перезапуска движка. */
export function _reset(): void {
  if (client) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
