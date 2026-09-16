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
import path from "path";
import config from "./config";
import logger from "./logger";

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

/**
 * Добавить торрент (magnet-строка или Buffer .torrent) и дождаться метаданных.
 * Повторное добавление того же торрента не падает — возвращаем существующий.
 */
export async function add(source: unknown): Promise<TorrentAdded> {
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
  logger.action("movies.torrent_added", {
    infoHash: torrent.infoHash,
    name: torrent.name,
    files: torrent.files.length,
  });
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || "",
    length: Number(torrent.length) || 0,
    files: torrent.files.map((f, i) => fileInfo(f, i)),
  };
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
