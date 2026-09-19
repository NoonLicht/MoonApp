import { describe, it, expect } from "vitest";
import {
  fmtTime,
  isDirectPlayable,
  parseTime,
  releaseMetaLine,
  remuxUrl,
  subtitleUrl,
} from "@/pages/movies/lib/streamUrl";
import {
  clampSeek,
  directStreamUrl,
  exactSeekLevel,
  fitVideoBox,
  lastRetryLevel,
  playbackMode,
  seekableSeconds,
  streamUrlFor,
} from "@/pages/movies/lib/playback";
import { api } from "@/api/client";
import type { TorrentPlaybackPlan } from "@/api/types";

/**
 * Контракт URL-ов медиапотоков: фронт собирает их, браузер грузит тегами
 * <video>/<track>, а бэкенд валидирует параметры (40 hex, целые в диапазоне) —
 * поэтому лишний параметр или неверный формат числа = «плеер молча не играет».
 */
describe("streamUrl — remux-поток", () => {
  it("без параметров ссылка чистая, audio=0 не пишем (это значение по умолчанию)", () => {
    expect(remuxUrl("a".repeat(40), 0)).toBe(`/api/movies/torrent/remux/${"a".repeat(40)}/0`);
    expect(remuxUrl("a".repeat(40), 2, { audio: 0 })).toBe(
      `/api/movies/torrent/remux/${"a".repeat(40)}/2`,
    );
  });

  it("выбранная дорожка и позиция попадают в query", () => {
    const url = remuxUrl("abc123", 3, { audio: 2, startSec: 754.23 });
    expect(url).toBe("/api/movies/torrent/remux/abc123/3?audio=2&start=754.23");
  });

  it("секунда старта уходит с точностью -ss (3 знака), а не с округлением до сотых", () => {
    // Живой случай: ключевой кадр 1173.673 превращался в «1173.67», и выравнивание
    // скатывалось на предыдущий кадр (1172.546) — картинка расходилась со звуком.
    expect(remuxUrl("h", 0, { startSec: 1173.673 })).toBe(
      "/api/movies/torrent/remux/h/0?start=1173.673",
    );
    expect(remuxUrl("h", 0, { startSec: 60 })).toBe("/api/movies/torrent/remux/h/0?start=60");
    expect(remuxUrl("h", 0, { startSec: 0.5 })).toBe("/api/movies/torrent/remux/h/0?start=0.5");
  });

  it("aligned=1 сообщает бэкенду, что секунда уже выровнена (без повторного ffprobe)", () => {
    expect(remuxUrl("h", 0, { startSec: 1173.673, aligned: true })).toBe(
      "/api/movies/torrent/remux/h/0?start=1173.673&aligned=1",
    );
    // Не выровнено — параметра нет: сервер сам ищет ключевой кадр.
    expect(remuxUrl("h", 0, { startSec: 60, aligned: false })).toBe(
      "/api/movies/torrent/remux/h/0?start=60",
    );
    // Без секунды старта признак выравнивания не нужен (поток и так с нуля).
    expect(remuxUrl("h", 0, { aligned: true })).toBe("/api/movies/torrent/remux/h/0");
    expect(streamUrlFor("a".repeat(40), 0, { mode: "remux", startSec: 60, aligned: true })).toBe(
      `/api/movies/torrent/remux/${"a".repeat(40)}/0?start=60&aligned=1`,
    );
    // Прямой стрим: выравнивание не нужно, aligned в URL не попадает.
    expect(streamUrlFor("a".repeat(40), 0, { mode: "direct", startSec: 60, aligned: true })).toBe(
      `/api/movies/torrent/stream/${"a".repeat(40)}/0`,
    );
  });

  it("мусор в параметрах не превращается в мусорный query", () => {
    expect(remuxUrl("h", 0, { audio: -5, startSec: -1 })).toBe("/api/movies/torrent/remux/h/0");
    expect(remuxUrl("h", 0, { audio: 1.9, startSec: 0 })).toBe(
      "/api/movies/torrent/remux/h/0?audio=1",
    );
    expect(remuxUrl("h", 0, { startSec: Number.NaN })).toBe("/api/movies/torrent/remux/h/0");
  });

  it("video=h264 попадает в query, copy (по умолчанию) — нет", () => {
    expect(remuxUrl("h", 1, { video: "h264" })).toBe("/api/movies/torrent/remux/h/1?video=h264");
    expect(remuxUrl("h", 1, { video: "copy" })).toBe("/api/movies/torrent/remux/h/1");
    // Перекодирование и смена дорожки вместе: порядок совпадает с тем, что
    // собирает URLSearchParams (audio, video, start).
    expect(remuxUrl("h", 2, { audio: 1, video: "h264", startSec: 60 })).toBe(
      "/api/movies/torrent/remux/h/2?audio=1&video=h264&start=60",
    );
  });

  it("infoHash экранируется", () => {
    expect(remuxUrl("a/b c", 1)).toContain(encodeURIComponent("a/b c"));
  });
});

