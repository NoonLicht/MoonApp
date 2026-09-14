import { describe, it, expect } from "vitest";
import { imgUrl, imgCssUrl } from "../src/components/media/mediaImg";

/**
 * Картинки TMDB должны уходить через прокси приложения (/api/movies/image):
 * Chromium грузит image.tmdb.org напрямую, минуя per-page прокси, поэтому на
 * сетях с блокировкой TMDB постеры падали с ERR_CONNECTION_REFUSED (а в сборке
 * их дополнительно резал CSP img-src 'self').
 */
describe("mediaImg — проксирование картинок TMDB", () => {
  it("абсолютную ссылку TMDB превращает в прокси-URL с size и path", () => {
    const out = imgUrl("https://image.tmdb.org/t/p/w500/tUHzcIOt5miEdgDyV6PJdFNTp3N.jpg");
    expect(out).toBe("/api/movies/image?s=w500&p=%2FtUHzcIOt5miEdgDyV6PJdFNTp3N.jpg");
    expect(out).not.toContain("image.tmdb.org");
  });

  it("поддерживает любой размер, включая original (логотипы площадок)", () => {
    expect(imgUrl("https://image.tmdb.org/t/p/original/abc.png")).toBe("/api/movies/image?s=original&p=%2Fabc.png");
    expect(imgUrl("https://image.tmdb.org/t/p/w1280/b9q9VmbXDvJmTziRqkwdEmFdwhr.jpg")).toContain("s=w1280");
  });

  it("идемпотентен: уже проксированный URL не переписывает", () => {
    const once = imgUrl("https://image.tmdb.org/t/p/w500/x.jpg");
    expect(imgUrl(once)).toBe(once);
  });

  it("не трогает нетематографические и внешние ссылки", () => {
    expect(imgUrl("https://example.com/local/poster.jpg")).toBe("https://example.com/local/poster.jpg");
    expect(imgUrl("/assets/placeholder.png")).toBe("/assets/placeholder.png");
  });

  it("пустое значение → пустая строка (удобно для `{url && <img/>}`)", () => {
    expect(imgUrl(null)).toBe("");
    expect(imgUrl(undefined)).toBe("");
    expect(imgUrl("")).toBe("");
  });

  it("imgCssUrl отдаёт готовое значение для background-image", () => {
    expect(imgCssUrl("https://image.tmdb.org/t/p/w1280/bd.jpg")).toBe('url("/api/movies/image?s=w1280&p=%2Fbd.jpg")');
    expect(imgCssUrl(null)).toBe("none");
  });
});