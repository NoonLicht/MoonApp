/**
 * Метаданные медиафайла: аудиодорожки и субтитры (Сценарий Б модуля плеера).
 *
 * Зачем: Chromium не умеет переключать дорожки внутри контейнера (особенно MKV),
 * поэтому дорожки читает ffprobe на бэкенде, а переключение выполняет ffmpeg:
 * видео копируется (`-c:v copy`), аудио перекодируется в AAC, субтитры отдаются
 * отдельным потоком WebVTT (см. buildRemuxArgs / server/routes/movies.js).
 *
 * ffprobe/ffmpeg берём из server/convertEngine.js (detectFfmpeg) — в проекте это
 * единственный источник путей к бинарям; fluent-ffmpeg в зависимостях нет и не
 * нужен: compressor.js уже работает так же (execFile + -print_format json).
 *
 * Чистые функции (языки, подписи дорожек, SRT→VTT) вынесены отдельно, чтобы их
 * можно было покрыть тестами без запуска ffprobe (tests/mediaProbe.test.ts).
 *
 * TS-исходник, как server/ts/torrent.ts: компилируется в server/mediaProbe.js
 * командой `npm run compile:server`.
 */
import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import { detectFfmpeg, ffmpegSearchPaths } from "./convertEngine";
import { ffmpegEncoders } from "./encoders";
import { decodeBytes } from "./charset";
import settings from "./settings";

const { DIRS } = config;

/** Ошибка с машиночитаемым кодом — роут отдаёт её фронту как { error, code }. */
export interface ProbeError extends Error {
  code: string;
}
function probeError(code: string, message?: string): ProbeError {
  const e = new Error(message || code) as ProbeError;
  e.code = code;
  return e;
}

/** Одна аудиодорожка для UI и для ffmpeg (-map 0:a:<index>). */
export interface AudioTrackInfo {
  /** Относительный индекс среди аудиодорожек (именно он нужен для -map 0:a:N). */
  index: number;
  /** Абсолютный индекс потока в контейнере (как его вернул ffprobe). */
  streamIndex: number;
  language: string | null;
  title: string | null;
  /** Готовая подпись для селекта: «Russian (Dub)», «English (Original)». */
  label: string;
  codec: string;
  channels: number;
  isDefault: boolean;
  isOriginal: boolean;
}

/** Одна дорожка субтитров (в контейнере или отдельным файлом раздачи). */
export interface SubtitleTrackInfo {
  /** Относительный индекс среди субтитров (для -map 0:s:N). */
  index: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  label: string;
  codec: string;
  isDefault: boolean;
  forced: boolean;
  /** true — субтитры лежат отдельным файлом (.srt/.vtt) внутри раздачи. */
  external?: boolean;
  /** Для внешних файлов: индекс файла в раздаче (тогда index = -1). */
  fileIndex?: number;
}

/** Итог разбора контейнера. */
export interface MediaProbeResult {
  durationSec: number;
  video: { codec: string; width: number; height: number; hdr: boolean } | null;
  audio: AudioTrackInfo[];
  subtitles: SubtitleTrackInfo[];
  /** Установлен ли ffmpeg (без него нельзя переключать дорожки и извлекать субтитры). */
  ffmpeg: boolean;
}

/** Источник для ffprobe: локальный файл или HTTP-поток торрента. */
export type ProbeSource =
  { kind: "file"; path: string } | { kind: "url"; url: string; headers?: Record<string, string> };

/* ======================= Языки и подписи ======================= */

/** ISO 639-1/639-2 → английское название языка (как просит контракт UI). */
const LANG_NAMES: Record<string, string> = {
  ru: "Russian",
  rus: "Russian",
  en: "English",
  eng: "English",
  uk: "Ukrainian",
  ukr: "Ukrainian",
  be: "Belarusian",
  bel: "Belarusian",
  kk: "Kazakh",
  kaz: "Kazakh",
  de: "German",
  deu: "German",
  ger: "German",
  fr: "French",
  fra: "French",
  fre: "French",
  es: "Spanish",
  spa: "Spanish",
  it: "Italian",
  ita: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  pl: "Polish",
  pol: "Polish",
  cs: "Czech",
  ces: "Czech",
  tr: "Turkish",
  tur: "Turkish",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  zho: "Chinese",
  chi: "Chinese",
  ar: "Arabic",
  ara: "Arabic",
  hi: "Hindi",
  hin: "Hindi",
  nl: "Dutch",
  nld: "Dutch",
  sv: "Swedish",
  swe: "Swedish",
  da: "Danish",
  dan: "Danish",
  fi: "Finnish",
  fin: "Finnish",
  no: "Norwegian",
  nor: "Norwegian",
};

/** Код языка → «Russian» (или null, если код неизвестен/пустой). */
export function languageName(code: unknown): string | null {
  const c = String(code || "")
    .trim()
    .toLowerCase();
  if (!c || c === "und" || c === "unknown") return null;
  return LANG_NAMES[c] || c.toUpperCase();
}

/** Описание потока ffprobe (минимальный срез — остального нам не нужно). */
interface FfStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  channels?: number;
  width?: number;
  height?: number;
  color_transfer?: string;
  color_primaries?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

