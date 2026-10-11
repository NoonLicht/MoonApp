/**
 * Фрагмент видео: скачивание не всего ролика, а отрезка времени
 * (yt-dlp --download-sections). Здесь — разбор и проверка границ.
 */

/** «90», «1:30», «01:02:03», «1:30.5» → секунды; null — не время. */
export function parseTime(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec >= 60) return null;
  return h * 3600 + min * 60 + sec;
}

export interface Clip {
  from: number;
  to: number;
}

/** Границы фрагмента; ошибка bad_clip при неверном формате/порядке, clip_too_long — длиннее 6 часов. */
export function normalizeClip(from: unknown, to: unknown, duration?: number | null): Clip | null {
  const f = parseTime(from);
  const t = parseTime(to);
  if (f === null && t === null) return null;
  const start = f ?? 0;
  const end = t ?? (duration && duration > 0 ? duration : null);
  if (end === null || !(end > start)) throw new Error("bad_clip");
  if (end - start > 6 * 3600) throw new Error("clip_too_long");
  if (duration && duration > 0 && start >= duration) throw new Error("bad_clip");
  return { from: start, to: duration && duration > 0 ? Math.min(end, duration) : end };
}

const hms = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(Math.floor(s))}${s % 1 ? String(Math.round((s % 1) * 100) / 100).slice(1) : ""}`;
};

/** Аргументы yt-dlp для фрагмента. */
export function clipArgs(clip: Clip): string[] {
  return ["--download-sections", `*${hms(clip.from)}-${hms(clip.to)}`, "--force-keyframes-at-cuts"];
}
