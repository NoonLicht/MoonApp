"use strict";

/**
 * Торрент-движок для страницы «Фильмы и Сериалы».
 *
 * Назначение: воспроизведение/скачивание торрента, который пользователь открыл
 * САМ (вставил magnet-ссылку или загрузил .torrent-файл). Это dual-use
 * инструмент общего назначения — как любой BitTorrent-клиент. Приложение НЕ
 * ищет и НЕ подбирает торренты и не парсит трекеры: источник задаёт пользователь
 * и сам отвечает за то, чтобы контент был легальным (публичное достояние,
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
 */

const path = require("path");
const { DIRS } = require("./config");
const logger = require("./logger");

let WebTorrent = null;
let client = null;

/** Коды MIME для стриминга (нужны <video>). Без внешних зависимостей. */
const MIME = {
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

function mimeOf(name) {
  return MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

/** Информация об ошибке с кодом (для роутов). */
function torrentError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** Ленивая загрузка webtorrent (CommonJS-версия 1.x — совместима с Electron/Node). */
function engine() {
  if (WebTorrent) return WebTorrent;
  try {
    WebTorrent = require("webtorrent");
  } catch (e) {
    throw torrentError("engine_missing", `WebTorrent engine is not installed: ${e.message}`);
  }
  return WebTorrent;
}

/** Единственный клиент на процесс. */
function getClient() {
  if (client) return client;
  const WT = engine();
  client = new WT({ maxConns: 55, torrentPort: 0 });
  client.on("error", (e) =>
    logger.warn("torrent.client_error", { error: e?.message || String(e) }),
  );
  return client;
}

/** Краткое описание файла торрента для фронта. */
function fileInfo(file, index) {
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
function waitForMetadata(torrent, timeoutMs = 60000) {
  if (torrent.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        torrentError("metadata_timeout", "Timed out waiting for torrent metadata (no peers?)"),
      );
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (e) => {
      cleanup();
      reject(torrentError("torrent_error", e?.message || String(e)));
    };
    function cleanup() {
      clearTimeout(timer);
      torrent.removeListener("ready", onReady);
      torrent.removeListener("error", onError);
    }
    torrent.on("ready", onReady);
    torrent.on("error", onError);
  });
}

/**
 * Добавить торрент (magnet-строка или Buffer .torrent) и дождаться метаданных.
 * Возвращает { infoHash, name, length, files }.
 * Повторное добавление того же торрента не падает — возвращаем существующий.
 */
async function add(source) {
  const c = getClient();
  let torrent = null;
  try {
    torrent = c.add(source, { path: DIRS.torrents });
  } catch {
    // Дубликат или некорректный источник — пробуем получить уже добавленный.
    try {
      torrent = c.get(source);
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
    name: torrent.name,
    length: torrent.length,
    files: torrent.files.map((f, i) => fileInfo(f, i)),
  };
}

/** Есть ли движок (для понятной ошибки на фронте). */
function engineStatus() {
  try {
    engine();
    return { installed: true, client: !!client };
  } catch (e) {
    return { installed: false, error: e.message };
  }
}

/** Текущее состояние торрента (прогресс/скорость/пиры/файлы) или null. */
function status(infoHash) {
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
    timeRemaining: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining : null,
    ratio: Number(torrent.ratio) || 0,
    files: (torrent.files || []).map((f, i) => fileInfo(f, i)),
  };
}

/** Найти файл по индексу с проверкой диапазона. */
function fileAt(infoHash, index) {
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
function streamInfo(infoHash, index) {
  const { torrent, file } = fileAt(infoHash, index);
  try {
    // Выделяем куски только выбранного файла — остальное не тратит канал.
    torrent.deselect(0, torrent.pieces.length - 1, false);
    torrent.select(file._startPiece, file._endPiece, 0);
  } catch {
    /* внутренние поля могут отличаться — не критично */
  }
  return { name: file.name, length: file.length, mime: mimeOf(file.name) };
}

/**
 * ReadStream выбранного файла (для Range-запроса). start/end — байты.
 * Возвращает Node-стрим, который роут пайпит в ответ.
 */
function createReadStream(infoHash, index, { start, end } = {}) {
  const { file } = fileAt(infoHash, index);
  const opts = {};
  if (Number.isFinite(start)) opts.start = start;
  if (Number.isFinite(end)) opts.end = end;
  return file.createReadStream(opts);
}

/** Прибрать торрент (остановить загрузку; куски в кэше остаются). */
function remove(infoHash) {
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
function active() {
  if (!client) return [];
  return client.torrents.map((t) => ({
    infoHash: t.infoHash,
    name: t.name,
    progress: t.progress || 0,
    peers: t.numPeers || 0,
  }));
}

module.exports = {
  engineStatus,
  add,
  status,
  streamInfo,
  createReadStream,
  remove,
  active,
  mimeOf,
  _reset: () => {
    if (client) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      client = null;
    }
  },
};
