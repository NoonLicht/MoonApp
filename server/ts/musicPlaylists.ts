/**
 * Плейлисты для страницы Музыки.
 *
 * ИСТОРИЯ: раньше здесь были только «сохранённые поисковые запросы» — у
 * страницы нет постоянной локальной библиотеки (yt-dlp качает файл сразу в
 * Downloads пользователя одноразовым ключом, см. server/routes/music.js →
 * GET /download/:key удаляет файл после отдачи), поэтому казалось, что
 * настоящий плейлист (список конкретных треков) невозможен без отдельного
 * сканера+плеера локальных файлов.
 *
 * На деле это не так: плейлист может хранить не файлы, а МЕТАДАННЫЕ треков
 * (id/title/artist/webpageUrl — то, что уже возвращает поиск yt-dlp), и по
 * клику просто заново скачивать конкретный трек по его webpageUrl — точно
 * так же, как уже работает скачивание одного трека из результатов поиска.
 * Это и есть настоящий плейлист («набор конкретных треков», а не «поисковый
 * запрос»), без необходимости хранить сами аудиофайлы на диске.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";

const { FILES } = config;

export interface PlaylistTrack {
  id: string;
  title: string;
  artist: string;
  webpageUrl: string;
  duration: number | null;
  durationString: string;
  thumbnail: string | null;
  addedAt: number;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
  createdAt: number;
}

export interface TrackInput {
  id?: string;
  title: string;
  artist?: string;
  webpageUrl: string;
  duration?: number | null;
  durationString?: string;
  thumbnail?: string | null;
}

function readAll(): MusicPlaylist[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.musicPlaylists, "utf8"));
    if (!Array.isArray(raw)) return [];
    // Совместимость со старым форматом (query вместо tracks) — пустые
    // плейлисты вместо падения, ничего ценного там всё равно не было (это
    // была просто строка поиска, не данные пользователя, которые можно потерять).
    return raw.map((x) => ({
      id: String(x.id || crypto.randomUUID()),
      name: String(x.name || "Плейлист"),
      tracks: Array.isArray(x.tracks) ? x.tracks : [],
      createdAt: Number(x.createdAt) || Date.now(),
    }));
  } catch {
    return [];
  }
}

function writeAll(items: MusicPlaylist[]): void {
  fs.writeFileSync(FILES.musicPlaylists, JSON.stringify(items, null, 2), "utf8");
}

export function list(): MusicPlaylist[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function create(name: string): MusicPlaylist {
  const entry: MusicPlaylist = {
    id: crypto.randomUUID(),
    name: String(name || "").trim() || "Плейлист",
    tracks: [],
    createdAt: Date.now(),
  };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  logger.info("musicPlaylists.create", { id: entry.id });
  return entry;
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** Добавляет трек в плейлист (без дублей — сравнение по webpageUrl). */
export function addTrack(playlistId: string, input: TrackInput): MusicPlaylist | null {
  const all = readAll();
  const pl = all.find((x) => x.id === playlistId);
  if (!pl) return null;
  if (!input.webpageUrl) throw new Error("missing_webpageUrl");
  if (pl.tracks.some((t) => t.webpageUrl === input.webpageUrl)) return pl; // уже есть

  pl.tracks.push({
    id: input.id || crypto.randomUUID(),
    title: String(input.title || "Untitled"),
    artist: String(input.artist || "Unknown"),
    webpageUrl: input.webpageUrl,
    duration: input.duration ?? null,
    durationString: input.durationString || "",
    thumbnail: input.thumbnail || null,
    addedAt: Date.now(),
  });
  writeAll(all);
  logger.info("musicPlaylists.addTrack", { playlistId, title: input.title });
  return pl;
}

export function removeTrack(playlistId: string, trackId: string): MusicPlaylist | null {
  const all = readAll();
  const pl = all.find((x) => x.id === playlistId);
  if (!pl) return null;
  pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
  writeAll(all);
  return pl;
}
