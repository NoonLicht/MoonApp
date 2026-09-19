import { describe, it, expect } from "vitest";
import {
  buildRemuxArgs,
  defaultAudioIndex,
  describeAudioTrack,
  describeSubtitleTrack,
  exactSeekVideoMode,
  extOfName,
  findSiblingSubs,
  h264EncoderArgs,
  KEYFRAME_EPS,
  languageName,
  lastKeyframeBefore,
  mapProbe,
  pickH264Encoder,
  playbackPlan,
  probeMedia,
  probeStatus,
  srtToVtt,
  subtitleFileToVtt,
  subtitleLangFromName,
} from "../server/mediaProbe";
import { encodeCp1251 } from "../server/charset";

/**
 * Модуль дорожек (Сценарий Б). ffprobe в тестах не запускаем: проверяем чистые
 * функции (подписи дорожек, разбор JSON ffprobe, аргументы ffmpeg, SRT→VTT) и
 * понятные коды ошибок до обращения к бинарю. Реальный ffprobe покрывается ручной
 * проверкой на живой раздаче.
 */
describe("mediaProbe — язык и подписи дорожек", () => {
  it("код языка → английское название", () => {
    expect(languageName("rus")).toBe("Russian");
    expect(languageName("RU")).toBe("Russian");
    expect(languageName("eng")).toBe("English");
    expect(languageName("und")).toBeNull();
    expect(languageName("")).toBeNull();
  });

  it("дубляж помечается как (Dub), оригинальная дорожка — как (Original)", () => {
    const dub = describeAudioTrack(
      { tags: { language: "rus", title: "Дубляж" }, disposition: { default: 1 } },
      0,
      1,
    );
    expect(dub.label).toBe("Russian (Dub)");
    expect(dub.isOriginal).toBe(false);
    expect(dub.streamIndex).toBe(1);

    const orig = describeAudioTrack(
      { tags: { language: "eng" }, disposition: { default: 1 } },
      1,
      2,
    );
    expect(orig.label).toBe("English (Original)");
    expect(orig.isOriginal).toBe(true);
    expect(orig.index).toBe(1); // относительный индекс — именно он идёт в -map
  });

  it("название дорожки добавляется к подписи, если язык известен", () => {
    const t = describeAudioTrack(
      { tags: { language: "rus", title: "Комментарий режиссёра" } },
      2,
      3,
    );
    expect(t.label).toBe("Russian — Комментарий режиссёра");
    expect(t.isOriginal).toBe(false);
  });

  it("субтитры: forced и внешние файлы помечаются", () => {
    expect(
      describeSubtitleTrack({ tags: { language: "rus" }, disposition: { forced: 1 } }, 0, 4).label,
    ).toBe("Russian (forced)");
    expect(
      describeSubtitleTrack({ tags: { language: "eng" }, codec_name: "subrip" }, 1, 5).label,
    ).toBe("English");
    expect(describeSubtitleTrack({}, 0, 6, { external: true }).label).toContain("(файл)");
  });
});

/** Срез реального ответа ffprobe: обложка, HDR-видео, дубляж, оригинал, субтитры. */
const FFPROBE_JSON = {
  format: { duration: "5400.123456" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600 },
    {
      index: 1,
      codec_type: "video",
      codec_name: "hevc",
      width: 1920,
      height: 1080,
      color_transfer: "smpte2084",
    },
    {
      index: 2,
      codec_type: "audio",
      codec_name: "ac3",
      channels: 6,
      tags: { language: "rus", title: "Дубляж" },
      disposition: { default: 1 },
    },
    { index: 3, codec_type: "audio", codec_name: "dts", channels: 6, tags: { language: "eng" } },
    {
      index: 4,
      codec_type: "subtitle",
      codec_name: "ass",
      tags: { language: "rus" },
      disposition: { forced: 1 },
    },
  ],
};

