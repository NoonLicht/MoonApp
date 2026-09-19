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

/** Приложение с роутером movies и per-page middleware (как в server/index.js). */
async function bootTracker() {
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
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, body };
  };
  // Тесты трекера ниже написаны про phpBB-площадку (rutracker: вход, cp1251,
  // tracker.php), а трекер ПО УМОЛЧАНИЮ в приложении — rutor. Переключаем явно,
  // чтобы проверки не зависели от пресета по умолчанию.
  await call("/tracker/preset", { method: "POST", body: JSON.stringify({ id: "rutracker" }) });
  return { server, call, base };
}

describe("movies — форум-трекер: Cloudflare и импорт куки", () => {
  it("tracker/cookies: пустая строка → 400, валидная → куки в сессии (значения не отдаём)", async () => {
    const { server, call } = await bootTracker();
    try {
      const empty = await call("/tracker/cookies", {
        method: "POST",
        body: JSON.stringify({ cookies: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("bad_query");

      const ok = await call("/tracker/cookies", {
        method: "POST",
        body: JSON.stringify({ cookies: "cf_clearance=abc; cf_bm=xyz" }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.cookies.sort()).toEqual(["cf_bm", "cf_clearance"]);
      expect(ok.body.status.cookieNames).toContain("cf_clearance");
      // Наружу уходят только ИМЕНА куки: значения — секрет сессии форума.
      expect(JSON.stringify(ok.body)).not.toContain("abc");

      // Кнопка «Сбросить вход»: сессия форума удаляется, статус больше не «вошли»,
      // а кэш результатов очищается (иначе поиск отдал бы выдачу прошлой сессии).
      const out = await call("/tracker/logout", { method: "POST" });
      expect(out.status).toBe(200);
      expect(out.body.ok).toBe(true);
      const after = await call("/tracker/status");
      expect(after.body.cookieNames).toEqual([]);
      expect(after.body.session.ok).toBe(false);
      const fresh = await call("/tracker/search", {
        method: "POST",
        body: JSON.stringify({ query: "матрица" }),
      });
      expect(fresh.status).toBe(400); // секретов нет — без входа поиск не идёт из кэша
      expect(fresh.body.code).toBe("no_credentials");
    } finally {
      server.close();
    }
  });
});

describe("movies — форум-трекер и дорожки (валидация и понятные ошибки)", () => {
  it("tracker/status: флаги трекера и ffmpeg, без пароля", async () => {
    const { server, call } = await bootTracker();
    try {
      const r = await call("/tracker/status");
      expect(r.status).toBe(200);
      expect(r.body.baseUrl).toBe("https://rutracker.org");
      expect(typeof r.body.hasCredentials).toBe("boolean");
      expect(typeof r.body.ffmpeg).toBe("boolean");
      expect(typeof r.body.session.ok).toBe("boolean");
      expect(JSON.stringify(r.body)).not.toContain("password");
    } finally {
      server.close();
    }
  });

  it("tracker/search: пустой запрос и отсутствие ключей — понятные 400", async () => {
    const { server, call } = await bootTracker();
    try {
      const empty = await call("/tracker/search", {
        method: "POST",
        body: JSON.stringify({ query: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("bad_query");

      // В тестовом storage секретов нет → в сеть не ходим.
      const noCreds = await call("/tracker/search", {
        method: "POST",
        body: JSON.stringify({ query: "матрица" }),
      });
      expect(noCreds.status).toBe(400);
      expect(noCreds.body.code).toBe("no_credentials");
    } finally {
      server.close();
    }
  });

  it("tracker/config: адрес проверяется, корректный сохраняется", async () => {
    const { server, call } = await bootTracker();
    try {
      const bad = await call("/tracker/config", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "rutracker.org" }),
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_query");

      const ok = await call("/tracker/config", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "https://rutracker.org/", minIntervalMs: 900 }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.status.baseUrl).toBe("https://rutracker.org"); // без хвостового слеша

      const st = await call("/tracker/status");
      expect(st.body.baseUrl).toBe("https://rutracker.org");
    } finally {
      server.close();
    }
  });
it("tracker/preset: переключает площадку целиком, неизвестный id → 400", async () => {
    const { server, call } = await bootTracker();
    try {
      const bad = await call("/tracker/preset", {
        method: "POST",
        body: JSON.stringify({ id: "nnmclub" }),
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_query");

      const rutor = await call("/tracker/preset", {
        method: "POST",
        body: JSON.stringify({ id: "rutor" }),
      });
      expect(rutor.status).toBe(200);
      expect(rutor.body.engine).toBe("rutor");
      // Пресет применён целиком: адрес, движок и «вход не нужен».
      expect(rutor.body.status.baseUrl).toBe("https://rutor.info");
      expect(rutor.body.status.engine).toBe("rutor");
      expect(rutor.body.status.requiresLogin).toBe(false);
      expect(rutor.body.status.session.ok).toBe(true);

      const st = await call("/tracker/status");
      expect(st.body.baseUrl).toBe("https://rutor.info");
      // Порядок пресетов задаёт бэкенд: первым идёт трекер по умолчанию (rutor).
      expect(st.body.presets.map((p: { id: string }) => p.id)).toEqual(["rutor", "rutracker"]);
    } finally {
      // Возвращаем rutracker: дальше по файлу ждут его адреса и поведение.
      await call("/tracker/preset", { method: "POST", body: JSON.stringify({ id: "rutracker" }) });
      server.close();
    }
  });

  it("tracker/add: битый id → bad_release (валидация до сети)", async () => {
    const { server, call } = await bootTracker();
    try {
      const r = await call("/tracker/add", { method: "POST", body: JSON.stringify({ id: "abc" }) });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("bad_release");
    } finally {
      server.close();
    }
  });

  it("torrent/files: без источника → bad_source", async () => {
    const { server, call } = await bootTracker();
    try {
      const r = await call("/torrent/files", { method: "POST", body: JSON.stringify({}) });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("bad_source");
    } finally {
      server.close();
    }
  });

  it("torrent/select и ресурсные пути: строгая валидация параметров", async () => {
    const { server, call } = await bootTracker();
    try {
      const sel = await call("/torrent/select", {
        method: "POST",
        body: JSON.stringify({ infoHash: "не-hex", index: 0 }),
      });
      expect(sel.status).toBe(400);
      expect(sel.body.code).toBe("bad_source");

      const badHash = "zz".repeat(20);
      for (const u of [
        `/torrent/tracks/${badHash}/0`,
        `/torrent/remux/${badHash}/0`,
        `/torrent/subtitles/${badHash}/0?track=0`,
        `/torrent/stream/${badHash}/0`,
      ]) {
        const r = await call(u);
        expect(r.status, u).toBe(400);
        expect(r.body.code, u).toBe("bad_source");
      }

      const badIndex = `/torrent/tracks/${"a".repeat(40)}/-1`;
      const r2 = await call(badIndex);
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe("bad_file");
    } finally {
      server.close();
    }
  });

  it("torrent/tracks и subtitles: торрент не добавлен → 404 no_torrent", async () => {
    const { server, call } = await bootTracker();
    try {
      const hash = "0123456789abcdef0123456789abcdef01234567";
      const tracks = await call(`/torrent/tracks/${hash}/0`);
      expect(tracks.status).toBe(404);
      expect(tracks.body.code).toBe("no_torrent");

      const subs = await call(`/torrent/subtitles/${hash}/0?track=0`);
      expect(subs.status).toBe(404);
      expect(subs.body.code).toBe("no_torrent");
    } finally {
      server.close();
    }
  });

  it("torrent/remux: aligned=1 и start= (точный seek) проходят валидацию роута", async () => {
    const { server, call } = await bootTracker();
    try {
      // Хэш валиден, раздачи нет → 404 no_torrent. Главное здесь — что параметры
      // (start с тремя знаками, aligned) проходят валидацию: расхождение секунд
      // между клиентом и сервером давало рассинхрон звука, а лишний query не
      // должен валить запрос. Перемотка теперь всегда перекодирует видео
      // (exactSeekVideoMode), поэтому проверяем и video=copy, и video=h264.
      const hash = "0123456789abcdef0123456789abcdef01234567";
      const aligned = await call(`/torrent/remux/${hash}/0?start=1173.673&aligned=1`);
      expect(aligned.status).toBe(404);
      expect(aligned.body.code).toBe("no_torrent");

      // video=copy при перемотке: сервер сам поднимет режим до перекодирования.
      const copy = await call(`/torrent/remux/${hash}/0?start=60&video=copy`);
      expect(copy.status).toBe(404);
      expect(copy.body.code).toBe("no_torrent");

      // seek: at — секунда, copy=0 — точный seek (перекодирование), copy=1 — копирование.
      const seekExact = await call(`/torrent/seek/${hash}/0?at=1173.673&copy=0`);
      expect(seekExact.status).toBe(404);
      expect(seekExact.body.code).toBe("no_torrent");
      const seekCopy = await call(`/torrent/seek/${hash}/0?at=1173.673&copy=1`);
      expect(seekCopy.status).toBe(404);
      expect(seekCopy.body.code).toBe("no_torrent");
    } finally {
      server.close();
    }
  });
});
