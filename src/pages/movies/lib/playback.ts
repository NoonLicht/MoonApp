/**
 * Выбор потока торрент-плеера: каким способом отдавать файл в <video>.
 *
 * Почему отдельный модуль: это и была причина «Поток не воспроизводится». Раздачи
 * почти всегда в MKV, а Matroska Chromium не демуксит вообще, поэтому прямая
 * отдача файла падала даже у полностью скачанного фильма. Решение — режим из
 * плана бэкенда (ffprobe) и лестница фолбэков, если он не подошёл.
 *
 * Чистые функции: компонент плеера только подставляет значения, а правила
 * покрыты tests/movieStreamUrl.test.ts.
 */
import type { PlaybackMode, TorrentPlaybackPlan } from "@/api/types";
import { remuxUrl } from "@/pages/movies/lib/streamUrl";

export type { PlaybackMode };

/** Прямой Range-стрим файла раздачи (тот же путь отдаёт api.moviesTorrentStreamUrl). */
export function directStreamUrl(infoHash: string, index: number): string {
  return `/api/movies/torrent/stream/${encodeURIComponent(infoHash)}/${index}`;
}

/**
 * Режим на текущей ступени лестницы:
 *  0 — как в плане; 1 — на ступень ниже; 2 — перекодирование.
 * Лестница: direct → remux → transcode. Смена аудиодорожки требует переупаковки
 * даже для «прямого» файла (Chromium не умеет переключать дорожки в контейнере).
 */
export function playbackMode(
  plan: TorrentPlaybackPlan,
  retryLevel = 0,
  audioChanged = false,
): PlaybackMode {
  const level = Math.max(0, Math.floor(Number(retryLevel) || 0));
  const base: PlaybackMode =
    level === 0
      ? plan.mode
      : plan.mode === "direct"
        ? level === 1
          ? "remux"
          : "transcode"
        : "transcode";
  return audioChanged && base === "direct" ? "remux" : base;
}

/** Сколько раз можно спуститься ниже: у direct две ступени, у остальных одна. */
export function lastRetryLevel(plan: TorrentPlaybackPlan): number {
  return plan.mode === "direct" ? 2 : 1;
}

/**
 * Ступень «точного seek» для перемотки на секунду atSec.
 *
 * Зачем: при копировании (`-c:v copy`) ffmpeg позиционируется на ключевой кадр
 * СТРОГО до `-ss`, а звук режет ровно по `-ss` — эти две точки не совпадают никогда,
 * расхождение равно длине GOP. Живой замер на раздаче H.264 + AC3 (GOP 2.294 с):
 * `-ss 1181.138` → первый кадр видео 1178.844 при звуке 1181.138, то есть 2.294 с
 * рассинхрона. Поэтому с середины фильма видео обязано перекодироваться (accurate
 * seek отбрасывает кадры до точки), а старт с нуля копировать можно: там реза нет и
 * картинка со звуком начинаются вместе.
 *
 * Возвращает 0, если режим менять не нужно (начало фильма).
 */
export function exactSeekLevel(mode: PlaybackMode, atSec: number): number {
  if (!(Math.floor(Number(atSec) || 0) > 0)) return 0;
  // Те же ступени, что у lastRetryLevel: у direct их две (direct → remux →
  // transcode), у остальных одна. Здесь считаем от режима, а не от объекта плана:
  // значение попадает в зависимости useCallback, и строка стабильнее ссылки.
  return mode === "direct" ? 2 : 1;
}

/**
 * Докуда реально можно перемотать (секунды фильма) — это и есть светлая полоса
 * на шкале. В режиме remux/transcode поток живого ffmpeg не «буферизуется» сам по
 * себе: браузер не знает, что внутри, а скачанные куски раздачи доступны целиком
 * благодаря последовательной стратегии. Поэтому граница = доля скачанного файла.
 *
 * Возвращает 0, если данных нет (тогда шкала просто нечего закрашивать).
 */