describe("mediaProbe — разбор ответа ffprobe", () => {
  it("видео берётся с максимальным разрешением, индексы дорожек относительные", () => {
    const r = mapProbe(FFPROBE_JSON, true);
    expect(r.video).toMatchObject({ codec: "hevc", width: 1920, height: 1080, hdr: true });
    expect(r.durationSec).toBe(5400.12);
    expect(r.audio).toHaveLength(2);
    // index — позиция среди аудио (для -map 0:a:N), streamIndex — номер потока.
    expect(r.audio.map((a) => [a.index, a.streamIndex])).toEqual([
      [0, 2],
      [1, 3],
    ]);
    expect(r.audio[0].label).toBe("Russian (Dub)");
    expect(r.audio[1].label).toBe("English (Original)");
    expect(r.subtitles).toHaveLength(1);
    expect(r.subtitles[0]).toMatchObject({ index: 0, streamIndex: 4, codec: "ass", forced: true });
    expect(r.ffmpeg).toBe(true);
  });

  it("пустой JSON не роняет разбор", () => {
    const r = mapProbe({}, false);
    expect(r.video).toBeNull();
    expect(r.audio).toEqual([]);
    expect(r.subtitles).toEqual([]);
    expect(r.ffmpeg).toBe(false);
  });

  it("дорожка для открытия плеера — помеченная default (иначе первая)", () => {
    // В фикстуре русский дубляж помечен default: именно его и предлагаем.
    expect(defaultAudioIndex(mapProbe(FFPROBE_JSON, true).audio)).toBe(0);
    expect(defaultAudioIndex([])).toBe(0);
  });
});

describe("mediaProbe — аргументы ffmpeg (переупаковка на лету)", () => {
  it("видео копируется, выбрана дорожка, есть seek и заголовки для стрима", () => {
    const args = buildRemuxArgs({
      src: {
        kind: "url",
        url: "http://127.0.0.1:4000/api/movies/torrent/stream/abc/0",
        headers: { "X-T": "1" },
      },
      audio: 1,
      startSec: 754.2,
      quality: 128,
    });
    const line = args.join(" ");
    expect(line).toContain("-headers X-T: 1");
    expect(line).toContain("-ss 754.200");
    expect(line).toContain("-map 0:v:0 -c:v copy");
    expect(line).toContain("-map 0:a:1");
    expect(line).toContain("-c:a aac -b:a 128k");
    expect(line).toContain("-movflags frag_keyframe+empty_moov+default_base_moof");
    expect(line).toContain("-f mp4 pipe:1");
    // Субтитры в remux не кладём — они идут отдельным WebVTT-потоком.
    expect(line).toContain("-sn -dn");
    // -ss обязан стоять перед -i, иначе seek медленный.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  it("локальный файл: без заголовков и без seek, если start не задан", () => {
    const args = buildRemuxArgs({ src: { kind: "file", path: "C:\\video.mkv" } });
    expect(args.join(" ")).not.toContain("-headers");
    expect(args).not.toContain("-ss");
    expect(args.join(" ")).toContain("-map 0:a:0");
  });
});

describe("mediaProbe — субтитры", () => {
  it("SRT превращается в WebVTT (запятые в точках, номера блоков убраны)", () => {
    const srt =
      "1\r\n00:00:01,000 --> 00:00:04,000\r\nПривет\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nПока\r\n";
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(vtt).toContain("Привет");
    expect(vtt).not.toMatch(/\n1\n/);
  });

  it("внешний .srt в cp1251 читается как текст, готовый VTT не переписывается", () => {
    const srt = Buffer.from(encodeCp1251("1\n00:00:01,000 --> 00:00:02,000\nПривет\n"));
    const vtt = subtitleFileToVtt(srt, "film.rus.srt");
    expect(vtt).toContain("Привет");
    expect(vtt).toContain("00:00:01.000");

    const already = subtitleFileToVtt(
      Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n", "utf8"),
    );
    expect(already.startsWith("WEBVTT")).toBe(true);
  });

  it("ASS/SSA как отдельный файл честно не поддерживается", () => {
    try {
      subtitleFileToVtt(Buffer.from("[Script Info]\nTitle: x\n", "utf8"), "film.ass");
      throw new Error("ожидалось исключение");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("subtitle_unsupported");
    }
  });

  it("язык субтитров берётся из имени файла", () => {
    expect(subtitleLangFromName("Show.S01E02.rus.srt")).toBe("Russian");
    expect(subtitleLangFromName("Show.S01E02.en.forced.srt")).toBe("English");
    expect(subtitleLangFromName("Show.s01e02.srt")).toBeNull();
  });

  it("внешние субтитры сопоставляются с эпизодом (или с именем файла)", () => {
    const files = [
      { index: 0, name: "Show.S01E02.1080p.WEB-DL.mkv" },
      { index: 1, name: "Show.S01E02.rus.srt" },
      { index: 2, name: "Show.S01E02.en.ass" },
      { index: 3, name: "Show.S01E03.rus.srt" },
      { index: 4, name: "readme.txt" },
    ];
    const subs = findSiblingSubs(files, "Show.S01E02.1080p.WEB-DL.mkv");
    expect(subs.map((s) => s.fileIndex)).toEqual([1, 2]);
    expect(subs[0]).toMatchObject({ language: "Russian", codec: "srt" });
    expect(subs[1]).toMatchObject({ language: "English", codec: "ass" });
    expect(findSiblingSubs(files, "Show.S01E03.mkv").map((s) => s.fileIndex)).toEqual([3]);
  });
});

