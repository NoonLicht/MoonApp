import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { imgUrl } from "../src/components/media/mediaImg";

/**
 * /api/movies/image — прокси картинок TMDB (server/routes/movies.js + server/tmdb.js).
 *
 * Сеть не трогаем: в тестах per-page прокси не настроен, поэтому tmdb.js идёт
 * «прямой» ветвью и обращается к глобальному fetch — его мы и подменяем фейковым
 * CDN. Реальный fetch сохраняем отдельно: он нужен для вызовов тестового сервера.
 * Если код попробует сходить на посторонний адрес, тест это увидит в аргументах.
 */

const realFetch = globalThis.fetch;
/** Фейковый image.tmdb.org. */
const cdn = vi.fn();

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-movies-img-"));
  process.env.MOONAPP_STORAGE = tmp;
  vi.stubGlobal("fetch", cdn);
});

/** Картинка-заглушка (минимальный JPEG-заголовок). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** CDN отвечает валидной картинкой. */
function cdnOk() {
  cdn.mockReset();
  cdn.mockImplementation(async () => new Response(JPEG, {
    status: 200, headers: { "content-type": "image/jpeg" },
  }));
}

/** Поднять приложение с роутером movies (как в server/index.js). */
async function boot() {
  const router = (await import("../server/routes/movies")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/movies", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  /** Запрос картинки: статус + заголовки + байты. */
  const get = async (query: string, headers: Record<string, string> = {}) => {
    const res = await realFetch(`http://127.0.0.1:${port}/api/movies/image${query}`, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  };
  /** Ожидание JSON-ошибки (тело читаем как JSON). */
  const getJson = async (query: string) => {
    const res = await realFetch(`http://127.0.0.1:${port}/api/movies/image${query}`);
    return { status: res.status, body: (await res.json()) as { code?: string } };
  };
  return { server, get, getJson };
}

describe("GET /api/movies/image", () => {
  it("валидный запрос → картинка из TMDB, кэш-заголовки и ETag", async () => {
    cdnOk();
    const { server, get } = await boot();
    try {
      const r = await get("/?s=w500&p=%2FtUHzcIOt5miEdgDyV6PJdFNTp3N.jpg");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/jpeg");
      expect(r.headers.get("cache-control")).toContain("max-age=604800");
      expect(r.headers.get("etag")).toBeTruthy();
      expect(r.headers.get("x-moon-img")).toBe("miss"); // первый раз — из сети
      expect(Buffer.compare(r.buf, JPEG)).toBe(0);
      // Ходили ровно на CDN TMDB и с нужным размером/путём.
      expect(cdn).toHaveBeenCalledTimes(1);
      expect(String(cdn.mock.calls[0][0])).toBe("https://image.tmdb.org/t/p/w500/tUHzcIOt5miEdgDyV6PJdFNTp3N.jpg");

      // Повторный запрос — из LRU-кэша, в сеть не ходим.
      const again = await get("/?s=w500&p=%2FtUHzcIOt5miEdgDyV6PJdFNTp3N.jpg");
      expect(again.status).toBe(200);
      expect(again.headers.get("x-moon-img")).toBe("hit");
      expect(cdn).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  it("размер не указан → берётся w500 (постер по умолчанию)", async () => {
    cdnOk();
    const { server, get } = await boot();
    try {
      const r = await get("/?p=%2Fdefault-size.jpg");
      expect(r.status).toBe(200);
      expect(String(cdn.mock.calls[0][0])).toBe("https://image.tmdb.org/t/p/w500/default-size.jpg");
    } finally {
      server.close();
    }
  });

  it("If-None-Match с тем же ETag → 304 без тела и без похода в сеть", async () => {
    cdnOk();
    const { server, get } = await boot();
    try {
      const first = await get("/?s=w342&p=%2Fetag.jpg");
      const etag = String(first.headers.get("etag"));
      expect(etag.length).toBeGreaterThan(2);
      cdn.mockClear();
      const second = await get("/?s=w342&p=%2Fetag.jpg", { "if-none-match": etag });
      expect(second.status).toBe(304);
      expect(second.buf.length).toBe(0);
      expect(cdn).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("размер вне allowlist → 400 bad_size без похода в сеть", async () => {
    cdnOk();
    const { server, getJson } = await boot();
    try {
      for (const q of ["/?s=w999&p=%2Fa.jpg", "/?s=original2&p=%2Fa.jpg", "/?s=w5000&p=%2Fa.jpg"]) {
        const r = await getJson(q);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe("bad_size");
      }
      expect(cdn).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("подозрительный путь → 400 bad_path (нет SSRF и выхода из каталога)", async () => {
    cdnOk();
    const { server, getJson } = await boot();
    try {
      const cases = [
        "/?s=w500",                              // путь не передан
        "/?s=w500&p=",                           // пустой путь
        "/?s=w500&p=..%2F..%2Fsecret",           // выход из каталога
        "/?s=w500&p=http%3A%2F%2Fevil.com%2Fx.jpg", // абсолютный URL
        "/?s=w500&p=%2F%2Fevil.com%2Fx.jpg",     // protocol-relative
        "/?s=w500&p=%2Fa.jpg%3Fsize%3D999",      // свои query-параметры
      ];
      for (const q of cases) {
        const r = await getJson(q);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe("bad_path");
      }
      expect(cdn).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("CDN недоступен → 502 image_unavailable", async () => {
    cdn.mockReset();
    cdn.mockImplementation(async () => { throw new Error("ENETUNREACH"); });
    const { server, getJson } = await boot();
    try {
      const r = await getJson("/?s=w500&p=%2Fblocked-network.jpg");
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("image_unavailable");
    } finally {
      server.close();
    }
  });

  it("CDN отвечает ошибкой → 502 image_unavailable", async () => {
    cdn.mockReset();
    cdn.mockImplementation(async () => new Response("nope", { status: 404 }));
    const { server, getJson } = await boot();
    try {
      const r = await getJson("/?s=w780&p=%2Fmissing.jpg");
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("image_unavailable");
    } finally {
      server.close();
    }
  });

  it("контракт с фронтом: URL из imgUrl() принимается бэкендом и ведёт на TMDB-CDN", async () => {
    cdnOk();
    const { server, get } = await boot();
    try {
      // Фронт строит прокси-URL из абсолютной ссылки TMDB — проверяем, что
      // параметры кодируются и читаются согласованно.
      const proxy = imgUrl("https://image.tmdb.org/t/p/w185/profile.jpg");
      const qs = new URL(proxy, "http://127.0.0.1").search;
      const r = await get(qs);
      expect(r.status).toBe(200);
      expect(String(cdn.mock.calls[0][0])).toBe("https://image.tmdb.org/t/p/w185/profile.jpg");
    } finally {
      server.close();
    }
  });
});