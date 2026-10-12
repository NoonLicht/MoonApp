import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Подписка на каналы YouTube через RSS (server/ts/youtubeFeed.ts). */
const req = createRequire(import.meta.url);
let yt: any;
beforeAll(() => {
  yt = req("../server/youtubeFeed");
});

const ID = "UCabcdefghijklmnopqrstuv"; // UC + 22 символа

describe("resolveYoutube", () => {
  it("идентификатор и /channel/ дают ленту сразу", () => {
    const feed = { kind: "feed", url: `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}` };
    expect(yt.resolveYoutube(ID)).toEqual(feed);
    expect(yt.resolveYoutube(`https://www.youtube.com/channel/${ID}/videos`)).toEqual(feed);
    expect(yt.resolveYoutube(`youtube.com/channel/${ID}`)).toEqual(feed);
  });

  it("плейлист и готовая лента", () => {
    expect(yt.resolveYoutube("https://www.youtube.com/playlist?list=PLabcdefghijk123")).toEqual({
      kind: "feed",
      url: "https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghijk123",
    });
    const own = "https://www.youtube.com/feeds/videos.xml?channel_id=" + ID;
    expect(yt.resolveYoutube(own)).toEqual({ kind: "feed", url: own });
  });

  it("@handle и /c/ требуют загрузки страницы", () => {
    expect(yt.resolveYoutube("@veritasium")).toEqual({ kind: "page", pageUrl: "https://www.youtube.com/@veritasium" });
    expect(yt.resolveYoutube("https://www.youtube.com/@veritasium/videos")).toEqual({
      kind: "page",
      pageUrl: "https://www.youtube.com/@veritasium",
    });
    expect(yt.resolveYoutube("https://youtube.com/c/SomeName")).toEqual({
      kind: "page",
      pageUrl: "https://www.youtube.com/c/SomeName",
    });
  });

  it("не YouTube и пустое — null", () => {
    expect(yt.resolveYoutube("https://example.com/feed.xml")).toBeNull();
    expect(yt.resolveYoutube("")).toBeNull();
    expect(yt.resolveYoutube("https://youtube.com.evil.com/channel/" + ID)).toBeNull();
  });
});

describe("youtubeFeedUrl", () => {
  it("находит channelId на странице", async () => {
    const html = `<html>...,"channelId":"${ID}",...</html>`;
    expect(await yt.youtubeFeedUrl("@x_user", async () => html)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`,
    );
  });

  it("не нашёл — понятная ошибка; не YouTube — null без загрузки", async () => {
    await expect(yt.youtubeFeedUrl("@x_user", async () => "<html></html>")).rejects.toThrow(
      "youtube_channel_not_found",
    );
    let called = false;
    expect(
      await yt.youtubeFeedUrl("https://example.com", async () => {
        called = true;
        return "";
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});
