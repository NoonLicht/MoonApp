import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Сетевые списки server/tmdb (server/ts/tmdb.ts → server/tmdb.js).
 *
 * Сеть не трогаем: подменяем глобальный fetch фейковым TMDB и смотрим, что модуль
 * отправляет в запросе (путь, язык, ключ, фильтры) и что отдаёт фронту (элементы,
 * счётчик страниц, регион, фильтр 18+). Ключ кладём в секреты — иначе модуль честно
 * бросает no_api_key, и эту ветку проверяет tests/tmdb.test.ts.
 */
const req = createRequire(import.meta.url);
const realFetch = globalThis.fetch;
const api = vi.fn();

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-tmdb-list-"));
  process.env.MOONAPP_STORAGE = tmp;
  req("../server/security").setSecret("tmdb", "test-api-key");
  vi.stubGlobal("fetch", api);
});

afterAll(() => {
  vi.stubGlobal("fetch", realFetch);
});

/** Ответ TMDB заданным JSON (сбрасывает историю вызовов). */
function apiJson(json: unknown) {
  api.mockReset();
  api.mockImplementation(
    async () =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** URL последнего запроса к TMDB, декодированный ради читаемых параметров. */
function lastUrl(): string {
  return decodeURIComponent(String(api.mock.calls[api.mock.calls.length - 1][0]));
}

/** Краткая карточка в формате TMDB. */
function rawMovie(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Dune",
    original_title: "Dune",
    release_date: "2021-10-22",
    adult: false,
    ...over,
  };
}
describe("tmdb — форма модуля и сетевые списки", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    const m = req("../server/tmdb");
    expect(m.default).toBeUndefined();
    for (const fn of [
      "trending",
      "list",
      "search",
      "details",
      "genres",
      "discover",
      "watchProviders",
      "pageInfo",
      "imageKey",
      "fetchImage",
      "clearCache",
      "hasKey",
    ]) {
      expect(typeof m[fn], fn).toBe("function");
    }
  });

  it("trending: v3-ключ уходит в query, 18+ отфильтрован, регион из настроек", async () => {
    apiJson({
      page: 1,
      total_pages: 5,
      total_results: 100,
      results: [rawMovie(), rawMovie({ id: 2, title: "Adult", adult: true })],
    });
    const m = await import("../server/tmdb");
    const r = await m.trending("movie", "week", 1);
    expect(lastUrl()).toContain("/trending/movie/week");
    expect(lastUrl()).toContain("api_key=test-api-key");
    expect(lastUrl()).toContain("language=ru-RU");
    expect(r.items.map((i: { id: number }) => i.id)).toEqual([1]);
    expect(r.totalResults).toBe(100);
    expect(r.totalPages).toBe(5);
    expect(r.region).toBe("RU");
  });

  it("list: категория возвращается эхом, недопустимая — откат на popular", async () => {
    apiJson({ page: 1, total_pages: 1, total_results: 0, results: [] });
    const m = await import("../server/tmdb");
    expect((await m.list("movie", "upcoming", 1)).category).toBe("upcoming");
    // «upcoming» есть только у фильмов: для сериалов это опечатка → popular.
    const bad = await m.list("tv", "upcoming", 2);
    expect(bad.category).toBe("popular");
    expect(lastUrl()).toContain("/tv/popular");
  });

  it("search: пустой запрос не ходит в сеть, персоны отфильтрованы", async () => {
    const m = await import("../server/tmdb");
    apiJson({});
    const empty = await m.search("   ");
    expect(empty).toEqual({ items: [], page: 1, totalPages: 1, totalResults: 0 });
    expect(api).not.toHaveBeenCalled();

    apiJson({
      page: 1,
      total_pages: 1,
      total_results: 2,
      results: [rawMovie(), { id: 9, media_type: "person", name: "Someone" }],
    });
    const r = await m.search("dune", "multi", 3);
    expect(lastUrl()).toContain("/search/multi");
    expect(lastUrl()).toContain("include_adult=false");
    expect(r.items.map((i: { id: number }) => i.id)).toEqual([1]);
  });

  it("genres и watchProviders отдают ответ TMDB, регион — из настроек", async () => {
    const m = await import("../server/tmdb");
    apiJson({ genres: [{ id: 18, name: "Drama" }] });
    expect(await m.genres("movie")).toEqual({ genres: [{ id: 18, name: "Drama" }] });
    expect(lastUrl()).toContain("/genre/movie/list");

    apiJson({ results: { RU: { link: "https://tmdb/x", flatrate: [] } } });
    const p = await m.watchProviders("tv", 1399);
    expect(lastUrl()).toContain("/tv/1399/watch/providers");
    expect(p.link).toBe("https://tmdb/x");
    expect(p.region).toBe("RU");
  });

  it("discover: год и vote_count зависят от типа и сортировки", async () => {
    const m = await import("../server/tmdb");
    apiJson({ page: 1, total_pages: 1, total_results: 0, results: [rawMovie()] });
    await m.discover("movie", { genre: 18, year: 1999, page: 4 });
    expect(lastUrl()).toContain("/discover/movie");
    expect(lastUrl()).toContain("with_genres=18");
    expect(lastUrl()).toContain("primary_release_year=1999");
    expect(lastUrl()).toContain("sort_by=popularity.desc");
    expect(lastUrl()).not.toContain("vote_count.gte");

    apiJson({ page: 5, total_pages: 2, total_results: 10, results: [] });
    await m.discover("tv", { year: 2011, page: 5, sort: "vote_average.desc" });
    expect(lastUrl()).toContain("/discover/tv");
    expect(lastUrl()).toContain("first_air_date_year=2011");
    expect(lastUrl()).toContain("vote_count.gte=200");
  });

  it("кэш настроек (cacheMinutes) глушит повторный запрос той же страницы", async () => {
    apiJson({ page: 2, total_pages: 9, total_results: 180, results: [rawMovie({ id: 7 })] });
    const m = await import("../server/tmdb");
    const first = await m.trending("movie", "day", 2);
    expect(api).toHaveBeenCalledTimes(1);
    api.mockReset();
    const second = await m.trending("movie", "day", 2);
    expect(api).not.toHaveBeenCalled();
    expect(second.items.map((i: { id: number }) => i.id)).toEqual([7]);
    expect(second.page).toBe(first.page);
  });
});