describe("mediaProbe — ошибки до запуска ffprobe", () => {
  it("probeStatus не бросает и отдаёт флаги", async () => {
    const st = await probeStatus();
    expect(typeof st.ffmpeg).toBe("boolean");
    expect(typeof st.ffprobe).toBe("boolean");
  });

  it("несуществующий файл → not_found", async () => {
    try {
      await probeMedia({ kind: "file", path: "C:\\нет-такого-файла.mkv" });
      throw new Error("ожидалось исключение");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("not_found");
    }
  });

  it("подозрительный URL → bad_source (без SSRF-запросов)", async () => {
    try {
      await probeMedia({ kind: "url", url: "file:///etc/passwd" });
      throw new Error("ожидалось исключение");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_source");
    }
  });
});

/**
 * План воспроизведения: что именно делает плеер с файлом.
 *
 * Эти проверки — про реальный баг: MKV не демуксится Chromium вообще, поэтому
 * прямая отдача файла в <video> падала с «Поток не воспроизводится» даже у
 * скачанного фильма. Живой пример из раздачи: MKV + h264 + AC3 (см. проверку
 * «h264 в MKV с AC3»), для него нужен remux, а не direct.
 */
describe("mediaProbe — план воспроизведения (direct / remux / transcode)", () => {
  it("extOfName: расширение в нижнем регистре, папки и мусор → пусто", () => {
    expect(extOfName("Movie.2019.1080p.MKV")).toBe("mkv");
    expect(extOfName("C:\\torrents\\film.MP4")).toBe("mp4");
    expect(extOfName("noext")).toBe("");
    expect(extOfName(null)).toBe("");
    expect(extOfName("folder.name/")).toBe("");
  });

  it("mp4 + h264 + aac → прямой стрим (дешевле всего, нативный seek)", () => {
    const p = playbackPlan({
      name: "Movie.2020.1080p.WEB-DL.mp4",
      videoCodec: "h264",
      audioCodecs: ["aac"],
      ffmpeg: true,
    });
    expect(p.mode).toBe("direct");
    expect(p.reason).toBe("native");
  });

  it("h264 в MKV с AC3 → remux с копированием видео (это случай из жизни)", () => {
    const p = playbackPlan({
      name: "Avengers.Endgame.2019.IMAX.WEB-DL.1080p.mkv",
      videoCodec: "h264",
      audioCodecs: ["ac3", "ac3"],
      ffmpeg: true,
    });
    expect(p.mode).toBe("remux");
    expect(p.videoCopy).toBe(true);
    expect(p.reason).toBe("container");
  });

  it("mp4 + h264, но звук AC3 → тоже remux: контейнер родной, дорожка нет", () => {
    const p = playbackPlan({
      name: "movie.mp4",
      videoCodec: "h264",
      audioCodecs: ["ac3"],
      ffmpeg: true,
    });
    expect(p.mode).toBe("remux");
    expect(p.videoCopy).toBe(true);
    expect(p.reason).toBe("audio_codec");
  });

  it("HEVC/MPEG-2 → transcode: в MP4 Chromium их не читает", () => {
    for (const codec of ["hevc", "mpeg2video", "vc1"]) {
      const p = playbackPlan({
        name: "movie.mkv",
        videoCodec: codec,
        audioCodecs: ["aac"],
        ffmpeg: true,
      });
      expect(p.mode, codec).toBe("transcode");
      expect(p.videoCopy, codec).toBe(false);
      expect(p.reason, codec).toBe("codec");
    }
  });

  it("неизвестный видеокодек (ffprobe не дал данных) → remux с копией", () => {
    const p = playbackPlan({ name: "movie.mkv", videoCodec: null, audioCodecs: [] });
    expect(p.mode).toBe("remux");
    expect(p.videoCopy).toBe(true);
  });

  it("без ffmpeg чужой контейнер не проиграть: unsupported + причина для UI", () => {
    const p = playbackPlan({
      name: "movie.mkv",
      videoCodec: "h264",
      audioCodecs: ["ac3"],
      ffmpeg: false,
    });
    expect(p.mode).toBe("unsupported");
    expect(p.reason).toBe("ffmpeg_missing");

    // А родной mp4 играет и без ffmpeg — отбирать у пользователя просмотр нельзя.
    const ok = playbackPlan({
      name: "movie.mp4",
      videoCodec: "h264",
      audioCodecs: ["aac"],
      ffmpeg: false,
    });
    expect(ok.mode).toBe("direct");
  });

  it("без имени файла (файл ещё не выбран) → remux, а не ложный direct", () => {
    expect(playbackPlan({}).mode).toBe("remux");
  });

  it("buildRemuxArgs: по умолчанию видео копируется, при video=h264 — перекодируется", () => {
    const copy = buildRemuxArgs({ src: { kind: "url", url: "http://127.0.0.1/x" } });
    expect(copy.join(" ")).toContain("-c:v copy");
    expect(copy.join(" ")).not.toContain("libx264");
    // fragmented MP4: без этого <video> не начнёт играть до полной загрузки.
    expect(copy.join(" ")).toContain("frag_keyframe+empty_moov");

    const transc = buildRemuxArgs({
      src: { kind: "url", url: "http://127.0.0.1/x" },
      video: "h264",
    });
    const line = transc.join(" ");
    expect(line).toContain("-c:v libx264");
    expect(line).toContain("-preset ultrafast");
    expect(line).not.toContain("-c:v copy");
    expect(line).toContain("-c:a aac");
  });
});

