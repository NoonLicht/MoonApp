import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Реестр загрузок торрент-плеера (server/torrent): то, на чём держатся вкладка
 * «Скачанные», пауза/возобновление и галочка «хранить после просмотра».
 *
 * Сеть не трогаем: здесь проверяются именно записи реестра и работа с файлами на
 * диске (метафайл .torrent, папка раздачи), а сам webtorrent подключается лениво —
 * поэтому require модуля безопасен и без движка.
 */
const req = createRequire(import.meta.url);
let torrent: any;
let settings: any;
let storage: string;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-dl-"));
  process.env.MOONAPP_STORAGE = storage;
  torrent = req("../server/torrent");
  settings = req("../server/settings");
});

beforeEach(() => {
  // У каждого теста — чистая история загрузок.
  for (const d of torrent.listDownloads()) torrent.forgetDownload(d.infoHash);
});

const HASH = "a".repeat(40);
const HASH2 = "b".repeat(40);

/** Разложить «скачанную» раздачу: папка данных + .torrent-метафайл. */
function layOutFiles(hash: string, name: string): void {
  const dir = path.join(storage, "torrents", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "movie.mkv"), "data");
  fs.writeFileSync(path.join(storage, "torrents", "meta", hash + ".torrent"), "d8:announce");
}

describe("torrent — реестр загрузок", () => {
  it("галочка «хранить после просмотра» берётся из настроек, по умолчанию — да", () => {
    settings.set({ movies: { keepTorrentFiles: true } });
    expect(torrent.keepFilesByDefault()).toBe(true);
    settings.set({ movies: { keepTorrentFiles: false } });
    expect(torrent.keepFilesByDefault()).toBe(false);
  });

  it("запоминает раздачу, отдаёт живой список и не затирает поля пустыми значениями", () => {
    torrent.rememberDownload({
      infoHash: HASH,
      name: "Movie.2026",
      title: "Матрица",
      releaseId: "12345",
      magnet: "magnet:?xt=urn:btih:" + HASH,
      source: "tracker",
      length: 1024,
      kept: true,
    });
    // Второе добавление без названия/названия фильма: значения должны сохраниться.
    torrent.rememberDownload({ infoHash: HASH, name: "Movie.2026", state: "done" });

    const list = torrent.listDownloads();
    expect(list).toHaveLength(1);
    const d = list[0];
    expect(d.infoHash).toBe(HASH);
    expect(d.title).toBe("Матрица");
    expect(d.releaseId).toBe("12345");
    expect(d.source).toBe("tracker");
    expect(d.state).toBe("done");
    expect(d.kept).toBe(true);
    expect(d.active).toBe(false); // движка нет — живой прогресс отсутствует
    expect(d.progress).toBe(1); // state=done → считаем загруженным
  });

  it("поиск загрузки по названию фильма (для восстановления окна плеера)", () => {
    torrent.rememberDownload({ infoHash: HASH, name: "Movie.2026", title: "Матрица" });
    expect(torrent.downloadForTitle("матрица")?.infoHash).toBe(HASH);
    expect(torrent.downloadForTitle("  Матрица ")?.infoHash).toBe(HASH);
    expect(torrent.downloadForTitle("Другой фильм")).toBeNull();
    expect(torrent.downloadForTitle("")).toBeNull();
  });

  it("kept и position меняются поштучно", () => {
    torrent.rememberDownload({ infoHash: HASH, name: "M", kept: true });
    torrent.setDownloadKept(HASH, false);
    torrent.setDownloadPosition(HASH, 1234.7);
    const d = torrent.listDownloads()[0];
    expect(d.kept).toBe(false);
    expect(d.position).toBe(1234);
  });

  it("удаление раздачи стирает файлы, метафайл и запись реестра", () => {
    layOutFiles(HASH, "Movie.2026");
    torrent.rememberDownload({ infoHash: HASH, name: "Movie.2026", length: 4 });
    const out = torrent.purgeDownload(HASH, { files: true });
    expect(out).toEqual({ removed: true, files: true });
    expect(fs.existsSync(path.join(storage, "torrents", "Movie.2026"))).toBe(false);
    expect(fs.existsSync(path.join(storage, "torrents", "meta", HASH + ".torrent"))).toBe(false);
    expect(torrent.listDownloads()).toHaveLength(0);
  });

  it("purgeUnkept удаляет только завершённые раздачи без галочки «хранить»", () => {
    layOutFiles(HASH, "Keep");
    layOutFiles(HASH2, "Drop");
    torrent.rememberDownload({ infoHash: HASH, name: "Keep", kept: true, state: "done" });
    torrent.rememberDownload({ infoHash: HASH2, name: "Drop", kept: false, state: "done" });
    expect(torrent.purgeUnkept()).toBe(1);
    const rest = torrent.listDownloads();
    expect(rest.map((d: { infoHash: string }) => d.infoHash)).toEqual([HASH]);
    expect(fs.existsSync(path.join(storage, "torrents", "Keep"))).toBe(true);
    expect(fs.existsSync(path.join(storage, "torrents", "Drop"))).toBe(false);
  });

  it("возобновить нечего → понятная ошибка no_torrent, а не падение", async () => {
    // Хеш без метафайла и без magnet (в отличие от других тестов, файлов не кладём).
    const empty = "c".repeat(40);
    torrent.rememberDownload({ infoHash: empty, name: "NoFiles" });
    await expect(torrent.resumeDownload(empty)).rejects.toMatchObject({ code: "no_torrent" });
    await expect(torrent.resumeDownload("нет-хеша")).rejects.toMatchObject({ code: "bad_source" });
  });

  it("движок остаётся ленивым: статус не падает без webtorrent", () => {
    const st = torrent.engineStatus();
    expect(typeof st.installed).toBe("boolean");
    expect(typeof st.client).toBe("boolean");
  });

  it("таблица реестра объявлена в БД со всеми колонками, которые пишет torrent.ts", () => {
    // Контракт между server/ts/db.ts и server/ts/torrent.ts: insert() в сторе
    // пишет значения ПОЗИЦИОННО по объявленным колонкам, поэтому пропущенная или
    // переименованная колонка — тихая потеря данных, а не ошибка.
    const db = req("../server/db");
    const cols: string[] = db.tables.torrent_downloads.cols;
    expect(cols).toEqual([
      "info_hash",
      "name",
      "title",
      "release_id",
      "magnet",
      "source",
      "length",
      "state",
      "kept",
      "position",
      "added_at",
      "updated_at",
    ]);
    // Реестр переживает перезапуск: данные пишутся в storage/data.json (persist).
    expect(typeof db.stmts.tdUpsert.run).toBe("function");
    expect(typeof db.stmts.tdAll.all).toBe("function");
  });
});
/**
 * HTTP-часть реестра: маршруты, которыми пользуются вкладка «Скачанные» и плеер.
 * Проверяем валидацию и то, что настройки/реестр реально меняются.
 */
