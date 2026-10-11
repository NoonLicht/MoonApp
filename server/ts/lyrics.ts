/**
 * Тексты песен с таймкодами (LRC) для режима «караоке».
 *
 *  - parseLrc: строки вида «[mm:ss.xx] текст» (несколько меток на строку,
 *    смещение [offset:±мс]) → отсортированный список { t, text };
 *  - currentLine: индекс строки, которая звучит в момент t;
 *  - lrclibUrl / pickLyrics: запрос к открытой базе lrclib.net и выбор ответа.
 */

export interface LrcLine {
  /** Секунды от начала трека. */
  t: number;
  text: string;
}

export function parseLrc(src: string): LrcLine[] {
  const out: LrcLine[] = [];
  let offset = 0;
  for (const raw of String(src || "").split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      out.push({ t: Math.max(0, Number(m[1]) * 60 + Number(m[2]) + frac + offset), text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Индекс звучащей строки (-1 — песня ещё не началась). Двоичный поиск. */
export function currentLine(lines: LrcLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function lrclibUrl(artist: string, title: string, durationSec?: number | null): string {
  const p = new URLSearchParams({ artist_name: artist.trim(), track_name: title.trim() });
  if (durationSec && durationSec > 0) p.set("duration", String(Math.round(durationSec)));
  return `https://lrclib.net/api/get?${p.toString()}`;
}

export interface LrclibResponse {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
}

/** Из ответа lrclib: синхронный текст, иначе обычный (без таймкодов), иначе пусто. */
export function pickLyrics(r: LrclibResponse | null): { synced: LrcLine[]; plain: string } {
  if (!r || r.instrumental) return { synced: [], plain: "" };
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  return { synced, plain: synced.length ? "" : String(r.plainLyrics || "").trim() };
}
