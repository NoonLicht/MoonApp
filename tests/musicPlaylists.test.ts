import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);

let storage: string;
let engine: typeof import("../server/musicPlaylists");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-musicplaylists-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/musicPlaylists");
});

describe("server/musicPlaylists — плейлисты конкретных треков", () => {
  it("create/list/remove работают", () => {
    const created = engine.create("Chill");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Chill");
    expect(created.tracks).toEqual([]);

    const list1 = engine.list();
    expect(list1).toHaveLength(1);

    expect(engine.remove(created.id)).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it("без имени подставляется дефолтное название", () => {
    const created = engine.create("");
    expect(created.name).toBe("Плейлист");
    engine.remove(created.id);
  });

  it("addTrack добавляет трек, повторное добавление того же webpageUrl — дедуп", () => {
    const pl = engine.create("Мой плейлист");
    const track = {
      title: "Song A",
      artist: "Artist",
      webpageUrl: "https://youtu.be/abc123",
      duration: 200,
      durationString: "3:20",
      thumbnail: null,
    };
    const withTrack = engine.addTrack(pl.id, track);
    expect(withTrack?.tracks).toHaveLength(1);
    expect(withTrack?.tracks[0].title).toBe("Song A");

    const dupe = engine.addTrack(pl.id, track);
    expect(dupe?.tracks).toHaveLength(1); // дедуп по webpageUrl, не 2

    engine.remove(pl.id);
  });

  it("addTrack без webpageUrl отклоняется, addTrack/removeTrack на несуществующий плейлист — null", () => {
    const pl = engine.create("X");
    expect(() => engine.addTrack(pl.id, { title: "no url" } as never)).toThrow("missing_webpageUrl");
    expect(engine.addTrack("no-such-id", { title: "t", webpageUrl: "u" })).toBeNull();
    expect(engine.removeTrack("no-such-id", "no-such-track")).toBeNull();
    engine.remove(pl.id);
  });

  it("removeTrack убирает конкретный трек, не трогая остальные", () => {
    const pl = engine.create("Two tracks");
    const withA = engine.addTrack(pl.id, { title: "A", webpageUrl: "https://x/a" })!;
    const withB = engine.addTrack(pl.id, { title: "B", webpageUrl: "https://x/b" })!;
    expect(withB.tracks).toHaveLength(2);

    const afterRemove = engine.removeTrack(pl.id, withA.tracks[0].id);
    expect(afterRemove?.tracks).toHaveLength(1);
    expect(afterRemove?.tracks[0].title).toBe("B");

    engine.remove(pl.id);
  });

  it("readAll переваривает старый формат данных (query вместо tracks) без падения", () => {
    fs.writeFileSync(
      path.join(storage, "music-playlists.json"),
      JSON.stringify([{ id: "old-1", name: "Старый", query: "lofi", createdAt: 1 }]),
      "utf8",
    );
    const list = engine.list();
    expect(list).toHaveLength(1);
    expect(list[0].tracks).toEqual([]);
    engine.remove("old-1");
  });
});