/** Подпись аудиодорожки: язык + название + метка Dub/Original. */
export function describeAudioTrack(
  stream: FfStream,
  ordinal: number,
  streamIndex: number,
  opts: { uiLang?: string | null; many?: boolean } = {},
): AudioTrackInfo {
  const rawLang = String(stream?.tags?.language || "");
  const language = languageName(rawLang);
  const title = String(stream?.tags?.title || "").trim() || null;
  const isDefault = Number(stream?.disposition?.default) === 1;
  const hint = `${title || ""} ${rawLang}`;

  const dub = /дубл|dub(?:bed)?|\bmvo\b|\bdvo\b|многоголос|двухголос|авторск|одноголос/i.test(hint);
  const orig = /оригинал|original/i.test(hint);
  // Оригинальной считаем дорожку: явно помеченную «оригинал», либо — при
  // отсутствии пометки дубляжа — помеченную в контейнере default, либо дорожку на
  // языке, отличном от языка интерфейса, когда дорожек несколько (типовая раздача:
  // ru-дубляж + en-оригинал). Это эвристика, и она намеренно простая: у MKV почти
  // никогда нет метаданных «это оригинал», зато есть язык и default.
  const uiName = languageName(opts.uiLang || "");
  const foreignOriginal = !!uiName && !!language && language !== uiName && opts.many === true;
  const isOriginal = orig || (!dub && (foreignOriginal || isDefault));
  const tag = dub ? "Dub" : isOriginal ? "Original" : "";

  const base = language || title || `Track ${ordinal + 1}`;
  const withTitle = title && language && title !== language ? `${base} — ${title}` : base;
  return {
    index: ordinal,
    streamIndex,
    language,
    title,
    label: tag ? `${base} (${tag})` : withTitle,
    codec: String(stream?.codec_name || ""),
    channels: Number(stream?.channels) || 0,
    isDefault,
    isOriginal,
  };
}

/** Подпись дорожки субтитров: язык + название + метки (forced/внешние). */
export function describeSubtitleTrack(
  stream: FfStream,
  ordinal: number,
  streamIndex: number,
  opts: { external?: boolean } = {},
): SubtitleTrackInfo {
  const language = languageName(stream?.tags?.language);
  const title = String(stream?.tags?.title || "").trim() || null;
  const forced = Number(stream?.disposition?.forced) === 1;
  const base = language || title || `Subtitles ${ordinal + 1}`;
  const withTitle = title && language && title !== language ? `${base} — ${title}` : base;
  const label = forced
    ? `${withTitle} (forced)`
    : opts.external
      ? `${withTitle} (файл)`
      : withTitle;
  return {
    index: ordinal,
    streamIndex,
    language,
    title,
    label,
    codec: String(stream?.codec_name || ""),
    isDefault: Number(stream?.disposition?.default) === 1,
    forced,
    external: opts.external,
  };
}

/** Признак HDR/Dolby Vision по строке ffprobe (transfer/primaries). */
export function looksHdr(info: { color_transfer?: string; color_primaries?: string }): boolean {
  const t = String(info?.color_transfer || "").toLowerCase();
  const p = String(info?.color_primaries || "").toLowerCase();
  return /smpte2084|arib-std-b67|bt2020/.test(`${t} ${p}`);
}

/**
 * SRT → WebVTT (клиентский `<track>` понимает только VTT).
 * Разница минимальна: шапка «WEBVTT», десятичная точка вместо запятой в таймкодах
 * и удаление BOM/номеров блоков. Чистая функция — покрыта тестами.
 */
export function srtToVtt(text: unknown): string {
  const body = String(text == null ? "" : text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    // 00:00:01,000 --> 00:00:04,000  →  с точками.
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    // Номера блоков (одиночное число перед таймкодом) в VTT не нужны.
    // Таймкод может быть уже с точкой, поэтому класс [.,].
    .replace(/^\s*\d+\s*\n(?=\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->)/gm, "");
  return `WEBVTT\n\n${body.trim()}\n`;
}

/* ======================= Запуск ffprobe/ffmpeg ======================= */

/** Заголовки для ffmpeg/ffprobe — одна строка «K: v\r\n» на каждый заголовок. */
function headerArg(headers?: Record<string, string>): string[] {
  const entries = Object.entries(headers || {});
  if (!entries.length) return [];
  const value = entries.map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return ["-headers", value];
}

/** Аргументы до -i: читаем только шапку контейнера (WebTorrent догрузит куски). */
function inputArgs(src: ProbeSource): string[] {
  if (src.kind === "url") {
    return [
      ...headerArg(src.headers),
      "-probesize",
      "5M",
      "-analyzeduration",
      "10M",
      // Не ждём бесконечно, если куски ещё не пришли: лучше честная ошибка и
      // повторная попытка, чем «зависший» плеер (значение в микросекундах).
      "-rw_timeout",
      "15000000",
      "-i",
      src.url,
    ];
  }
  return ["-i", src.path];
}

/** Короткая подпись источника для логов (URL без query). */
function srcLabel(src: ProbeSource): string {
  return src.kind === "file" ? path.basename(src.path) : String(src.url).split("?")[0];
}

/** execFile-обёртка с таймаутом (тот же подход, что в server/ts/compressor.ts). */
function runTool(
  cmd: string,
  args: string[],
  timeoutMs = 20000,
): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ""),
          error: err ? String(stderr || err.message).slice(-500) : "",
        });
      },
    );
  });
}

/** Доступны ли ffmpeg/ffprobe: без них выбор дорожек в плеере недоступен. */
export interface FfmpegStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  path: string | null;
}

/**
 * Готовность ffmpeg/ffprobe. force=true пересобирает кэш определения: бинарь
 * могли распаковать в storage уже после запуска приложения (кнопка «Проверить
 * снова» должна давать честный ответ сразу).
 */