describe("movies — маршруты загрузок", () => {
  async function boot() {
    const ppr = await import("../server/middleware/perPageProxy");
    const router = (await import("../server/routes/movies")).default;
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    app.use(ppr.perPageProxyMiddleware);
    app.use("/api/movies", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const H = { "Content-Type": "application/json", "x-app-page": "movies" };
    const call = async (u: string, init?: RequestInit) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/movies${u}`, { headers: H, ...init });
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body };
    };
    return { server, call };
  }

  it("downloads: пустой реестр и значение галочки по умолчанию", async () => {
    const { server, call } = await boot();
    try {
      const r = await call("/torrent/downloads");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.items)).toBe(true);
      expect(typeof r.body.keepDefault).toBe("boolean");
    } finally {
      server.close();
    }
  });

  it("keep: saveDefault пишет настройку, position — валидирует infoHash", async () => {
    const { server, call } = await boot();
    try {
      const off = await call("/torrent/keep", {
        method: "POST",
        body: JSON.stringify({ keep: false, saveDefault: true }),
      });
      expect(off.status).toBe(200);
      expect(off.body.keepDefault).toBe(false);
      expect(settings.get("movies").keepTorrentFiles).toBe(false);

      const bad = await call("/torrent/position", {
        method: "POST",
        body: JSON.stringify({ infoHash: "нет", position: 10 }),
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_source");

      const ok = await call("/torrent/position", {
        method: "POST",
        body: JSON.stringify({ infoHash: HASH, position: 42 }),
      });
      expect(ok.status).toBe(200);
      // Позиция пишется в запись реестра (для неизвестной раздачи создавать её
      // роут не должен — это дело добавления раздачи).
      torrent.rememberDownload({ infoHash: HASH, name: "Positioned" });
      await call("/torrent/position", {
        method: "POST",
        body: JSON.stringify({ infoHash: HASH, position: 42 }),
      });
      expect(
        torrent.listDownloads().find((d: { infoHash: string }) => d.infoHash === HASH)?.position,
      ).toBe(42);

      // Возвращаем «хранить»: дальше по набору ожидается значение по умолчанию.
      await call("/torrent/keep", {
        method: "POST",
        body: JSON.stringify({ keep: true, saveDefault: true }),
      });
    } finally {
      server.close();
    }
  });

  it("stop/resume/cleanup/delete: неизвестная раздача — понятный ответ, а не 500", async () => {
    const { server, call } = await boot();
    try {
      const stop = await call("/torrent/stop", {
        method: "POST",
        body: JSON.stringify({ infoHash: HASH }),
      });
      expect(stop.status).toBe(200);
      expect(stop.body).toMatchObject({ stopped: false, state: "paused" });

      const resume = await call("/torrent/resume", {
        method: "POST",
        body: JSON.stringify({ infoHash: "мусор" }),
      });
      expect(resume.status).toBe(400);
      expect(resume.body.code).toBe("bad_source");

      const cleanup = await call("/torrent/cleanup", { method: "POST" });
      expect(cleanup.status).toBe(200);
      expect(typeof cleanup.body.purged).toBe("number");

      const delBad = await call("/torrent/не-хеш", { method: "DELETE" });
      expect(delBad.status).toBe(400);
      const delUnknown = await call(`/torrent/${HASH}`, { method: "DELETE" });
      expect(delUnknown.status).toBe(200);
      expect(delUnknown.body).toEqual({ removed: false, files: false });
    } finally {
      server.close();
    }
  });

  it("ffmpeg: путь/версия и куда искали (понятная подсказка, если не нашли)", async () => {
    const { server, call } = await boot();
    try {
      const r = await call("/ffmpeg");
      expect(r.status).toBe(200);
      expect(typeof r.body.ffmpeg).toBe("boolean");
      expect(typeof r.body.ffprobe).toBe("boolean");
      expect(Array.isArray(r.body.searched)).toBe(true);
      // Ищем в двух местах: storage/ffmpeg и PATH — список всегда непустой.
      expect(r.body.searched.length).toBeGreaterThan(0);
      if (!r.body.ffmpeg) expect(r.body.path).toBeNull();
    } finally {
      server.close();
    }
  });
});