import { describe, it, expect } from "vitest";
import { smartPlaylists } from "../src/lib/smartPlaylists";

/** Умные плейлисты (src/lib/smartPlaylists.ts). */
const DAY = 86_400_000;
const NOW = 100 * DAY;
let n = 0;
const tr = (artist: string, duration: number | null, ageDays: number, url?: string) => ({
  id: `t${n}`,
  title: `Трек ${n}`,
  artist,
  webpageUrl: url ?? `https://x/${n++}`,
  duration,
  durationString: "",
  thumbnail: null,
  addedAt: NOW - ageDays * DAY,
});

describe("smartPlaylists", () => {
  it("делит по давности, длительности и исполнителям", () => {
    const pl = [
      {
        tracks: [
          tr("Альфа", 120, 1),
          tr("Альфа", 700, 30),
          tr("Альфа", 200, 3),
          tr("Бета", 200, 40),
          tr("Бета", null, 50),
        ],
      },
    ];
    const s = smartPlaylists(pl, NOW, 1);
    const by = Object.fromEntries(s.map((p) => [p.id, p]));
    expect(by["smart:recent"].tracks.length).toBe(2);
    expect(by["smart:recent"].tracks[0].addedAt).toBeGreaterThan(by["smart:recent"].tracks[1].addedAt);
    expect(by["smart:short"].tracks.length).toBe(1);
    expect(by["smart:long"].tracks.length).toBe(1);
    expect(by["smart:artist:альфа"].arg).toBe("Альфа");
    expect(by["smart:artist:альфа"].tracks.length).toBe(3);
    expect(by["smart:artist:бета"]).toBeUndefined();
  });

  it("не дублирует один и тот же трек из разных плейлистов", () => {
    const a = tr("А", 100, 1, "https://same");
    const s = smartPlaylists([{ tracks: [a] }, { tracks: [{ ...a, id: "other" }] }], NOW, 1);
    expect(s.find((p) => p.id === "smart:recent")?.tracks.length).toBe(1);
  });

  it("«Случайные» детерминированы при одном seed и не длиннее 20", () => {
    const pl = [{ tracks: Array.from({ length: 40 }, (_v, i) => tr(`X${i}`, 200, 60)) }];
    const a = smartPlaylists(pl, NOW, 7).find((p) => p.id === "smart:mix")!;
    const b = smartPlaylists(pl, NOW, 7).find((p) => p.id === "smart:mix")!;
    expect(a.tracks.length).toBe(20);
    expect(a.tracks.map((t) => t.id)).toEqual(b.tracks.map((t) => t.id));
  });

  it("пустые правила не создают плейлистов", () => {
    expect(smartPlaylists([], NOW)).toEqual([]);
    expect(smartPlaylists([{ tracks: [] }], NOW)).toEqual([]);
  });
});