describe("streamUrl — субтитры", () => {
  it("дорожка контейнера → ?track=, файл раздачи → ?file=", () => {
    expect(subtitleUrl("h", 1, { track: 2 })).toBe("/api/movies/torrent/subtitles/h/1?track=2");
    expect(subtitleUrl("h", 1, { file: 7 })).toBe("/api/movies/torrent/subtitles/h/1?file=7");
    // file имеет приоритет: внешние субтитры читаются из раздачи, а не из потока.
    expect(subtitleUrl("h", 1, { track: 2, file: 7 })).toBe(
      "/api/movies/torrent/subtitles/h/1?file=7",
    );
  });

  it("неизвестная дорожка → track=0 (первая), а не пустой параметр", () => {
    expect(subtitleUrl("h", 0)).toBe("/api/movies/torrent/subtitles/h/0?track=0");
    expect(subtitleUrl("h", 0, { track: -1 })).toBe("/api/movies/torrent/subtitles/h/0?track=0");
  });
});

describe("streamUrl — время и подписи", () => {
  it("fmtTime: часы, минуты, секунды", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(45)).toBe("0:45");
    expect(fmtTime(754)).toBe("12:34");
    expect(fmtTime(3725)).toBe("1:02:05");
    expect(fmtTime(-10)).toBe("0:00");
  });

  it("parseTime понимает секунды, mm:ss и h:mm:ss", () => {
    expect(parseTime("754")).toBe(754);
    expect(parseTime("754,2")).toBe(754.2);
    expect(parseTime("12:34")).toBe(754);
    expect(parseTime("1:02:05")).toBe(3725);
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("12:99")).toBeNull();
    expect(parseTime("1:2:3:4")).toBeNull();
  });

  it("releaseMetaLine собирает подпись без пустых полей", () => {
    expect(
      releaseMetaLine({
        resolution: "4K",
        codec: "x265 (HEVC)",
        source: "WEB-DL",
        hdr: "HDR10",
        audio: ["Дубляж", "MVO"],
      }),
    ).toBe("4K · HDR10 · WEB-DL · x265 (HEVC) · Дубляж / MVO");
    expect(releaseMetaLine({ resolution: null, audio: [] })).toBe("");
    expect(releaseMetaLine({ resolution: "1080p" })).toBe("1080p");
  });
});

/**
 * Запасное определение «можно ли отдать файл прямо в <video>» — по имени.
 * Нужно, пока ffprobe не ответил: без него MKV уходил бы в прямой стрим и падал
 * с «Поток не воспроизводится» (Matroska Chromium не демуксит вообще).
 */
describe("streamUrl — isDirectPlayable", () => {
  it("mkv/avi/ts → false: их обязательно через ffmpeg, даже с h264 внутри", () => {
    expect(isDirectPlayable("Avengers.Endgame.2019.IMAX.WEB-DL.1080p.mkv")).toBe(false);
    expect(isDirectPlayable("movie.avi")).toBe(false);
    expect(isDirectPlayable("movie.ts")).toBe(false);
    expect(isDirectPlayable("C:\\torrents\\film.MKV")).toBe(false);
  });

  it("mp4/webm/mov → true", () => {
    expect(isDirectPlayable("movie.mp4")).toBe(true);
    expect(isDirectPlayable("movie.M4V")).toBe(true);
    expect(isDirectPlayable("clip.webm")).toBe(true);
    expect(isDirectPlayable("old.mov")).toBe(true);
  });

  it("без расширения → false (неизвестный формат считаем чужим)", () => {
    expect(isDirectPlayable("movie")).toBe(false);
    expect(isDirectPlayable("")).toBe(false);
    expect(isDirectPlayable(null)).toBe(false);
    expect(isDirectPlayable("folder.mp4/")).toBe(false);
  });
});

/**
 * Выбор потока: какой URL получит <video>. Это ядро бага «Поток не
 * воспроизводится» — MKV шёл в прямой стрим и падал, потому что Chromium не
 * демуксит Matroska. Здесь же — лестница фолбэков, по которой плеер сам
 * спускается, если формат всё-таки не подошёл.
 */
