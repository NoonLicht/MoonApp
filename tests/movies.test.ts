import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import path from "path";
import fs from "fs";
import os from "os";

// Изолируем storage до импорта серверных модулей.
beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-movies-"));
  process.env.MOONAPP_STORAGE = tmp;
});

/** stmts из server/db после установки MOONAPP_STORAGE. */
async function dbStmts() {
  return (await import("../server/db")).stmts;
}

describe("movies — локальное хранилище", () => {
  it("watchlist: upsert → get → обновление статуса → delete", async () => {
    const s = await dbStmts();
    s.mwUpsert.run("movie", 550, {
      title: "Fight Club",
      poster: "p.jpg",
      year: 1999,
      status: "plan",
      genres: "[]",
    });
    expect(s.mwGet.get("movie", 550).title).toBe("Fight Club");
    expect(s.mwGet.get("movie", 550).status).toBe("plan");
    // Повторный upsert обновляет ту же запись, а не создаёт новую.
    s.mwUpsert.run("movie", 550, { title: "Fight Club", status: "watched" });
    expect(s.mwAll.all().filter((r) => r.kind === "movie" && r.tmdb_id === 550).length).toBe(1);
    expect(s.mwGet.get("movie", 550).status).toBe("watched");
    s.mwDelete.run("movie", 550);
    expect(s.mwGet.get("movie", 550)).toBeNull();
  });

  it("ratings: set → overwrite → delete", async () => {
    const s = await dbStmts();
    s.mrSet.run("movie", 550, "Fight Club", 9);
    expect(s.mrGet.get("movie", 550).rating).toBe(9);
    s.mrSet.run("movie", 550, "Fight Club", 10);
    expect(s.mrGet.get("movie", 550).rating).toBe(10);
    expect(s.mrAll.all().filter((r) => r.tmdb_id === 550).length).toBe(1);
    s.mrDelete.run("movie", 550);
    expect(s.mrGet.get("movie", 550)).toBeNull();
  });

  it("watch stats: одна запись на тайтл, msClear очищает", async () => {
    const s = await dbStmts();
    s.msUpsert.run("movie", 550, {
      title: "Fight Club",
      runtime: 139,
      progress: 1,
      minutes: 139,
      genres: JSON.stringify([{ name: "Drama" }]),
      cast: JSON.stringify([{ name: "Brad" }]),
    });
    expect(s.msAll.all().length).toBe(1);
    s.msUpsert.run("movie", 550, { title: "Fight Club", runtime: 139, progress: 0.5, minutes: 70 });
    expect(s.msAll.all().length).toBe(1);
    expect(s.msGet.get("movie", 550).minutes).toBe(70);
    s.msClear.run();
    expect(s.msAll.all().length).toBe(0);
  });

  it("кэш метаданных TMDB: set/get/clear", async () => {
    const s = await dbStmts();
    s.mmcSet.run("tmdb:/x", JSON.stringify({ a: 1 }));
    expect(JSON.parse(s.mmcGet.get("tmdb:/x").json).a).toBe(1);
    s.mmcClear.run();
    expect(s.mmcGet.get("tmdb:/x")).toBeNull();
  });
});

describe("movies — HTTP API", () => {
  /** Поднимает express-приложение с роутером и per-page middleware. */
  async function boot() {
    const ppr = await import("../server/middleware/perPageProxy");
    const router = (await import("../server/routes/movies")).default;
    const app = express();
    app.use(express.json());
    app.use(ppr.perPageProxyMiddleware);
    app.use("/api/movies", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/movies`;
    const H = { "Content-Type": "application/json", "x-app-page": "movies" };
    const call = async (u: string, init?: RequestInit) => {
      const res = await fetch(base + u, { headers: H, ...init });
      return { status: res.status, body: await res.json() };
    };
    return { server, call };
  }

  it("status / watchlist / rate / watch / library / stats / state", async () => {
    const { server, call } = await boot();
    try {
      const st = await call("/status");
      expect(st.status).toBe(200);
      expect(st.body.engine.installed).toBe(true);
      expect(typeof st.body.hasKey).toBe("boolean");

      // «Просмотрено» сразу пишет и в список, и в статистику.
      const wl = await call("/watchlist", {
        method: "POST",
        body: JSON.stringify({
          kind: "movie",
          id: 550,
          title: "Fight Club",
          runtime: 139,
          status: "watched",
          genres: [{ name: "Drama" }],
        }),
      });
      expect(wl.status).toBe(200);
      expect(wl.body.watchlist.status).toBe("watched");

      const rate = await call("/rate", {
        method: "POST",
        body: JSON.stringify({ kind: "movie", id: 550, title: "Fight Club", rating: 9 }),
      });
      expect(rate.body.rating.rating).toBe(9);

      // Отдельный тайтл с прогрессом (актёр попадёт в топ).
      await call("/watch", {
        method: "POST",
        body: JSON.stringify({
          kind: "movie",
          id: 551,
          title: "Other",
          runtime: 100,
          progress: 0.5,
          genres: ["Drama"],
          cast: [{ name: "Brad" }],
        }),
      });

      const lib = await call("/library");
      expect(lib.body.watchlist.length).toBeGreaterThan(0);
      expect(lib.body.ratings.length).toBeGreaterThan(0);

      const stats = await call("/stats");
      expect(stats.body.totalTitles).toBeGreaterThan(0);
      expect(stats.body.totalMinutes).toBeGreaterThan(0);
      expect(stats.body.topGenres.some((g: { name: string }) => g.name === "Drama")).toBe(true);
      expect(stats.body.topActors[0].name).toBe("Brad");

      const state = await call("/state/movie/550");
      expect(state.body.rating.rating).toBe(9);
      expect(state.body.watchlist.status).toBe("watched");

      // Без ключа TMDB — понятный код ошибки (для подсказки на фронте).
      const tr = await call("/trending?kind=movie");
      expect(tr.status).toBe(400);
      expect(tr.body.code).toBe("no_api_key");

      // Неверный тип медиа — 400.
      const bad = await call("/details/book/1");
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_kind");
    } finally {
      server.close();
    }
  });

  it("torrent: add отклоняет мусор, чужой infoHash → no_torrent", async () => {
    const { server, call } = await boot();
    try {
      const bad = await call("/torrent/add", {
        method: "POST",
        body: JSON.stringify({ magnet: "http://not-a-magnet" }),
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_source");

      const empty = await call("/torrent/add", { method: "POST", body: JSON.stringify({}) });
      expect(empty.status).toBe(400);

      const st = await call("/torrent/status/0123456789abcdef0123456789abcdef01234567");
      expect(st.status).toBe(404);
      expect(st.body.code).toBe("no_torrent");
    } finally {
      server.close();
    }
  });
});