export async function probeStatus({
  force = false,
}: { force?: boolean } = {}): Promise<FfmpegStatus> {
  try {
    const ff = await detectFfmpeg({ force });
    return { ffmpeg: !!(ff.found && ff.ffmpeg), ffprobe: !!ff.ffprobe, path: ff.ffmpeg || null };
  } catch {
    return { ffmpeg: false, ffprobe: false, path: null };
  }
}

/**
 * Полная картина по ffmpeg для UI: путь, версия и где именно искали.
 * «Где искали» нужен, когда бинаря нет: пользователь сразу видит, в какую папку
 * его положить (storage/ffmpeg), а не догадывается.
 */
export async function ffmpegInfo({
  force = false,
}: { force?: boolean } = {}): Promise<FfmpegStatus & { version: string | null; searched: string[] }> {
  try {
    const ff = await detectFfmpeg({ force });
    return {
      ffmpeg: !!(ff.found && ff.ffmpeg),
      ffprobe: !!ff.ffprobe,
      path: ff.ffmpeg || null,
      version: ff.version || null,
      searched: ffmpegSearchPaths(),
    };
  } catch {
    return { ffmpeg: false, ffprobe: false, path: null, version: null, searched: [] };
  }
}

/** JSON, который ждём от ffprobe (нам нужны только потоки и длительность). */
interface FfProbeJson {
  streams?: FfStream[];
  format?: { duration?: string; format_name?: string };
}

/**
 * JSON ffprobe → структура для фронта.
 * ВАЖНО про индексы: для ffmpeg (`-map 0:a:N`) нужен ОТНОСИТЕЛЬНЫЙ номер дорожки
 * среди аудиопотоков, поэтому index и streamIndex различаются и оба отдаются.
 */
export function mapProbe(json: FfProbeJson, ffmpegAvailable: boolean): MediaProbeResult {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const videoStreams = streams.filter((s) => s.codec_type === "video");
  // Основное видео — с максимальным разрешением: первым может идти обложка (mjpeg/png).
  const main = videoStreams
    .slice()
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const subStreams = streams.filter((s) => s.codec_type === "subtitle");
  // Язык интерфейса нужен только для пометки «оригинал» у иностранной дорожки.
  const uiLang = uiAudioLang();
  const many = audioStreams.length > 1;

  return {
    durationSec: Math.round((parseFloat(String(json?.format?.duration || "0")) || 0) * 100) / 100,
    video: main
      ? {
          codec: String(main.codec_name || ""),
          width: Number(main.width) || 0,
          height: Number(main.height) || 0,
          hdr: looksHdr(main),
        }
      : null,
    audio: audioStreams.map((s, i) =>
      describeAudioTrack(s, i, Number(s.index ?? i), { uiLang, many }),
    ),
    subtitles: subStreams.map((s, i) => describeSubtitleTrack(s, i, Number(s.index ?? i))),
    ffmpeg: ffmpegAvailable,
  };
}

/** Кэш разбора: один и тот же файл не переспрашиваем при каждом переключении. */
const PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map<string, { at: number; value: MediaProbeResult }>();

/** Сбросить кэш разбора (после смены файла/серии). */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * Разобрать контейнер: видео/аудио/субтитры через ffprobe.
 *
 * Источник — локальный файл или URL HTTP-стрима торрента: ffprobe сам ходит
 * Range-запросами, поэтому метаданные доступны до полной загрузки раздачи.
 */
export async function probeMedia(
  src: ProbeSource,
  opts: { force?: boolean } = {},
): Promise<MediaProbeResult> {
  const key = src.kind === "file" ? `file:${src.path}` : `url:${src.url}`;
  const hit = probeCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

  if (src.kind === "file" && !fs.existsSync(src.path)) {
    throw probeError("not_found", "файл для разбора не найден");
  }
  if (src.kind === "url" && !/^https?:\/\//i.test(src.url)) {
    throw probeError("bad_source", "некорректный источник для ffprobe");
  }

  let ff: { found?: boolean; ffmpeg?: string | null; ffprobe?: string | null } | null;
  try {
    ff = await detectFfmpeg();
  } catch {
    ff = null;
  }
  if (!ff?.ffprobe) {
    throw probeError(
      "ffmpeg_missing",
      "ffprobe не найден: установите FFmpeg (вкладка «Конвертер» → «Установить FFmpeg»)",
    );
  }

  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    ...inputArgs(src),
  ];
  // URL-источник — это HTTP-стрим торрента: сразу после добавления раздачи данных
  // может ещё не быть, и ffprobe честно падает. Поэтому для URL делаем одну
  // повторную попытку с паузой (иначе пользователь видел «FFmpeg не установлен»
  // там, где на самом деле не готов стрим).
  let res = await runTool(ff.ffprobe, args);
  if ((!res.ok || !res.stdout.trim()) && src.kind === "url") {
    logger.info("movies.probe_retry", { src: srcLabel(src), error: res.error.slice(0, 140) });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res = await runTool(ff.ffprobe, args);
  }
  if (!res.ok || !res.stdout.trim()) {
    throw probeError("probe_failed", `ffprobe: ${res.error || "не удалось прочитать контейнер"}`);
  }
  let json: FfProbeJson;
  try {
    json = JSON.parse(res.stdout) as FfProbeJson;
  } catch {
    throw probeError("probe_failed", "ffprobe вернул не JSON");
  }
  const value = mapProbe(json, !!(ff.found && ff.ffmpeg));
  probeCache.set(key, { at: Date.now(), value });
  logger.action("movies.probe", {
    src: srcLabel(src),
    audio: value.audio.length,
    subs: value.subtitles.length,
    duration: value.durationSec,
  });
  return value;
}

