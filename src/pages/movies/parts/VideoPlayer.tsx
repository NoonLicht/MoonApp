import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scaling,
  Settings2,
  Subtitles,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { fmtTime } from "@/pages/movies/lib/streamUrl";
import {
  clampPan,
  clampSeek,
  clampZoom,
  FIT_MODES,
  fitBoxFor,
  fitModeLabelKey,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  type FitMode,
} from "@/pages/movies/lib/playback";

/**
 * Свой плеер страницы «Фильмы»: полный набор кнопок вместо нативных controls.
 *
 * Почему свой: нативные элементы Chromium нельзя ни стилизовать под тему
 * приложения, ни дополнить кнопками торрента («Стоп», «Удалить», галочка
 * «хранить»), ни показать буферизацию раздачи. Здесь только управление видео —
 * данные и раздача остаются у родителя (PlayerModal).
 *
 * Особенность источников: Range-стрим раздачи умеет нативный seek, а remux-поток
 * (ffmpeg, другая аудиодорожка) — нет: перемотка в нём это НОВЫЙ запрос с
 * &start=<сек>. Поэтому при nativeSeek=false перемотка идёт через onSeek
 * (родитель пересоздаёт поток), а шкала показывает baseSec + currentTime.
 */
export interface VideoPlayerProps {
  /** URL потока (Range-стрим раздачи или remux-поток ffmpeg). */
  src: string;
  title?: string;
  /** Позиция, с которой стартует ЭТОТ поток (remux: &start=). */
  baseSec?: number;
  /**
   * Длина фильма в секундах (из ffprobe). Нужна обязательно: живой fMP4-поток
   * ffmpeg не содержит длительности, поэтому браузер отдаёт duration = Infinity,
   * и шкала без этого значения схлопывалась в «1 секунду» — ползунок не двигался,
   * а перемотка уводила фильм в начало.
   */
  duration?: number | null;
  /**
   * Докуда можно перематывать (секунды фильма) — доля скачанной раздачи.
   * Рисуется светлой полосой поверх шкалы (как буфер в обычном плеере).
   */
  seekableSec?: number | null;
  /** Попытка перемотать за пределы скачанного: сообщаем границу родителю. */
  onSeekBlocked?: (maxSec: number) => void;
  /** true — обычный стрим (нативный seek), false — remux (перезапуск потока). */
  nativeSeek?: boolean;
  /** Перемотка для remux: новая секунда → новый поток. */
  onSeek?: (sec: number) => void;
  /** Субтитры (серверный WebVTT или загруженный пользователем файл). */
  subtitles?: { src: string; label: string; lang: string } | null;
  /** Дорожки субтитров для настроек плеера (значение "" — выключены). */
  subtitleOptions?: { value: string; label: string }[];
  /** Выбранная дорожка субтитров (значение из subtitleOptions). */
  subtitleValue?: string;
  onSubtitleChange?: (value: string) => void;
  /** Пересоздать поток — кнопка прямо на месте ошибки воспроизведения. */
  onRetry?: () => void;
  /**
   * Поток не открылся (сеть, формат, кодек). Передаём секунду, на которой это
   * случилось: родитель пересоздаст поток с того же места, а не с начала фильма.
   */
  onError?: (atSec?: number) => void;
  /** С этой секунды продолжить просмотр (сохранённая позиция раздачи).
   *  Range-стрим: нативный seek после метаданных; remux: через baseSec (&start=). */
  startAt?: number | null;
  /** Аудиодорожки контейнера: переключение делает родитель (remux). */
  audioTracks?: { index: number; label: string }[];
  audioIndex?: number;
  onAudioChange?: (index: number) => void;
  /** Периодически сообщаем позицию: родитель сохраняет её в реестре загрузок. */
  onPosition?: (sec: number) => void;
  /** Кнопки справа (например, «Стоп» и «Удалить» раздачу) — рисует родитель. */
  actions?: React.ReactNode;
  /** Плашка в углу (например, «Качается: 42% · 3.5 MB/s»). */
  badge?: string | null;
  autoPlay?: boolean;
}

const SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"];

export default function VideoPlayer({
  src,
  title,
  baseSec = 0,
  duration = null,
  seekableSec = null,
  onSeekBlocked,
  nativeSeek = true,
  onSeek,
  subtitles = null,
  subtitleOptions = [],
  subtitleValue = "",
  onSubtitleChange,
  onRetry,
  onError,
  startAt = null,
  audioTracks = [],
  audioIndex = 0,
  onAudioChange,
  onPosition,
  actions = null,
  badge = null,
  autoPlay = true,
}: VideoPlayerProps) {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Режим вписывания кадра: кнопка «растянуть» в панели плеера. */
  const [fitMode, setFitMode] = useState<FitMode>("fit");
  /** Зум в процентах (100 = как выбрано вписывание) и панорама увеличенного кадра. */
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showFit, setShowFit] = useState(false);
  /** Перетаскивание кадра мышью: старт, сдвиг и признак «это был драг, а не клик». */
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggedRef = useRef(false);
  /** Длительность, которую сообщил сам <video> (для живого потока — отсутствует). */
  const [mediaDuration, setMediaDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);
  const [subsOn, setSubsOn] = useState(true);
  const [showOpts, setShowOpts] = useState(false);
  /** Соотношение сторон кадра: по нему подгоняем размер блока под окно. */
  const [aspect, setAspect] = useState(16 / 9);
  /** Размер кадра в пикселях (вписываем фильм целиком — по ширине и высоте). */
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  /** Позиция ползунка во время перетаскивания (поток не пересоздаём до отпускания). */
  const [scrub, setScrub] = useState<number | null>(null);
  /** Панель управления прячется, пока идёт просмотр и мышь бездействует. */
  const [uiVisible, setUiVisible] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const lastSaved = useRef(0);
  /** Продолжение с сохранённой позиции применяем один раз на поток. */
  const appliedStart = useRef(false);

  /** Абсолютная позиция в фильме: remux стартует не с нуля. */
  const absTime = baseSec + current;

  /**
   * Длина фильма. Главный источник — ffprobe (проп `duration`): живой поток ffmpeg
   * (fragmented MP4) не содержит длительности, и браузер отдаёт Infinity — именно
   * из-за этого шкала раньше схлопывалась и перемотка уводила фильм в начало.
   */
  const filmSec =
    Number.isFinite(Number(duration)) && Number(duration) > 0
      ? Number(duration)
      : mediaDuration > 0
        ? baseSec + mediaDuration
        : 0;

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(v.currentTime);
    const b = v.buffered;
    if (b.length) setBuffered(b.end(b.length - 1));
    // Позицию сохраняем не чаще раза в 5 секунд: запись в БД не должна идти на
    // каждый тик timeupdate.
    const abs = baseSec + v.currentTime;
    if (abs - lastSaved.current > 5) {
      lastSaved.current = abs;
      onPosition?.(Math.floor(abs));
    }
  }, [baseSec, onPosition]);

  // Сменился поток (другая дорожка/перемотка): состояние шкалы сбрасываем.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(0);
    setBuffered(0);
    setMediaDuration(0);
    setFailed(false);
    setBuffering(true);
    appliedStart.current = false;
    v.playbackRate = rate;
    if (autoPlay) v.play().catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  /** Подписки на события <video>: состояние панели и сообщение позиции. */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => {
      setBuffering(false);
      setPlaying(true);
    };
    const onDuration = () => {
      setMediaDuration(Number.isFinite(v.duration) ? v.duration : 0);
      // Соотношение сторон берём у самого кадра: по нему блок подгоняется под окно
      // так, чтобы фильм влезал целиком и без чёрных полей.
      if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
      // Продолжаем с сохранённой секунды (Range-стрим: нативный seek). Для remux
      // это не нужно — поток уже стартовал с &start=.
      const from = Number(startAt) || 0;
      if (!appliedStart.current && nativeSeek && from > 30) {
        appliedStart.current = true;
        const limit = Number.isFinite(v.duration) ? v.duration : 0;
        v.currentTime = Math.max(0, Math.min(from - baseSec, limit ? limit - 2 : from - baseSec));
        setCurrent(v.currentTime);
      }
    };
    const onEnded = () => {
      setPlaying(false);
      // Досмотрели: следующее открытие начнём сначала.
      onPosition?.(0);
    };
    const onErr = () => {
      setFailed(true);
      setBuffering(false);
      // Родитель сам решает: спуститься на ступень ниже (remux/transcode) или нет.
      // Секунду передаём, чтобы пересоздание потока не уводило фильм в начало.
      onError?.(Math.max(0, Math.floor(baseSec + (videoRef.current?.currentTime || 0))));
    };
    const onProgress = () => {
      const b = v.buffered;
      if (b.length) setBuffered(b.end(b.length - 1));
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("durationchange", onDuration);
    v.addEventListener("loadedmetadata", onDuration);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("progress", onProgress);
    v.addEventListener("ended", onEnded);
    v.addEventListener("error", onErr);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("durationchange", onDuration);
      v.removeEventListener("loadedmetadata", onDuration);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("progress", onProgress);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("error", onErr);
    };
  }, [onTimeUpdate, onPosition, onError, src, startAt, nativeSeek, baseSec]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
  }, [volume, muted]);

  // Субтитры: включаем/выключаем дорожку текущего <track>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const list = v.textTracks;
    for (let i = 0; i < list.length; i++) {
      list[i].mode = subsOn ? "showing" : "hidden";
    }
  }, [subsOn, subtitles?.src, src]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /** Панель видна при движении мыши и скрывается через 2.6 с просмотра. */
  const wake = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // На паузе панель не прячем: иначе нечем управлять.
      const v = videoRef.current;
      if (v && !v.paused) setUiVisible(false);
    }, 2600);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  }, []);

  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else
      void v
        .requestPictureInPicture?.()
        .then(() => setPip(true))
        .catch(() => setPip(false));
  }, []);

  /**
   * Перемотка: считаем границу и выполняем её.
   *
   * Важно про поток ffmpeg (remux/transcode): он не seekable, поэтому перемотка —
   * это НОВЫЙ запрос с &start=<секунда>. Дёргать его на каждое движение ползунка
   * нельзя (на один драг рождались десятки ffmpeg-процессов), поэтому во время
   * движения только показываем позицию, а применяем на отпускании (commitScrub).
   */
  const applySeek = useCallback(
    (targetAbs: number) => {
      const { sec, clamped } = clampSeek(targetAbs, {
        durationSec: filmSec,
        seekableSec,
        nativeSeek,
      });
      if (clamped) onSeekBlocked?.(sec);
      const v = videoRef.current;
      if (nativeSeek) {
        if (!v) return;
        const limit = mediaDuration || v.duration || 0;
        const local = Math.max(0, sec - baseSec);
        v.currentTime = limit ? Math.min(local, limit - 0.5) : local;
        setCurrent(v.currentTime);
      } else {
        onSeek?.(sec);
      }
    },
    [baseSec, filmSec, mediaDuration, nativeSeek, onSeek, onSeekBlocked, seekableSec],
  );

  /** Перемотка на дельту секунд (кнопки ±10 и стрелки). */
  const nudge = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      applySeek(Math.max(0, baseSec + (v ? v.currentTime : 0) + delta));
    },
    [applySeek, baseSec],
  );

  /** Движение ползунка: показываем сразу, поток пересоздаём только на отпускании. */
  const onScrub = useCallback(
    (valueAbs: number) => {
      if (nativeSeek) {
        applySeek(valueAbs);
        return;
      }
      setScrub(valueAbs);
      setCurrent(Math.max(0, valueAbs - baseSec));
    },
    [applySeek, baseSec, nativeSeek],
  );

  /** Отпустили ползунок — вот теперь пересоздаём поток с новой секунды. */
  const commitScrub = useCallback(() => {
    if (scrub === null) return;
    setScrub(null);
    applySeek(scrub);
  }, [applySeek, scrub]);

  /** Горячие клавиши: пробел/K — пауза, ←→ — ±10 с, M — звук, F — полный экран. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = (el?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable)
        return;
      const k = e.key.toLowerCase();
      if (e.key === " " || k === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") nudge(-10);
      else if (e.key === "ArrowRight") nudge(10);
      else if (k === "m") setMuted((m) => !m);
      else if (k === "f") toggleFullscreen();
      else if (k === "j") nudge(-30);
      else if (k === "l") nudge(30);
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge, toggleFullscreen, togglePlay, wake]);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  /**
   * Подгоняем блок видео под окно: фильм должен влезать ЦЕЛИКОМ — и по ширине, и
   * по высоте, без обрезки и без чёрных полей. Размер считаем сами (fitVideoBox):
   * тогда блок в точности совпадает с кадром, и «полезная» площадь максимальна.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof window === "undefined") return undefined;
    const measure = () => {
      const host = el.parentElement;
      if (!host) return;
      const availWidth = host.clientWidth || window.innerWidth;
      const top = Math.max(0, host.getBoundingClientRect().top);
      // Резерв на панель управления, шкалу и подписи под плеером.
      const availHeight = Math.max(200, window.innerHeight - top - 190);
      setBox(fitBoxFor(fitMode, { aspect, availWidth, availHeight }));
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined" && el.parentElement
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el.parentElement as Element);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [aspect, fitMode]);

  // Зум уменьшили или блок изменился — панораму подрезаем к новым границам,
  // иначе увеличенный кадр «уехал» бы и по краям остался чёрный провал.
  useEffect(() => {
    if (!box) return;
    setPan((p) => clampPan(p, { width: box.width, height: box.height, zoomPercent: zoom }));
  }, [box, zoom]);

  const totalKnown = filmSec;
  const shownTime = totalKnown ? Math.min(absTime, totalKnown) : absTime;
  const pct = totalKnown ? Math.min(100, (shownTime / totalKnown) * 100) : 0;
  /**
   * Светлая полоса = докуда можно перематывать: доля скачанной раздачи (её считает
   * родитель) плюс то, что уже прочитал браузер. Полоса тянется на всю длину
   * фильма, а светлая часть показывает доступный для перемотки отрезок.
   */
  const seekableAbs = Math.max(
    Number(seekableSec) > 0 ? Number(seekableSec) : 0,
    baseSec + buffered,
    shownTime,
  );
  const bufPct = totalKnown ? Math.min(100, (seekableAbs / totalKnown) * 100) : 0;
  /** Пока тянут ползунок — показываем его позицию, а не текущую секунду. */
  const sliderValue = scrub !== null ? scrub : shownTime;

  /** Размер блока плеера: «вписать» — ровно по кадру, остальные режимы — вся область. */
  const boxStyle = !fullscreen && box ? { width: box.width, height: box.height } : undefined;
  /**
   * Зум и панорама кадра: переменные читает CSS (.mv-vp-video → transform),
   * поэтому увеличение и сдвиг работают в любом режиме вписывания.
   */
  const fitVars = {
    "--mv-vp-zoom": clampZoom(zoom) / 100,
    "--mv-vp-pan-x": `${Math.round(pan.x)}px`,
    "--mv-vp-pan-y": `${Math.round(pan.y)}px`,
  } as React.CSSProperties;
  /** Панорама осмысленна только на увеличенном кадре. */
  const pannable = clampZoom(zoom) > 100;

  /** Панорама: тянем увеличенный кадр мышью (клик по кадру при этом не срабатывает). */
  const onPanStart = (e: React.PointerEvent) => {
    draggedRef.current = false;
    if (!pannable || e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onPanMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !box) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Порог в 3 px: случайное дрожание мыши не считаем перетаскиванием.
    if (!draggedRef.current && Math.abs(dx) + Math.abs(dy) < 3) return;
    draggedRef.current = true;
    setPan(
      clampPan(
        { x: d.panX + dx, y: d.panY + dy },
        { width: box.width, height: box.height, zoomPercent: zoom },
      ),
    );
  };
  const onPanEnd = () => {
    dragRef.current = null;
  };

  return (
    <div
      className={`mv-vp fit-${fitMode} ${pannable ? "is-pannable" : ""} ${
        fullscreen ? "is-fs" : ""
      } ${uiVisible ? "" : "is-idle"}`}
      ref={wrapRef}
      style={{ ...boxStyle, ...fitVars }}
      onMouseMove={wake}
      onMouseLeave={() => {
        onPanEnd();
        if (playing) setUiVisible(false);
      }}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
    >
      <video
        ref={videoRef}
        key={src}
        src={src}
        playsInline
        preload="metadata"
        className="mv-vp-video"
        onClick={() => {
          // После перетаскивания кадра (панорама) клик не должен ставить паузу.
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
      >
        {subtitles ? (
          <track
            key={subtitles.src}
            kind="subtitles"
            src={subtitles.src}
            srcLang={subtitles.lang}
            label={subtitles.label}
            default
          />
        ) : null}
      </video>

      {/* Центральная кнопка: буферизация — крутилка, пауза — «play». */}
      {(!playing || buffering) && (
        <button className="mv-vp-center" onClick={togglePlay} title={t("player.play")}>
          {buffering ? <span className="mv-vp-spinner" /> : <Play size={30} />}
        </button>
      )}

      {badge && <span className="mv-vp-badge">{badge}</span>}

      {failed && (
        <div className="mv-vp-failed">
          <span>{t("movies.playerFailed")}</span>
          {onRetry ? (
            <button className="mv-vp-retry" onClick={onRetry}>
              <RefreshCw size={14} /> {t("movies.playerRetry")}
            </button>
          ) : null}
        </div>
      )}
      {/* Панель управления: шкала с буфером, кнопки и настройки. */}
      <div className="mv-vp-bar">
        <input
          className="mv-vp-seek"
          type="range"
          min={0}
          max={Math.max(1, Math.round(totalKnown || 1))}
          step={1}
          value={Math.round(sliderValue)}
          onChange={(e) => onScrub(Number(e.target.value))}
          // Поток ffmpeg не seekable: пересоздаём его только когда ползунок отпустили,
          // иначе на один драг уходили десятки запросов и фильм начинался заново.
          onPointerUp={commitScrub}
          onMouseUp={commitScrub}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
          title={t("movies.playerSeekLimit", { time: fmtTime(seekableAbs) })}
          style={{ "--mv-vp-pct": `${pct}%`, "--mv-vp-buf": `${bufPct}%` } as React.CSSProperties}
        />
        <div className="mv-vp-row">
          <button className="mv-vp-btn" onClick={togglePlay} title={t("player.play")}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className="mv-vp-btn" onClick={() => nudge(-10)} title={t("movies.playerBack10")}>
            <RotateCcw size={17} />
          </button>
          <button className="mv-vp-btn" onClick={() => nudge(10)} title={t("movies.playerFwd10")}>
            <RotateCw size={17} />
          </button>
          <span className="mv-vp-time">
            {fmtTime(shownTime)}{" "}
            <span className="muted-sm">/ {totalKnown ? fmtTime(totalKnown) : "—:—"}</span>
          </span>

          <span className="mv-vp-vol">
            <button
              className="mv-vp-btn"
              onClick={() => setMuted((m) => !m)}
              title={t("movies.playerMute")}
            >
              {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((muted ? 0 : volume) * 100)}
              onChange={(e) => {
                setVolume(Number(e.target.value) / 100);
                setMuted(false);
              }}
              title={t("movies.playerVolume")}
            />
          </span>

          <span className="mv-vp-spacer" />

          {subtitles ? (
            <button
              className={`mv-vp-btn ${subsOn ? "is-on" : ""}`}
              onClick={() => setSubsOn((s) => !s)}
              title={t("movies.subtitles")}
            >
              <Subtitles size={17} />
            </button>
          ) : null}

          <button
            className={`mv-vp-btn ${showFit ? "is-on" : ""}`}
            onClick={() => setShowFit((s) => !s)}
            title={t("movies.playerFit")}
          >
            <Scaling size={17} />
          </button>
          <button
            className={`mv-vp-btn ${showOpts ? "is-on" : ""}`}
            onClick={() => setShowOpts((s) => !s)}
            title={t("movies.playerSettings")}
          >
            <Settings2 size={17} />
          </button>
          <button className="mv-vp-btn" onClick={togglePip} title={t("movies.playerPip")}>
            <PictureInPicture2 size={17} />
          </button>
          <button
            className="mv-vp-btn"
            onClick={toggleFullscreen}
            title={t("movies.playerFullscreen")}
          >
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
          {/* Кнопки торрента («Стоп», «Удалить», галочка «хранить») рисует родитель. */}
          {actions}
        </div>

        {/* Настройки: скорость и аудиодорожка (переключение делает родитель). */}
        {showOpts && (
          <div className="mv-vp-opts">
            <label className="mv-vp-opt">
              <span>{t("player.speed")}</span>
              <Select
                value={String(rate)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setRate(next);
                  const v = videoRef.current;
                  if (v) v.playbackRate = next;
                }}
                options={SPEEDS.map((s) => ({ value: s, label: `${s}x` }))}
              />
            </label>
            {audioTracks.length > 1 && (
              <label className="mv-vp-opt">
                <span>{t("movies.audioTrack")}</span>
                <Select
                  value={String(audioIndex)}
                  onChange={(e) => onAudioChange?.(Number(e.target.value))}
                  options={audioTracks.map((a) => ({ value: String(a.index), label: a.label }))}
                />
              </label>
            )}
            {/* Субтитры живут здесь же, в настройках плеера: раньше селект был
                под плеером, и приходилось уходить из полного экрана. */}
            {subtitleOptions.length > 1 && (
              <label className="mv-vp-opt">
                <span>{t("movies.subtitles")}</span>
                <Select
                  value={subtitleValue || ""}
                  onChange={(e) => onSubtitleChange?.(e.target.value)}
                  options={subtitleOptions}
                />
              </label>
            )}
            {/* Вписывание кадра и зум: режимы — из FIT_MODES, ступени — из ZOOM_STEPS. */}
            {showFit && (
              <div className="mv-vp-opts mv-vp-fit">
                <div className="mv-vp-fit-modes">
                  {FIT_MODES.map((m) => (
                    <button
                      key={m}
                      className={`mv-vp-fit-mode ${m === fitMode ? "is-active" : ""}`}
                      onClick={() => setFitMode(m)}
                      title={t(fitModeLabelKey(m))}
                    >
                      {t(fitModeLabelKey(m))}
                    </button>
                  ))}
                </div>
                <div className="mv-vp-fit-zoom">
                  <span>{t("movies.playerZoom")}</span>
                  {ZOOM_STEPS.map((z) => (
                    <button
                      key={z}
                      className={`mv-vp-fit-zoom-btn ${z === clampZoom(zoom) ? "is-active" : ""}`}
                      onClick={() => setZoom(z)}
                    >
                      {z}%
                    </button>
                  ))}
                  <input
                    className="mv-vp-fit-zoom-input"
                    type="number"
                    min={ZOOM_MIN}
                    max={ZOOM_MAX}
                    step={5}
                    value={clampZoom(zoom)}
                    onChange={(e) => setZoom(clampZoom(e.target.value))}
                    title={t("movies.playerZoomCustom")}
                  />
                  <button
                    className="mv-vp-fit-zoom-btn"
                    onClick={() => {
                      setZoom(100);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    {t("movies.playerZoomReset")}
                  </button>
                </div>
                {pannable && <span className="mv-vp-fit-hint">{t("movies.fitPanHint")}</span>}
              </div>
            )}
            {title && <span className="muted-sm mv-vp-title">{title}</span>}
          </div>
        )}
      </div>
      {pip ? <span className="mv-vp-pipnote">{t("movies.playerPipOn")}</span> : null}
    </div>
  );
}