describe("playback — режим потока и лестница фолбэков", () => {
  const direct: TorrentPlaybackPlan = { mode: "direct", videoCopy: true, reason: "native" };
  const remux: TorrentPlaybackPlan = { mode: "remux", videoCopy: true, reason: "container" };
  const transc: TorrentPlaybackPlan = { mode: "transcode", videoCopy: false, reason: "codec" };
  const noff: TorrentPlaybackPlan = {
    mode: "unsupported",
    videoCopy: false,
    reason: "ffmpeg_missing",
  };

  it("нулевая ступень — режим плана, смена дорожки переводит direct в remux", () => {
    expect(playbackMode(direct, 0, false)).toBe("direct");
    expect(playbackMode(direct, 0, true)).toBe("remux");
    expect(playbackMode(remux, 0, false)).toBe("remux");
    // remux уже переупакован: смена дорожки его не меняет.
    expect(playbackMode(remux, 0, true)).toBe("remux");
    expect(playbackMode(transc, 0, false)).toBe("transcode");
  });

  it("лестница: direct → remux → transcode, дальше ниже уже некуда", () => {
    expect(playbackMode(direct, 1)).toBe("remux");
    expect(playbackMode(direct, 2)).toBe("transcode");
    expect(playbackMode(direct, 5)).toBe("transcode");
    // План уже был remux/transcode — единственная ступень ниже это перекодирование.
    expect(playbackMode(remux, 1)).toBe("transcode");
    expect(playbackMode(transc, 1)).toBe("transcode");
  });

  it("lastRetryLevel: у direct две ступени, у остальных одна", () => {
    expect(lastRetryLevel(direct)).toBe(2);
    expect(lastRetryLevel(remux)).toBe(1);
    expect(lastRetryLevel(transc)).toBe(1);
    expect(lastRetryLevel(noff)).toBe(1);
  });

  it("exactSeekLevel: с середины фильма — точный seek (перекодирование)", () => {
    // Начало фильма: реза нет, копирование ничего не ломает — режим не меняем.
    expect(exactSeekLevel("remux", 0)).toBe(0);
    expect(exactSeekLevel("direct", 0)).toBe(0);
    // Перемотка: берём ступень, на которой видео НЕ копируется — иначе картинка
    // начнётся с ключевого кадра до секунды реза и уедет от звука на длину GOP
    // (живой замер: 2.294 с — см. exactSeekVideoMode).
    expect(playbackMode(remux, exactSeekLevel("remux", 60))).toBe("transcode");
    expect(playbackMode(direct, exactSeekLevel("direct", 60))).toBe("transcode");
    expect(playbackMode(transc, exactSeekLevel("transcode", 60))).toBe("transcode");
    // Десятые доли секунды и мусор — это «начало»; отрицательное время тоже.
    expect(exactSeekLevel("remux", 0.5)).toBe(0);
    expect(exactSeekLevel("remux", Number.NaN)).toBe(0);
    expect(exactSeekLevel("remux", -10)).toBe(0);
  });

  it("URL: direct — Range-стрим, remux — переупаковка, transcode — с video=h264", () => {
    const hash = "27a320b5a4af7cdef19f33e6f7a5b6921f1a4e8b";
    expect(streamUrlFor(hash, 0, { mode: "direct" })).toBe(
      `/api/movies/torrent/stream/${hash}/0`,
    );
    expect(streamUrlFor(hash, 0, { mode: "remux" })).toBe(
      `/api/movies/torrent/remux/${hash}/0`,
    );
    expect(streamUrlFor(hash, 0, { mode: "transcode", audio: 1, startSec: 60 })).toBe(
      `/api/movies/torrent/remux/${hash}/0?audio=1&video=h264&start=60`,
    );
  });

  it("URL: unsupported и мусорные параметры → null (плеер не показываем)", () => {
    expect(streamUrlFor("a".repeat(40), 0, { mode: "unsupported" })).toBeNull();
    expect(streamUrlFor("", 0, { mode: "direct" })).toBeNull();
    expect(streamUrlFor("a".repeat(40), -1, { mode: "direct" })).toBeNull();
    expect(streamUrlFor("a".repeat(40), Number.NaN, { mode: "direct" })).toBeNull();
  });

  it("nonce (кнопка «Пересоздать поток») добавляется к любому режиму", () => {
    const hash = "a".repeat(40);
    expect(streamUrlFor(hash, 1, { mode: "direct", nonce: 3 })).toBe(
      `/api/movies/torrent/stream/${hash}/1?_=3`,
    );
    expect(streamUrlFor(hash, 1, { mode: "remux", nonce: 2 })).toBe(
      `/api/movies/torrent/remux/${hash}/1?_=2`,
    );
    // nonce=0 — это «ещё не пересоздавали», лишний параметр в URL не нужен.
    expect(streamUrlFor(hash, 1, { mode: "direct", nonce: 0 })).toBe(
      `/api/movies/torrent/stream/${hash}/1`,
    );
  });

  it("прямой путь совпадает с api.moviesTorrentStreamUrl (один контракт на двоих)", () => {
    expect(directStreamUrl("a".repeat(40), 2)).toBe(
      api.moviesTorrentStreamUrl("a".repeat(40), 2),
    );
  });
});

