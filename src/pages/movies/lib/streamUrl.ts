/**
 * URL-ы медиапотоков торрент-плеера.
 *
 * Почему отдельный модуль: правила сборки ссылок — единственное место, где фронт
 * и бэкенд обязаны договориться до символа (браузер грузит эти URL тегами
 * <video>/<track>, проверить ответ глазами нельзя). Чистые функции покрыты
 * tests/movieStreamUrl.test.ts.
 *
 * Потоки ресурсные (без токена), поэтому бэкенд валидирует параметры сам:
 * infoHash — 40 hex, index — целое, audio/track — 0..63, start — секунды 0..86400.
 */

import type { PlaybackMode } from "@/api/types";

/**
 * Режим воспроизведения файла раздачи: значения те же, что в плане бэкенда
 * (server/ts/mediaProbe.ts → playbackPlan / src/api/types.ts → TorrentPlaybackPlan).
 */
export type { PlaybackMode };

/** Минимальный набор параметров remux-потока. */
export interface StreamParams {
  /** Начало воспроизведения, секунды (перемотка = новый запрос). */
  startSec?: number;
  /** Относительный индекс аудиодорожки (из списка ffprobe). */
  audio?: number;
  /** "h264" — перекодировать видео (Chromium не читает кодек). */
  video?: "copy" | "h264";
  /**
   * Секунда уже выровнена по ключевому кадру (ответ /torrent/seek). Тогда бэкенд
   * не переспрашивает ffprobe: двойное выравнивание давало расхождение старта
   * (клиент 1173.673, сервер 1172.546) — и звук со шкалой разъезжались.
   */
  aligned?: boolean;
}

/**
 * URL потока с выбранной аудиодорожкой (ffmpeg переупаковывает на лету).
 * audio=0 не пишем: это значение бэкенда по умолчанию. video=h264 добавляем
 * только при перекодировании: копирование — режим по умолчанию.
 */
export function remuxUrl(infoHash: string, index: number, p: StreamParams = {}): string {
  const qs = new URLSearchParams();
  const audio = Math.floor(Number(p.audio));
  if (Number.isFinite(audio) && audio > 0) qs.set("audio", String(audio));
  if (p.video === "h264") qs.set("video", "h264");
  const start = Number(p.startSec);
  if (Number.isFinite(start) && start > 0) {
    // Три знака после точки: столько же, сколько в `-ss` у ffmpeg. Двух не
    // хватало — ключевой кадр 1173.673 превращался в «1173.67» и выравнивание
    // скатывалось на предыдущий кадр (жёлтая полоса в логах: 1172.546).
    qs.set("start", String(Math.round(start * 1000) / 1000));
    // «Секунда уже выровнена» имеет смысл только вместе со стартом: без него
    // сервер и так начинает с нуля и ключевой кадр не ищет.
    if (p.aligned) qs.set("aligned", "1");
  }
  const q = qs.toString();
  const base = `/api/movies/torrent/remux/${encodeURIComponent(infoHash)}/${index}`;
  return q ? `${base}?${q}` : base;
}

/** Контейнеры, которые Chromium демуксит сам. */
const DIRECT_EXTS = new Set(["mp4", "m4v", "mov", "webm"]);
/** Видеокодеки, которые Chromium декодирует сам. */
const DIRECT_VIDEO = new Set(["h264", "avc1", "vp8", "vp9", "av1", "theora"]);
/** Аудиокодеки, которые Chromium декодирует сам. */
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/**
 * Запасной ответ на вопрос «можно ли отдать файл прямо в <video>?» — по имени.
 * Нужен, пока ffprobe не ответил (или не смог): основной ответ приходит с бэкенда
 * (TorrentTrackList.plan), но плеер обязан начать играть и без него.
 *
 * Важно: MKV/AVI ВСЕГДА нужны через ffmpeg — Matroska Chromium не демуксит даже
 * с h264 внутри, и прямая отдача падала с «Поток не воспроизводится».
 */
export function isDirectPlayable(name: unknown): boolean {
  const s = String(name == null ? "" : name).trim().toLowerCase();
  const dot = s.lastIndexOf(".");
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const ext = dot > slash ? s.slice(dot + 1) : "";
  if (!DIRECT_EXTS.has(ext)) return false;
  // Кодеков по имени не знаем: для mp4/webm копирование почти всегда проходит,
  // а если нет — плеер спустится на remux (лестница фолбэков в PlayerModal).
  return true;
}

/** Справочники для тестов и для UI: что Chromium читает сам. */
export const DIRECT_MEDIA = { DIRECT_EXTS, DIRECT_VIDEO, DIRECT_AUDIO };

/** Ссылка на субтитры: ?track=<N> — дорожка контейнера, ?file=<index> — файл раздачи. */
export function subtitleUrl(
  infoHash: string,
  index: number,
  track: { track?: number; file?: number } = {},
): string {
  const qs = new URLSearchParams();
  const file = Math.floor(Number(track.file));
  if (Number.isFinite(file) && file >= 0) {
    qs.set("file", String(file));
  } else {
    const t = Math.floor(Number(track.track));
    qs.set("track", String(Number.isFinite(t) && t > 0 ? t : 0));
  }
  const base = `/api/movies/torrent/subtitles/${encodeURIComponent(infoHash)}/${index}`;
  return `${base}?${qs.toString()}`;
}

/** Секунды → «1:23:45» / «23:45» для подписей в UI. */
export function fmtTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * «1:23:45» / «23:45» / «754,2» → секунды. null — если ввод не разобрать
 * (тогда перемотку не применяем, а не отправляем мусор в ?start=).
 */
export function parseTime(text: unknown): number | null {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) return null;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  return Number(m[1] || 0) * 3600 + min * 60 + sec;
}

/**
 * Подпись раздачи для списка: разрешение, аудио, кодек — то, по чему выбирают.
 * Пустые поля не попадают в подпись, чтобы не было «— — —».
 */
export function releaseMetaLine(meta: {
  resolution?: string | null;
  codec?: string | null;
  source?: string | null;
  hdr?: string | null;
  audio?: string[];
}): string {
  const parts: string[] = [];
  if (meta?.resolution) parts.push(meta.resolution);
  if (meta?.hdr) parts.push(meta.hdr);
  if (meta?.source) parts.push(meta.source);
  if (meta?.codec) parts.push(meta.codec);
  const audio = (meta?.audio || []).filter(Boolean);
  if (audio.length) parts.push(audio.join(" / "));
  return parts.join(" · ");
}
