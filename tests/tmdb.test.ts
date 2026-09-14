import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

// Изолируем storage до импорта модулей (tmdb → db → config читает MOONAPP_STORAGE).
beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-tmdb-"));
  process.env.MOONAPP_STORAGE = tmp;
});

async function tmdb() {
  return await import("../server/tmdb");
}

describe("tmdb — нормализация ответов TMDB", () => {
  it("normKind принимает movie/tv и отвергает прочее", async () => {
    const m = await tmdb();
    expect(m.normKind("movie")).toBe("movie");
    expect(m.normKind("Movies")).toBe("movie");
    expect(m.normKind("tv")).toBe("tv");
    expect(m.normKind("series")).toBe("tv");
    expect(() => m.normKind("book")).toThrow();
  });

  it("imageUrl строит ссылку на CDN TMDB", async () => {
    const m = await tmdb();
    expect(m.imageUrl("/abc.jpg")).toContain("image.tmdb.org/t/p/w500/abc.jpg");
    expect(m.imageUrl(null)).toBeNull();
  });

  it("toSummary маппит фильм", async () => {
    const m = await tmdb();
    const s = m.toSummary("movie", {
      id: 550, title: "Fight Club", original_title: "Fight Club", overview: "x",
      poster_path: "/p.jpg", backdrop_path: "/b.jpg", release_date: "1999-10-15",
      vote_average: 8.4, vote_count: 100, genre_ids: [18], adult: false,
    });
    expect(s.kind).toBe("movie");
    expect(s.id).toBe(550);
    expect(s.title).toBe("Fight Club");
    expect(s.year).toBe(1999);
    expect(s.poster).toContain("/p.jpg");
    expect(s.genreIds).toEqual([18]);
    expect(s.voteAverage).toBeCloseTo(8.4);
  });

  it("toSummary маппит сериал (name / first_air_date)", async () => {
    const m = await tmdb();
    const s = m.toSummary("tv", {
      id: 1399, name: "Game of Thrones", original_name: "Game of Thrones",
      first_air_date: "2011-04-17", vote_average: 8.4, genre_ids: [10765],
    });
    expect(s.title).toBe("Game of Thrones");
    expect(s.year).toBe(2011);
    expect(s.kind).toBe("tv");
  });

  it("ageRatingOf берёт сертификат по региону и фолбэк на US", async () => {
    const m = await tmdb();
    const movie = {
      release_dates: {
        results: [
          { iso_3166_1: "US", release_dates: [{ certification: "R" }] },
          { iso_3166_1: "RU", release_dates: [{ certification: "" }, { certification: "18+" }] },
        ],
      },
    };
    expect(m.ageRatingOf("movie", movie, "RU")).toBe("18+");
    expect(m.ageRatingOf("movie", movie, "DE")).toBe("R");
    const tv = { content_ratings: { results: [{ iso_3166_1: "RU", rating: "16+" }] } };
    expect(m.ageRatingOf("tv", tv, "RU")).toBe("16+");
  });

  it("pickTrailer предпочитает Trailer среди YouTube-видео", async () => {
    const m = await tmdb();
    const v = {
      results: [
        { site: "YouTube", key: "t1", type: "Teaser" },
        { site: "YouTube", key: "t2", type: "Trailer" },
        { site: "Vimeo", key: "v1", type: "Trailer" },
      ],
    };
    expect(m.pickTrailer(v).key).toBe("t2");
  });

  it("providersOf собирает площадки региона", async () => {
    const m = await tmdb();
    const raw = {
      "watch/providers": {
        results: {
          RU: {
            link: "https://example/x",
            flatrate: [{ provider_id: 1, provider_name: "Net", logo_path: "/l.png", display_priority: 1 }],
          },
        },
      },
    };
    const p = m.providersOf(raw, "RU");
    expect(p.link).toBe("https://example/x");
    expect(p.flatrate[0].name).toBe("Net");
    expect(p.rent).toEqual([]);
    expect(p.buy).toEqual([]);
  });

  it("toDetails собирает каст, трейлер, жанры, галерею и площадки", async () => {
    const m = await tmdb();
    const raw = {
      id: 550, title: "Fight Club", release_date: "1999-10-15",
      runtime: 139, status: "Released", budget: 63000000, revenue: 100000000,
      genres: [{ id: 18, name: "Drama" }],
      credits: {
        cast: [{ id: 1, name: "Brad", character: "Tyler", profile_path: "/b.jpg" }],
        crew: [{ id: 2, name: "Fincher", job: "Director", department: "Directing", profile_path: null }],
      },
      videos: { results: [{ site: "YouTube", key: "abc", type: "Trailer", name: "T" }] },
      images: { backdrops: [{ file_path: "/bd.jpg" }], posters: [{ file_path: "/pp.jpg" }] },
      similar: { results: [{ id: 1, title: "S" }] },
      recommendations: { results: [] },
      "watch/providers": { results: { RU: { link: "https://x", flatrate: [] } } },
      release_dates: { results: [{ iso_3166_1: "RU", release_dates: [{ certification: "18+" }] }] },
      content_ratings: { results: [] },
      external_ids: { imdb_id: "tt0137523" },
    };
    const d = m.toDetails("movie", raw, "RU");
    expect(d.runtime).toBe(139);
    expect(d.budget).toBe(63000000);
    expect(d.cast[0].character).toBe("Tyler");
    expect(d.crew[0].job).toBe("Director");
    expect(d.trailer?.key).toBe("abc");
    expect(d.gallery.backdrops[0]).toContain("/bd.jpg");
    expect(d.similar.length).toBe(1);
    expect(d.ageRating).toBe("18+");
    expect(d.imdbId).toBe("tt0137523");
    expect(d.providers.region).toBe("RU");
  });

  it("_isBearer распознаёт v4 Read Access Token", async () => {
    const m = await tmdb();
    expect(m._isBearer("eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(true);
    expect(m._isBearer("abc123def456")).toBe(false);
  });

  it("hasKey = false без сохранённого секрета", async () => {
    const m = await tmdb();
    expect(m.hasKey()).toBe(false);
  });

  it("details без ключа бросает no_api_key", async () => {
    const m = await tmdb();
    await expect(m.details("movie", 550)).rejects.toMatchObject({ code: "no_api_key" });
  });
});