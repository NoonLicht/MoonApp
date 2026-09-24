/**
 * "Умные плейлисты" для страницы Музыки.
 *
 * У страницы Music нет постоянной локальной библиотеки — треки скачиваются
 * через yt-dlp сразу в Downloads пользователя одноразовым ключом (см.
 * server/routes/music.js → GET /download/:key удаляет файл после отдачи),
 * так что плейлист как фильтр по библиотеке технически невозможен без
 * отдельной большой фичи (сканер + плеер локальных файлов).
 *
 * Здесь плейлист — это ИМЕНОВАННЫЙ СОХРАНЁННЫЙ ПОИСКОВЫЙ ЗАПРОС: пользователь
 * сохраняет то, что искал ("умный" в смысле "повторно выполняемый поиск"),
 * и одним кликом повторяет его позже вместо ручного ввода текста заново.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";

const { FILES } = config;

export interface MusicPlaylist {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

function readAll(): MusicPlaylist[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.musicPlaylists, "utf8"));
    return Array.isArray(raw) ? raw : [];
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

export function create(name: string, query: string): MusicPlaylist {
  const entry: MusicPlaylist = {
    id: crypto.randomUUID(),
    name: String(name || query).trim() || "Плейлист",
    query: String(query || "").trim(),
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
