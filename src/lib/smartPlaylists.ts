/**
 * Умные плейлисты: виртуальные списки, собранные из всех обычных плейлистов
 * по правилам. Ничего не хранятся — пересчитываются при каждом открытии.
 */
import type { PlaylistTrack } from "@/api/types";

export type SmartKind = "recent" | "short" | "long" | "artist" | "mix";

export interface SmartPlaylist {
  id: string;
  kind: SmartKind;
  /** Для kind="artist" — имя исполнителя. */
  arg?: string;
  tracks: PlaylistTrack[];
}

const DAY = 86_400_000;
export const RECENT_DAYS = 14;
export const SHORT_SEC = 180;
export const LONG_SEC = 600;
export const MIX_SIZE = 20;
const MIN_ARTIST_TRACKS = 3;
const MAX_ARTISTS = 3;

/** Детерминированный генератор (mulberry32): «Случайные» не прыгают при каждом рендере. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unique(all: { tracks: PlaylistTrack[] }[]): PlaylistTrack[] {
  const seen = new Map<string, PlaylistTrack>();
  for (const p of all) for (const t of p.tracks) if (!seen.has(t.webpageUrl || t.id)) seen.set(t.webpageUrl || t.id, t);
  return [...seen.values()];
}

export function smartPlaylists(
  playlists: { tracks: PlaylistTrack[] }[],
  now = Date.now(),
  seed = Math.floor(now / DAY),
): SmartPlaylist[] {
  const all = unique(playlists);
  const out: SmartPlaylist[] = [];
  const add = (p: SmartPlaylist): void => {
    if (p.tracks.length) out.push(p);
  };

  add({
    id: "smart:recent",
    kind: "recent",
    tracks: all.filter((t) => now - t.addedAt <= RECENT_DAYS * DAY).sort((a, b) => b.addedAt - a.addedAt),
  });
  add({
    id: "smart:short",
    kind: "short",
    tracks: all.filter((t) => t.duration !== null && t.duration > 0 && t.duration <= SHORT_SEC),
  });
  add({
    id: "smart:long",
    kind: "long",
    tracks: all.filter((t) => t.duration !== null && t.duration >= LONG_SEC),
  });

  const byArtist = new Map<string, PlaylistTrack[]>();
  for (const t of all) {
    const a = t.artist.trim();
    if (!a) continue;
    const key = a.toLowerCase();
    byArtist.set(key, [...(byArtist.get(key) ?? []), t]);
  }
  [...byArtist.values()]
    .filter((l) => l.length >= MIN_ARTIST_TRACKS)
    .sort((a, b) => b.length - a.length || a[0].artist.localeCompare(b[0].artist))
    .slice(0, MAX_ARTISTS)
    .forEach((l) => add({ id: `smart:artist:${l[0].artist.toLowerCase()}`, kind: "artist", arg: l[0].artist, tracks: l }));

  if (all.length >= 2) {
    const r = rng(seed);
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    add({ id: "smart:mix", kind: "mix", tracks: shuffled.slice(0, MIX_SIZE) });
  }
  return out;
}
