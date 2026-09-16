import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/torrent, переведённого на TS (server/ts/torrent.ts →
 * server/torrent.js).
 *
 * Движок подключается лениво, поэтому проверяем именно «холодное» поведение:
 * MIME для <video>, понятные коды ошибок (no_torrent/no_metadata/bad_file) до
 * запуска клиента и то, что модуль остаётся CommonJS. Реальную загрузку
 * торрентов покрывают роут-тесты (tests/movies.test.ts).
 */
const req = createRequire(import.meta.url);

let torrent: any;

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-torrent-"));
  torrent = req("../server/torrent");
});

describe("server/torrent — MIME и форма модуля", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(torrent.default).toBeUndefined();
    expect(typeof torrent.add).toBe("function");
    expect(typeof torrent.createReadStream).toBe("function");
  });

  it("MIME для видео/аудио и субтитров (нужен <video>)", () => {
    expect(torrent.mimeOf("film.mkv")).toBe("video/x-matroska");
    expect(torrent.mimeOf("FILM.MP4")).toBe("video/mp4");
    expect(torrent.mimeOf("sub.srt")).toBe("application/x-subrip");
    expect(torrent.mimeOf("track.flac")).toBe("audio/flac");
  });

  it("неизвестное расширение → application/octet-stream (в т.ч. пустое имя)", () => {
    expect(torrent.mimeOf("readme.txt")).toBe("application/octet-stream");
    expect(torrent.mimeOf("")).toBe("application/octet-stream");
    expect(torrent.mimeOf(undefined)).toBe("application/octet-stream");
  });
});

describe("server/torrent — холодное состояние без клиента", () => {
  it("engineStatus сообщает только признак установки, без запуска клиента", () => {
    const st = torrent.engineStatus();
    expect(typeof st.installed).toBe("boolean");
    if (st.installed) expect(st.client).toBe(false);
    else expect(typeof st.error).toBe("string");
  });

  it("status/remove/active без клиента не падают", () => {
    expect(torrent.status("0123456789abcdef0123456789abcdef01234567")).toBeNull();
    expect(torrent.remove("0123456789abcdef0123456789abcdef01234567")).toEqual({ removed: false });
    expect(torrent.active()).toEqual([]);
  });

  it("createReadStream до запуска клиента даёт код no_torrent (а не сырое исключение)", () => {
    try {
      torrent.createReadStream("0123456789abcdef0123456789abcdef01234567", 0);
      throw new Error("ожидалось исключение");
    } catch (e: any) {
      expect(e.code).toBe("no_torrent");
    }
  });

  it("_reset без клиента безопасен (используется в тестах и при перезапуске)", () => {
    expect(() => torrent._reset()).not.toThrow();
  });
});