/**
 * Синхронность потока: это и была жалоба «звук разъезжается при перемотке».
 *
 * Смысл проверок: после `-ss` метки времени надо восстанавливать и не пускать в
 * минус, а звук — прибивать к нулю (`first_pts`), иначе картинка и звук стартуют в
 * разных точках. Отдельно проверяем выбор энкодера: в сборке может не быть
 * libx264, и жёсткое «-c:v libx264» роняло всю ступень transcode.
 */
describe("mediaProbe — синхронность перемотки и выбор энкодера", () => {
  it("флаги синхронности стоят в аргументах (копирование и перекодирование)", () => {
    for (const video of ["copy", "h264"] as const) {
      const line = buildRemuxArgs({
        src: { kind: "url", url: "http://127.0.0.1/x" },
        startSec: 1173.673,
        video,
      }).join(" ");
      expect(line).toContain("-fflags +genpts");
      expect(line).toContain("-avoid_negative_ts make_zero");
      expect(line).toContain("-af aresample=async=1:first_pts=0");
      // Секунда реза отдаётся ffmpeg с той же точностью, что и в URL (3 знака).
      expect(line).toContain("-ss 1173.673");
    }
    // При копировании таймлайн кадров не подменяем.
    const copy = buildRemuxArgs({
      src: { kind: "url", url: "http://127.0.0.1/x" },
    }).join(" ");
    expect(copy).toContain("-fps_mode passthrough");
  });

  it("pickH264Encoder: первый доступный по приоритету, GPU — после софтверных", () => {
    // libx264 в сборке есть — берём его (лучший по качеству/скорости).
    expect(pickH264Encoder(["libx264", "h264_mf"])).toBe("libx264");
    // libx264 отключён (наш случай) — не падаем, а берём рабочий софтверный.
    expect(pickH264Encoder(new Set(["h264_nvenc", "libopenh264", "h264_mf"]))).toBe(
      "libopenh264",
    );
    expect(pickH264Encoder(["h264_mf"])).toBe("h264_mf");
    // Перекодировать нечем — честный null, а не падение ffmpeg на «Unknown encoder».
    expect(pickH264Encoder(["hevc_nvenc", "libvpx"])).toBeNull();
    expect(pickH264Encoder(null)).toBeNull();
  });

  it("h264EncoderArgs: опции под семейство энкодера (общий -crf ломает не-libx264)", () => {
    expect(h264EncoderArgs("libx264").join(" ")).toContain("-preset ultrafast -crf 23");
    // libopenh264 и h264_mf падают с -crf («Invalid argument») — у них свои опции.
    expect(h264EncoderArgs("libopenh264").join(" ")).not.toContain("-crf");
    expect(h264EncoderArgs("libopenh264").join(" ")).toContain("-b:v 6M");
    expect(h264EncoderArgs("h264_mf").join(" ")).toContain("-rate_control quality");
    expect(h264EncoderArgs("h264_nvenc").join(" ")).toContain("-preset p1 -cq 23");
    // Общее: пиксельный формат, который читает Chromium, и ключевой кадр каждые 2 с.
    for (const enc of ["libx264", "libopenh264", "h264_mf", "h264_nvenc", "h264_qsv", "h264_amf"]) {
      expect(h264EncoderArgs(enc).join(" "), enc).toContain("-pix_fmt yuv420p -g 48");
    }
  });

  it("buildRemuxArgs: выбранный энкодер уходит в -c:v и в его опции", () => {
    const line = buildRemuxArgs({
      src: { kind: "url", url: "http://127.0.0.1/x" },
      video: "h264",
      encoder: "h264_mf",
    }).join(" ");
    expect(line).toContain("-c:v h264_mf");
    expect(line).toContain("-rate_control quality");
    expect(line).not.toContain("libx264");
  });

  it("lastKeyframeBefore: кадр в пределах допуска — это тот же старт", () => {
    // Живой случай из лога: клиент получил ключевой кадр 1173.673, а сервер при
    // строгом сравнении скатывался на 1172.546 — картинка уезжала от звука.
    expect(lastKeyframeBefore([1172.546, 1173.673], 1173.67)).toBe(1173.673);
    // Обычный поиск «не позже секунды» не сломан.
    expect(lastKeyframeBefore([10, 20], 25)).toBe(20);
    expect(lastKeyframeBefore([10, 20], 20)).toBe(20);
    // Раньше допуска кадров нет — null (дальше решает keyframeBefore).
    expect(lastKeyframeBefore([10], 5)).toBeNull();
    expect(lastKeyframeBefore([], 5)).toBeNull();
    expect(lastKeyframeBefore(null, 5)).toBeNull();
    // Допуск намеренно маленький (меньше кадра при 25 fps).
    expect(KEYFRAME_EPS).toBeGreaterThan(0);
    expect(KEYFRAME_EPS).toBeLessThanOrEqual(0.1);
  });
/**
 * Режим видео при перемотке — это и есть гарантия синхрона. Копирование с `-ss`
 * начинает видео с ключевого кадра ДО секунды реза, а звук режется ровно по ней.
 * Живой замер на раздаче H.264 + AC3 (GOP 2.294 с, чтение своего Range-стрима):
 * `-ss 1181.138` → первый кадр видео 1178.844 при звуке 1181.138 = 2.294 с рассинхрона.
 * Ни `-avoid_negative_ts make_zero`, ни `-noaccurate_seek`, ни `-seek_timestamp 1`
 * этого не меняют, поэтому с середины фильма копировать нельзя вообще.
 */
describe("mediaProbe — режим видео при перемотке (exactSeekVideoMode)", () => {
  it("с середины фильма видео перекодируется — иначе картинка уедет от звука", () => {
    expect(exactSeekVideoMode(1181.138, "copy")).toBe("h264");
    expect(exactSeekVideoMode(1181.138, "h264")).toBe("h264");
    // Мусор в секунде считаем началом фильма (реза нет — копирование безопасно).
    expect(exactSeekVideoMode(Number.NaN, "copy")).toBe("copy");
    expect(exactSeekVideoMode(-5, "copy")).toBe("copy");
  });

  it("начало фильма не трогаем: перекодирование там незачем", () => {
    expect(exactSeekVideoMode(0, "copy")).toBe("copy");
    expect(exactSeekVideoMode(0, "h264")).toBe("h264");
    expect(exactSeekVideoMode(Number.NaN, "h264")).toBe("h264");
  });
});
});