export function seekableSeconds(o: {
  durationSec?: number | null;
  /** Доля скачанного файла 0..1 (status.files[index].progress). */
  progress?: number | null;
  /** Уже просмотренная секунда: полоса не должна «откатываться» назад. */
  position?: number | null;
}): number {
  const duration = Number(o.durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const p = Math.min(1, Math.max(0, Number(o.progress) || 0));
  const downloaded = duration * p;
  const pos = Math.max(0, Number(o.position) || 0);
  return Math.min(duration, Math.max(downloaded, pos));
}

/**
 * Куда встанет перемотка: за пределы скачанного прыгать нельзя (там ещё нет
 * кусков, и поток встанет). Возвращает целевое время и признак «обрезали»,
 * чтобы UI честно сказал об этом, а не начинал фильм заново.
 */
export function clampSeek(
  targetSec: number,
  o: { durationSec?: number | null; seekableSec?: number | null; nativeSeek?: boolean } = {},
): { sec: number; clamped: boolean } {
  const target = Math.max(0, Number(targetSec) || 0);
  // Прямой стрим умеет сам запрашивать нужные байты из раздачи — не ограничиваем.
  if (o.nativeSeek) return { sec: target, clamped: false };
  const limit = Number(o.seekableSec);
  if (!Number.isFinite(limit) || limit <= 0) return { sec: target, clamped: false };
  const duration = Number(o.durationSec);
  const max = Number.isFinite(duration) && duration > 0 ? Math.min(limit, duration) : limit;
  // Полсекунды запаса: последний кусок скачанного может быть ещё в работе.
  if (target > max - 0.5) return { sec: Math.max(0, max - 0.5), clamped: true };
  return { sec: target, clamped: false };
}

/**
 * Размер кадра в окне: вписываем фильм целиком — по ширине И по высоте, без
 * обрезки. Если места мало по высоте, кадр занимает всю высоту, а ширина
 * считается по соотношению сторон (тогда по бокам не остаётся чёрных полей:
 * размер блока совпадает с размером кадра).
 */
export function fitVideoBox(
  aspect: number,
  availWidth: number,
  availHeight: number,
): { width: number; height: number } {
  const ar = Number(aspect) > 0.1 ? Number(aspect) : 16 / 9;
  const w = Math.max(120, Number(availWidth) || 0);
  const h = Math.max(90, Number(availHeight) || 0);
  const byWidth = { width: w, height: w / ar };
  if (byWidth.height <= h) {
    return { width: Math.round(byWidth.width), height: Math.round(byWidth.height) };
  }
  return { width: Math.round(h * ar), height: Math.round(h) };
}

/**
 * URL потока для режима. null — играть нельзя (нет файла или режим unsupported:
 * без FFmpeg чужой контейнер не проиграть).
 *
 * nonce — ручное «Пересоздать поток»: тот же путь, но новый запрос, чтобы бэкенд
 * собрал поток заново (кэш и уже мёртвое соединение не мешают).
 */
export function streamUrlFor(
  infoHash: string,
  index: number,
  o: {
    mode: PlaybackMode;
    audio?: number;
    startSec?: number;
    nonce?: number;
    /**
     * Старт уже выровнен по ключевому кадру (ответ /torrent/seek): бэкенд не
     * переспрашивает ffprobe и начинает ровно с этой секунды — иначе он своим
     * выравниванием сдвигал старт, и звук со шкалой расходились.
     */
    aligned?: boolean;
  } = {
    mode: "direct",
  },
): string | null {
  if (o.mode === "unsupported") return null;
  const hash = String(infoHash || "");
  const idx = Math.floor(Number(index));
  if (!hash || !Number.isFinite(idx) || idx < 0) return null;

  const base =
    o.mode === "direct"
      ? directStreamUrl(hash, idx)
      : remuxUrl(hash, idx, {
          audio: o.audio,
          startSec: o.startSec,
          video: o.mode === "transcode" ? "h264" : "copy",
          aligned: o.aligned,
        });

  const nonce = Math.floor(Number(o.nonce));
  if (!Number.isFinite(nonce) || nonce <= 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}_=${nonce}`;
}