/* ======================= Ключевые кадры (выравнивание перемотки) ======================= */

/** Кэш ключевых кадров: у файла они не меняются, а ffprobe по потоку не бесплатный. */
const keyCache = new Map<string, { at: number; times: number[] }>();
const KEY_TTL_MS = 30 * 60 * 1000;
/** Сколько файлов держим в кэше индексов (LRU): чаще — вытесняем самый старый. */
const KEY_CACHE_MAX = 64;
/** Насколько далеко назад допустимо выравнивание: дальше лучше переспросить. */
const KEY_MAX_LOOKBACK_SEC = 25;
/**
 * Допуск «попал в кадр», секунды.
 *
 * Зачем: секунду старта плеер и бэкенд передают через URL, а URL округляет её
 * (иначе ссылка «растёт»). Раньше сравнение было строгим (`v <= target + 1e-3`),
 * и из-за трёх миллисекунд округления (1173.673 → «1173.67») ключевой кадр
 * считался «позже цели» — выравнивание сваливалось на ПРЕДЫДУЩИЙ кадр (1172.546
 * в логах), и картинка уезжала от звука почти на секунду. Допуск в 0.1 с (это
 * меньше кадра при 25 fps) убирает такие ложные промахи.
 */
export const KEYFRAME_EPS = 0.1;