/**
 * Шкала плеера: длина фильма, светлая «доступная» полоса и граница перемотки.
 *
 * Здесь была настоящая поломка: живой fMP4-поток ffmpeg не содержит длительности,
 * браузер отдавал Infinity, шкала схлопывалась в ~1 секунду — и любой драг
 * ползунка перематывал фильм в начало, а «буфер» выглядел на 15 секунд.
 */
describe("playback — шкала, буфер и граница перемотки", () => {
  const FILM = 9133; // 2:32:13

  it("seekableSeconds: доля скачанного переводится в секунды фильма", () => {
    expect(seekableSeconds({ durationSec: FILM, progress: 0.25 })).toBeCloseTo(2283.25, 6);
    expect(seekableSeconds({ durationSec: FILM, progress: 1 })).toBe(FILM);
  });

  it("seekableSeconds: полоса не откатывается назад за просмотренную секунду", () => {
    // Скачано 10%, но пользователь уже дошёл до 20-й минуты: полоса не «съёживается».
    expect(seekableSeconds({ durationSec: FILM, progress: 0.1, position: 1200 })).toBe(1200);
    expect(seekableSeconds({ durationSec: FILM, progress: 0.5, position: 1200 })).toBeCloseTo(
      FILM * 0.5,
      6,
    );
  });

  it("seekableSeconds: без длительности или с мусором — 0 (нечего закрашивать)", () => {
    expect(seekableSeconds({ durationSec: null, progress: 0.5 })).toBe(0);
    expect(seekableSeconds({ durationSec: 0, progress: 1 })).toBe(0);
    expect(seekableSeconds({ durationSec: FILM, progress: Number.NaN })).toBe(0);
    expect(seekableSeconds({ durationSec: FILM, progress: 5 })).toBe(FILM); // >100% зажимаем
  });

  it("clampSeek: за пределы скачанного не пускаем — но и не в начало", () => {
    const { sec, clamped } = clampSeek(FILM, {
      durationSec: FILM,
      seekableSec: 600,
      nativeSeek: false,
    });
    expect(clamped).toBe(true);
    expect(sec).toBeCloseTo(599.5, 6); // встаём на границу скачанного
    expect(sec).not.toBe(0); // главное: фильм НЕ начинается заново
  });

  it("clampSeek: внутри скачанного и на прямой стрим — не ограничиваем", () => {
    expect(clampSeek(300, { durationSec: FILM, seekableSec: 600, nativeSeek: false })).toEqual({
      sec: 300,
      clamped: false,
    });
    expect(clampSeek(FILM, { durationSec: FILM, seekableSec: 600, nativeSeek: true })).toEqual({
      sec: FILM,
      clamped: false,
    });
    // Нет данных о скачанном (например, статус ещё не пришёл) — не мешаем зрителю.
    expect(clampSeek(1200, { durationSec: FILM, seekableSec: null })).toEqual({
      sec: 1200,
      clamped: false,
    });
  });

  it("clampSeek: граница не выходит за длину фильма", () => {
    const r = clampSeek(FILM, { durationSec: 100, seekableSec: 500, nativeSeek: false });
    expect(r.clamped).toBe(true);
    expect(r.sec).toBeCloseTo(99.5, 6);
  });

  it("fitVideoBox: широкий фильм вписывается по ширине, узкое окно — по высоте", () => {
    // 16:9 в широком окне: занимаем всю ширину.
    expect(fitVideoBox(16 / 9, 1200, 800)).toEqual({ width: 1200, height: 675 });
    // Места по высоте мало: кадр занимает всю высоту, ширина — по соотношению.
    expect(fitVideoBox(16 / 9, 1200, 400)).toEqual({ width: 711, height: 400 });
    // Узкий квадратный фильм в широком окне: ограничивает высота.
    expect(fitVideoBox(1, 1200, 500)).toEqual({ width: 500, height: 500 });
  });

  it("fitVideoBox: мусор в соотношении сторон не ломает разметку", () => {
    expect(fitVideoBox(0, 800, 600)).toEqual(fitVideoBox(16 / 9, 800, 600));
    expect(fitVideoBox(Number.NaN, 800, 600)).toEqual(fitVideoBox(16 / 9, 800, 600));
    // Минимальный размер: блок не схлопывается в ноль.
    expect(fitVideoBox(16 / 9, 0, 0).width).toBeGreaterThanOrEqual(120);
  });
});
