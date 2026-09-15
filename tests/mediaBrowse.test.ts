import { describe, it, expect } from "vitest";
import {
  AUTO_LOAD_LIMIT, canAutoLoad, formatCount, hasNextPage, mediaKey, mergePage, nextPage,
} from "../src/components/media/browsePaging";
import type { MediaSummary } from "../src/api/types";

/** Минимальная карточка: для склейки страниц важен только kind+id. */
function item(kind: MediaSummary["kind"], id: number): MediaSummary {
  return {
    kind, id, title: `T${id}`, originalTitle: `T${id}`, overview: "",
    poster: null, backdrop: null, year: 2000, date: null,
    voteAverage: 7, voteCount: 10, popularity: 1, genreIds: [], adult: false,
  };
}

describe("browsePaging — подкачка длинных списков TMDB", () => {
  it("mediaKey различает фильм и сериал с одинаковым id", () => {
    expect(mediaKey(item("movie", 550))).toBe("movie-550");
    expect(mediaKey(item("tv", 550))).toBe("tv-550");
  });

  it("mergePage дописывает новую страницу, сохраняя порядок", () => {
    const first = [item("movie", 1), item("movie", 2)];
    const merged = mergePage(first, [item("movie", 3)]);
    expect(merged.map((i) => i.id)).toEqual([1, 2, 3]);
    // Исходный массив не мутируем — иначе React не увидит изменения.
    expect(first.map((i) => i.id)).toEqual([1, 2]);
  });

  it("mergePage отбрасывает повторы (страницы TMDB пересекаются)", () => {
    const first = [item("movie", 1), item("movie", 2)];
    const merged = mergePage(first, [item("movie", 2), item("movie", 3), item("movie", 3)]);
    expect(merged.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("hasNextPage/nextPage знают про последнюю страницу", () => {
    expect(hasNextPage(1, 3)).toBe(true);
    expect(nextPage(1, 3)).toBe(2);
    expect(hasNextPage(3, 3)).toBe(false);
    // Дальше последней страницы не уходим.
    expect(nextPage(3, 3)).toBe(3);
    // Битый totalPages (0/NaN) не должен ломать кнопку.
    expect(hasNextPage(1, 0)).toBe(false);
  });

  it("canAutoLoad останавливает бесконечную догрузку на потолке", () => {
    expect(canAutoLoad(20, 1, 100)).toBe(true);
    expect(canAutoLoad(0, 100, 100)).toBe(false);
    expect(canAutoLoad(AUTO_LOAD_LIMIT, 1, 100)).toBe(false);
    expect(canAutoLoad(AUTO_LOAD_LIMIT - 20, 1, 100)).toBe(true);
  });

  it("formatCount показывает разделитель разрядов для больших подборок", () => {
    expect(formatCount(10000, "ru")).toMatch(/^10[\s\u00a0]000$/);
    // Без локали — системная, но число всё равно строкой.
    expect(typeof formatCount(20)).toBe("string");
    expect(formatCount(Number.NaN, "ru")).toBe("0");
  });
});