/** Вывод ffprobe (csv с pts_time) → отсортированные времена ключевых кадров. */
export function parseKeyframeTimes(stdout: unknown): number[] {
  const seen = new Set<number>();
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const t = Number(raw.trim());
    if (Number.isFinite(t) && t >= 0) seen.add(Math.round(t * 1000) / 1000);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Последний ключевой кадр рядом с sec (null — такого нет).
 * «Рядом» — с допуском KEYFRAME_EPS: кадр, который на 3 мс позже запрошенной
 * секунды, для ffmpeg ровно тот же старт (при `-ss` он и так встанет на него).
 */
export function lastKeyframeBefore(times: unknown, sec: number): number | null {
  const target = Number(sec);
  if (!Number.isFinite(target) || !Array.isArray(times)) return null;
  let best: number | null = null;
  for (const t of times) {
    const v = Number(t);
    if (Number.isFinite(v) && v <= target + KEYFRAME_EPS && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * Ключевой кадр не позже указанной секунды — им выравниваем перемотку.
 *
 * Зачем это обязательно: при `-c:v copy` ffmpeg обязан начать видео с КЛЮЧЕВОГО
 * кадра (в раздачах он бывает на 6–10 секунд раньше), а звук при этом режется
 * ровно по `-ss`. Первый PTS видео уходит в минус на длину разрыва, и картинка
 * расходится со звуком ровно на этот разрыв. Измерено на живом фильме:
 * цель 596 с, ключевой кадр 589.964 → Δ первого PTS = 6.03 с (жуткий рассинхрон).
 *
 * Поэтому `-ss` ставим в ключевой кадр: оба потока начинаются в одной точке.
 * Функция не бросает: не смогли определить — вернём null (старое поведение).
 */
export async function keyframeBefore(
  src: ProbeSource,
  sec: number,
  opts: { windowSec?: number; force?: boolean } = {},
): Promise<number | null> {
  const target = Number(sec);
  if (!Number.isFinite(target) || target <= 0.05) return null;

  const key = src.kind === "file" ? `file:${src.path}` : `url:${src.url}`;
  const hit = keyCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < KEY_TTL_MS) {
    const kf = lastKeyframeBefore(hit.times, target);
    // Кэш собран вокруг прежних целей: кадр из далёкого окна брать нельзя (прыжок назад).
    if (kf != null && target - kf <= KEY_MAX_LOOKBACK_SEC) return kf;
  }

  let ff: { ffprobe?: string | null } | null;
  try {
    ff = await detectFfmpeg();
  } catch {
    ff = null;
  }
  if (!ff?.ffprobe) return null;

  // Окно побольше прежнего (20 с): ключевой кадр в раздачах бывает раз в 6–10 с,
  // и запас гарантирует, что предыдущий кадр вообще попал в выдачу ffprobe —
  // иначе выравнивание «не нашлось» и звук разъезжался.
  const windowSec = Math.max(2, Math.min(90, Number(opts.windowSec) || 30));
  const from = Math.max(0, target - windowSec);
  const args = [
    "-v",
    "error",
    // Только видео и только ключевые кадры: сканировать и декодировать не нужно.
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv=p=0",
    // Читаем ровно окно вокруг цели — по HTTP это те же байты, что нужны плееру.
    "-read_intervals",
    `${from}%${target + 0.5}`,
    ...inputArgs(src),
  ];
  const res = await runTool(ff.ffprobe, args, 25000);
  if (!res.ok || !res.stdout.trim()) {
    logger.info("movies.keyframe_probe_failed", {
      src: srcLabel(src),
      at: target,
      error: res.error.slice(0, 140),
    });
    return null;
  }
  // Берём только то, что попало в запрошенное окно: если ffprobe из-за неточного
  // seek по HTTP сообщил кадры из другого места, выравниваться по ним нельзя —
  // иначе плеер прыгнет назад на десятки секунд.
  const times = parseKeyframeTimes(res.stdout).filter(
    (t) => t >= from - 1 && t <= target + 0.5,
  );
  if (!times.length) return null;
  // Дополняем прежние наблюдения: следующий seek в том же районе будет мгновенным.
  const merged = [...new Set([...(hit?.times || []), ...times])].sort((a, b) => a - b);
  // LRU по порядку вставки в Map: вытесняем только один самый старый файл, а не
  // всю таблицу. Полная очистка (была раньше) означала, что после 64 запросов
  // индекс терялся — и следующий seek снова ждал ffprobe (в логах 2–9 с на запрос).
  while (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest === undefined) break;
    keyCache.delete(oldest);
  }
  keyCache.set(key, { at: Date.now(), times: merged });
  return lastKeyframeBefore(merged, target);
}

/** Сбросить кэш ключевых кадров (тесты и диагностика). */
export function clearKeyframeCache(): void {
  keyCache.clear();
}

/* ======================= Выбор дорожек и субтитров ======================= */

/**
 * Дорожка, которую выбираем при открытии плеера: помеченная в контейнере как
 * default, иначе первая. Оригинальная дорожка тут НЕ приоритетна: пользователь
 * ждёт привычный ему дубляж (для русских раздач это обычно как раз default).
 */
export function defaultAudioIndex(tracks: AudioTrackInfo[]): number {
  const pick = tracks.find((t) => t.isDefault) || tracks[0];
  return pick ? pick.index : 0;
}

/* ==================== План воспроизведения ==================== */

/**
 * Как Chromium сможет проиграть файл раздачи:
 *  - direct      — <video> читает файл сам (mp4/webm + поддерживаемые кодеки);
 *  - remux       — видео копируем, звук → AAC, отдаём fragmented MP4;
 *  - transcode   — видео тоже перекодируем (HEVC/MPEG-4 и пр. Chromium не читает);
 *  - unsupported — без FFmpeg вариант невозможен, говорим об этом честно.
 *
 * Почему это вообще нужно: раздачи почти всегда в MKV, а Matroska Chromium не
 * демуксит совсем — прямая отдача файла в <video> падала с ошибкой («Поток не
 * воспроизводится») даже у полностью скачанного фильма. Проверено на живом файле:
 * MKV + h264 + AC3 → mode "remux" (видео копируется, звук → AAC).
 */
export type PlaybackMode = "direct" | "remux" | "transcode" | "unsupported";

export interface PlaybackPlan {
  mode: PlaybackMode;
  /** true — видео копируется без потерь (-c:v copy), false — libx264. */
  videoCopy: boolean;
  /** Машиночитаемая причина выбора режима (для подсказки в UI и логов). */
  reason: string;
}

/** Контейнеры, которые Chromium демуксит сам. */
const DIRECT_EXTS = new Set(["mp4", "m4v", "mov", "webm"]);
/** Видеокодеки, которые Chromium декодирует сам. */
const DIRECT_VIDEO = new Set(["h264", "avc1", "vp8", "vp9", "av1", "theora"]);
/** Аудиокодеки, которые Chromium декодирует сам. */
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** Кодеки, которые можно положить в MP4 без перекодирования. */
const COPY_VIDEO = new Set(["h264", "avc1", "vp8", "vp9", "av1"]);

/** Расширение имени в нижнем регистре ("" — расширения нет или это папка). */
export function extOfName(name: unknown): string {
  const s = String(name == null ? "" : name).trim().toLowerCase();
  const dot = s.lastIndexOf(".");
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return dot > slash ? s.slice(dot + 1) : "";
}

/**
 * Выбрать режим воспроизведения. Кодеки берутся из ffprobe, имя файла — из
 * раздачи; ffmpeg=false (бинарь не найден) делает remux/transcode невозможными.
 * Неизвестный видеокодек считаем копируемым: если копия не пройдёт, плеер сам
 * спустится на ступень ниже (transcode) — см. лестницу фолбэков в PlayerModal.
 */
export function playbackPlan(
  o: {
    name?: unknown;
    videoCodec?: string | null;
    audioCodecs?: (string | null | undefined)[];
    ffmpeg?: boolean;
  } = {},
): PlaybackPlan {
  const ext = extOfName(o.name);
  const video = String(o.videoCodec || "")
    .trim()
    .toLowerCase();
  const audio = (o.audioCodecs || [])
    .map((c) => String(c || "").trim().toLowerCase())
    .filter(Boolean);
  const nativeContainer = DIRECT_EXTS.has(ext);
  const nativeVideo = DIRECT_VIDEO.has(video);
  const nativeAudio = audio.every((c) => DIRECT_AUDIO.has(c));

  // Файл, который <video> читает сам: родной контейнер и родные дорожки.
  if (nativeContainer && nativeVideo && nativeAudio) {
    return { mode: "direct", videoCopy: true, reason: "native" };
  }
  if (o.ffmpeg === false) {
    // Без ffmpeg ни переупаковать, ни перекодировать нельзя. Это не «сбой
    // потока», а отсутствие инструмента: UI скажет, что положить в storage.
    return { mode: "unsupported", videoCopy: false, reason: "ffmpeg_missing" };
  }
  // Контейнер чужой (MKV/AVI/TS) — переупаковываем в MP4. Видео копируем, если
  // его вообще можно положить в MP4; HEVC/MPEG-2 в MP4 Chromium не читает.
  if (COPY_VIDEO.has(video) || !video) {
    return {
      mode: "remux",
      videoCopy: true,
      reason: nativeContainer ? "audio_codec" : "container",
    };
  }
  return { mode: "transcode", videoCopy: false, reason: "codec" };
}

/** Язык интерфейса для эвристики «дубляж/оригинал» (movies.language → «ru»). */
function uiAudioLang(): string | null {
  try {
    const lang = String(settings.get("movies")?.language || "")
      .trim()
      .slice(0, 2)
      .toLowerCase();
    return lang || null;
  } catch {
    return null;
  }
}

/**
 * Запустить ffmpeg-remux и отдать процесс: stdout — поток фрагментированного MP4
 * (роут пайпит его в ответ), stderr — для логов. Файлов на диске не создаём:
 * перекодирование идёт «на лету» из торрент-стрима.
 */
export async function spawnRemux(o: RemuxOptions): Promise<ChildProcess> {
  let ff: { found?: boolean; ffmpeg?: string | null } | null;
  try {
    ff = await detectFfmpeg();
  } catch {
    ff = null;
  }
  if (!ff?.found || !ff.ffmpeg) {
    throw probeError(
      "ffmpeg_missing",
      "ffmpeg не найден: переключение аудиодорожек недоступно (установите FFmpeg)",
    );
  }
  // Перекодирование видео: энкодер выбираем по ФАКТИЧЕСКОЙ сборке ffmpeg.
  // Раньше аргументы жёстко просили libx264 — в сборке gyan.dev его нет
  // (`--disable-libx264`), и транскод падал мгновенно с «Unknown encoder»:
  // последняя ступень лестницы direct → remux → transcode не работала вовсе.
  let encoder = o.encoder ?? null;
  if (o.video === "h264" && !encoder) {
    const set = await ffmpegEncoders().catch(() => new Set<string>());
    encoder = pickH264Encoder(set);
    if (!encoder) {
      throw probeError(
        "ffmpeg_encoder_missing",
        "в этой сборке FFmpeg нет ни одного H.264-энкодера: перекодирование недоступно",
      );
    }
  }
  const child = spawn(ff.ffmpeg, buildRemuxArgs({ ...o, encoder }), {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  logger.action("movies.remux_spawn", {
    audio: o.audio ?? 0,
    start: o.startSec ?? 0,
    video: o.video || "copy",
    encoder,
  });
  return child;
}

export interface RemuxOptions {
  src: ProbeSource;
  /** Относительный индекс аудиодорожки (из MediaProbeResult.audio[index]). */
  audio?: number;
  /** Начало воспроизведения, секунды (перемотка = перезапуск потока). */
  startSec?: number;
  /** Битрейт AAC, kbps. */
  quality?: number;
  /**
   * "copy" (по умолчанию) — видео без перекодирования (h264/vp9/av1 → MP4);
   * "h264" — перекодировать (HEVC, MPEG-2, VC-1 — их Chromium не читает).
   * Значение приходит из плана воспроизведения (playbackPlan.videoCopy).
   */
  video?: "copy" | "h264";
  /**
   * Конкретный H.264-энкодер (`libx264`, `libopenh264`, `h264_mf`, `h264_nvenc`…).
   * Не задан — buildRemuxArgs берёт libx264 (так работают тесты аргументов), а
   * spawnRemux подбирает рабочий энкодер сборки через pickH264Encoder.
   */
  encoder?: string | null;
}

/**
 * Приоритет H.264-энкодеров для перекодирования на лету.
 *
 * Порядок выбран по живой проверке бинаря: `libx264` (лучший по качеству и
 * скорости, но в части сборок отключён) → софтверные `libopenh264` и `h264_mf`
 * (Media Foundation, есть на любой Windows) → аппаратные. Аппаратные — В КОНЦЕ:
 * их наличие в `-encoders` ещё не значит, что они запустятся (нужен GPU нужного
 * вендора и драйвер; без NVIDIA `h264_nvenc` падает с «Invalid argument», и
 * поток просто не открылся бы).
 */
export const H264_ENCODER_PRIORITY = [
  "libx264",
  "libopenh264",
  "h264_mf",
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
] as const;

/** Первый доступный в сборке H.264-энкодер (null — перекодировать нечем). */
export function pickH264Encoder(available: Iterable<string> | null | undefined): string | null {
  const set =
    available instanceof Set ? available : new Set<string>((available as string[]) || []);
  for (const e of H264_ENCODER_PRIORITY) if (set.has(e)) return e;
  return null;
}

/**
 * Опции перекодирования под конкретный энкодер.
 *
 * Почему не общий набор: `-preset ultrafast -crf 23` понимает только libx264 — для
 * `libopenh264`, `h264_mf`, `h264_nvenc`, `h264_qsv`, `h264_amf` ffmpeg падает с
 * «Error opening output files: Invalid argument» (проверено на живом бинаре).
 * Поэтому скорость/качество задаются под семейство энкодера.
 */
export function h264EncoderArgs(encoder: string): string[] {
  // yuv420p — то, что Chromium декодирует гарантированно; -g 48 — ключевой кадр
  // каждые 2 секунды, чтобы перемотка не уезжала далеко от запрошенной секунды.
  const common = ["-pix_fmt", "yuv420p", "-g", "48"];
  switch (encoder) {
    case "libx264":
      return ["-preset", "ultrafast", "-crf", "23", ...common];
    case "libopenh264":
      // Битрейт задаём явно: без него openh264 уходит в неочевидный rate control.
      return ["-b:v", "6M", ...common];
    case "h264_mf":
      return ["-rate_control", "quality", ...common];
    case "h264_nvenc":
      return ["-preset", "p1", "-cq", "23", ...common];
    case "h264_qsv":
      return ["-preset", "veryfast", "-global_quality", "23", ...common];
    case "h264_amf":
      return ["-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "25", ...common];
    default:
      // Неизвестный энкодер: минимум опций — так его точно не сломаем.
      return [...common];
  }
}

/**
 * Режим видео для потока с перемоткой: копировать с середины фильма нельзя.
 *
 * Почему не «копирование + выравнивание по ключевому кадру»: при `-c:v copy` ffmpeg
 * позиционируется на ключевой кадр СТРОГО до `-ss`, а звук режет ровно по `-ss`, и
 * эти две точки не совпадают никогда — расхождение равно длине GOP. Живой замер на
 * раздаче H.264 + AC3 (GOP 2.294 с), читая наш же Range-стрим:
 *   `-ss 1181.138` → первый кадр видео 1178.844, звук 1181.138 → рассинхрон 2.294 с.
 * Ни `-avoid_negative_ts make_zero`, ни `-noaccurate_seek`, ни `-seek_timestamp 1`
 * этого не меняют, а `-ss` с эпсилоном лишь переворачивает знак сдвига (становится
 * 0.15 с опоздания звука). Поэтому с начала фильма видео копируется (там реза нет и
 * синхрон не ломается), а при перемотке — перекодируется: accurate seek отбрасывает
 * кадры до запрошенной секунды, и обе дорожки стартуют ровно в одной точке.
 */
export function exactSeekVideoMode(
  startSec: number,
  requested: "copy" | "h264",
): "copy" | "h264" {
  const start = Number(startSec);
  if (Number.isFinite(start) && start > 0) return "h264";
  return requested === "h264" ? "h264" : "copy";
}
/**
 * Аргументы ffmpeg для «переупаковки на лету»: видео по умолчанию копируется без
 * потерь, выбранная аудиодорожка перекодируется в AAC (его понимает Chromium),
 * поток отдаётся fragmented MP4 — <video> играет сразу, без полной загрузки файла.
 * При video:"h264" видео ещё и перекодируется — для кодеков, которые Chromium не
 * читает (HEVC, MPEG-2, VC-1).
 *
 * Синхронность (то, из-за чего был рассинхрон при перемотке):
 *  - `-fflags +genpts` — после реза метки времени восстанавливаются: иначе часть
 *    пакетов остаётся без PTS и картинка со звуком разъезжаются;
 *  - `-avoid_negative_ts make_zero` — первый PTS не уходит в минус (при копировании
 *    он бывает отрицательным на длину GOP от точки реза);
 *  - `aresample=async=1:first_pts=0` — аудио якорится к нулю: AAC-энкодер добавляет
 *    priming, а в дорожках MKV после `-ss` бывает сдвиг, который даёт накопительный
 *    дрейф;
 *  - `-fps_mode passthrough` (при копировании) — таймлайн кадров не подменяется.
 */
export function buildRemuxArgs(o: RemuxOptions): string[] {
  // warning вместо error: предупреждения ffmpeg (например про rate control)
  // полезны в логе — по ним видно, почему поток ведёт себя не так, как ждали.
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-fflags", "+genpts"];
  const start = Number(o.startSec) || 0;
  // -ss ДО -i: быстрый seek (ffmpeg идёт за нужным куском через Range в стрим).
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push(...inputArgs(o.src));
  args.push("-map", "0:v:0");
  if (o.video === "h264") {
    // Энкодер и его опции — под конкретную сборку (см. pickH264Encoder).
    args.push("-c:v", o.encoder || "libx264", ...h264EncoderArgs(o.encoder || "libx264"));
  } else {
    args.push("-c:v", "copy", "-fps_mode", "passthrough");
  }
  const audio = Number(o.audio);
  args.push("-map", `0:a:${Number.isFinite(audio) ? Math.max(0, audio) : 0}`);
  args.push("-af", "aresample=async=1:first_pts=0");
  args.push("-c:a", "aac", "-b:a", `${Math.round(o.quality || 192)}k`, "-ac", "2");
  // Субтитры в remux не кладём (Chromium не читает их из MP4) — они идут
  // отдельным WebVTT-потоком, см. extractSubtitleWebVtt.
  args.push("-sn", "-dn");
  args.push("-avoid_negative_ts", "make_zero");
  args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return args;
}

/** Валидный UTF-8? (иначе внешние субтитры считаем cp1251). */
function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Байты внешнего файла субтитров → текст WebVTT (cp1251/UTF-8/UTF-16). */
export function subtitleFileToVtt(buf: Buffer, name = ""): string {
  const bytes = buf instanceof Buffer ? buf : Buffer.from(buf);
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = decodeBytes(bytes, "utf-16le");
  } else if (bytes.includes(0)) {
    text = decodeBytes(bytes, "utf-16le");
  } else if (isUtf8(bytes)) {
    text = bytes.toString("utf8");
  } else {
    text = decodeBytes(bytes, "windows-1251");
  }
  const clean = text.replace(/^\uFEFF/, "");
  if (/^\s*WEBVTT/i.test(clean)) return clean;
  // ASS/SSA вручную не конвертируем — честно говорим, что такой файл не поддержан
  // (из контейнера его умеет вытащить ffmpeg, а отдельным файлом — нет).
  if (/^\s*\[Script Info\]/i.test(clean) || /\.(ass|ssa)$/i.test(name)) {
    throw probeError("subtitle_unsupported", "формат ASS/SSA читается только из контейнера");
  }
  return srtToVtt(clean);
}

/**
 * Извлечь дорожку субтитров из контейнера как WebVTT.
 * Результат кэшируется в storage/torrents/subs — повторный выбор мгновенный.
 */
export async function extractSubtitleWebVtt(opts: {
  src: ProbeSource;
  index: number;
  /** Имя файла кэша (обычно infoHash + индекс файла в раздаче). */
  cacheKey: string;
}): Promise<{ text: string; cached: boolean }> {
  const idx = Number(opts.index);
  if (!Number.isFinite(idx) || idx < 0) {
    throw probeError("bad_track", "некорректный индекс субтитров");
  }
  const safeKey = String(opts.cacheKey || "sub")
    .replace(/[^a-z0-9_.-]/gi, "_")
    .slice(0, 80);
  const cachePath = path.join(DIRS.torrentSubs, `${safeKey}.s${idx}.vtt`);
  try {
    if (fs.existsSync(cachePath)) {
      return { text: fs.readFileSync(cachePath, "utf8"), cached: true };
    }
  } catch {
    /* не читается — извлечём заново */
  }

  let ff: { found?: boolean; ffmpeg?: string | null } | null;
  try {
    ff = await detectFfmpeg();
  } catch {
    ff = null;
  }
  if (!ff?.found || !ff.ffmpeg) {
    throw probeError("ffmpeg_missing", "ffmpeg не найден: извлечение субтитров недоступно");
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...inputArgs(opts.src),
    "-map",
    `0:s:${idx}`,
    "-f",
    "webvtt",
    "pipe:1",
  ];
  const res = await runTool(ff.ffmpeg, args, 60000);
  if (!res.ok || !res.stdout.trim()) {
    throw probeError("subtitle_failed", `ffmpeg: ${res.error || "дорожка субтитров пуста"}`);
  }
  const text = /^\s*WEBVTT/i.test(res.stdout) ? res.stdout : srtToVtt(res.stdout);
  try {
    fs.mkdirSync(DIRS.torrentSubs, { recursive: true });
    fs.writeFileSync(cachePath, text, "utf8");
    cleanupSubsCache();
  } catch {
    /* кэш не критичен */
  }
  logger.action("movies.subtitle_extracted", { index: idx, bytes: text.length });
  return { text, cached: false };
}

/** Удалить кэш субтитров старше 7 дней (storage не должен расти бесконечно). */
function cleanupSubsCache(): void {
  try {
    const ttl = 7 * 24 * 60 * 60 * 1000;
    const dir = DIRS.torrentSubs;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (Date.now() - fs.statSync(p).mtimeMs > ttl) fs.rmSync(p, { force: true });
    }
  } catch {
    /* уборка не критична */
  }
}

/* ============ Внешние субтитры из раздачи (.srt/.vtt рядом) ============ */

/** Токены языка в имени файла субтитров (длинные — раньше коротких). */
const SUB_LANG_TOKENS = [
  "russian",
  "rus",
  "ru",
  "english",
  "eng",
  "en",
  "ukrainian",
  "ukr",
  "uk",
  "german",
  "deu",
  "ger",
  "de",
  "french",
  "fra",
  "fre",
  "fr",
  "spanish",
  "spa",
  "es",
  "italian",
  "ita",
  "it",
  "japanese",
  "jpn",
  "ja",
  "korean",
  "kor",
  "ko",
  "chinese",
  "zho",
  "chi",
  "zh",
];
const SUB_LANG_RE = new RegExp(`(?:^|[._\\- ])(${SUB_LANG_TOKENS.join("|")})(?:[._\\- ]|$)`, "i");

/** Язык из имени файла субтитров: «film.rus.srt», «film.en.forced.srt». */
export function subtitleLangFromName(name: unknown): string | null {
  const m = SUB_LANG_RE.exec(String(name || "").toLowerCase());
  return m ? languageName(m[1]) : null;
}

/** Внешний файл субтитров внутри раздачи. */
export interface ExternalSubtitle {
  fileIndex: number;
  name: string;
  label: string;
  language: string | null;
  codec: string;
}

/**
 * Найти в раздаче внешние файлы субтитров, относящиеся к выбранному видео:
 * совпадение по базовому имени или по номеру серии (S01E02). Чистая функция.
 */
export function findSiblingSubs(
  files: { index: number; name: string }[],
  videoName: unknown,
): ExternalSubtitle[] {
  const base = String(videoName || "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const ep = /\bs(\d{1,2})e(\d{1,3})\b/i.exec(base);
  const out: ExternalSubtitle[] = [];
  for (const f of files || []) {
    const name = String(f?.name || "");
    if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) continue;
    const subBase = name.replace(/\.[^.]+$/, "").toLowerCase();
    const sameBase =
      !!base && (subBase === base || subBase.startsWith(base) || base.startsWith(subBase));
    const subEp = /\bs(\d{1,2})e(\d{1,3})\b/i.exec(subBase);
    const sameEp = !!(ep && subEp && ep[1] === subEp[1] && ep[2] === subEp[2]);
    if (!sameBase && !sameEp) continue;
    const language = subtitleLangFromName(name);
    const short = name.split(/[\\/]/).pop() || name;
    out.push({
      fileIndex: Number(f.index),
      name,
      language,
      label: language ? `${language} — ${short}` : short,
      codec: (short.split(".").pop() || "").toLowerCase(),
    });
  }
  return out;
}
