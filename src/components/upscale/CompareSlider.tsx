import React, { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, Volume1, MoveHorizontal, SkipBack, SkipForward } from "lucide-react";
import { useI18n } from "@/app/i18n";

/**
 * Сравнение «до/после» с перетаскиваемым разделителем.
 *
 * Один компонент на два режима:
 *  - kind="photo": две картинки под одним общим zoom/pan — колесо мыши (к точке
 *    под курсором), перетаскивание или кнопки 100/200/400/Fit. Разделитель
 *    привязан к ПИКСЕЛЯМ изображения: при увеличении и сдвиге полоса едет вместе
 *    с картинкой, поэтому сравнивать можно любую выбранную деталь;
 *  - kind="video": два <video> с общей кареткой: play/pause, перемотка, скорость
 *    и выбор дорожки, которую слышно. Ведомое видео подтягивается к ведущему по
 *    playbackRate (дрейф < 10 мс не трогаем — иначе «дрожание» скорости).
 *
 * Разделитель не «режет» контент: обе стороны — это один и тот же кадр в одной
 * и той же геометрии, а видимая часть ограничивается clip-path. Поэтому
 * изображения совпадают пиксель-в-пиксель даже под зумом.
 */
export interface CompareSliderProps {
  kind: "photo" | "video";
  originalSrc: string;
  resultSrc: string;
  originalLabel?: string;
  resultLabel?: string;
  /** Пропорция кадра (ширина/высота): блок не «прыгает» до загрузки медиа. */
  aspect?: number;
  maxHeight?: string;
  /**
   * Частота кадров результата: шаг «±1 кадр» идёт по ней (60 fps → шаг 16.7 мс,
   * так видно именно вставленные кадры, а не проскок через два-три).
   */
  fps?: number;
  /** Страница не видима — видео надо поставить на паузу (звук не должен играть). */
  active?: boolean;
}

const RATES = [1, 1.5, 2, 0.5];
/** Зум фото: Fit и 100% считаются на месте, остальное — фиксированные кратности. */
const ZOOMS: { label: string; value: number }[] = [
  { label: "Fit", value: 1 },
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "100%", value: 0 },
  { label: "200%", value: 2 },
  { label: "400%", value: 4 },
];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Подтянуть ведомое видео к ведущему по дрейфу (мс). */
function driftMs(a: HTMLVideoElement, b: HTMLVideoElement): number {
  return (a.currentTime - b.currentTime) * 1000;
}

export default function CompareSlider({
  kind,
  originalSrc,
  resultSrc,
  originalLabel,
  resultLabel,
  aspect = 16 / 9,
  maxHeight = "58vh",
  fps = 30,
  active = true,
}: CompareSliderProps) {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const refA = useRef<HTMLVideoElement>(null);
  const refB = useRef<HTMLVideoElement>(null);

  /** Разделитель — доля ШИРИНЫ ИЗОБРАЖЕНИЯ (0…1), а не окна: см. splitX ниже. */
  const [split, setSplit] = useState(0.5);
  /** Общий вид фото: масштаб и сдвиг (относительно центра блока). */
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  /** Размер блока и размер вписанного в него изображения (object-fit: contain). */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [disp, setDisp] = useState({ w: 0, h: 0 });
  /** Масштаб режима «100%» (пиксель в пиксель): считается по факту загрузки. */
  const [oneToOne, setOneToOne] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [ar, setAr] = useState(aspect);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [audioSide, setAudioSide] = useState<"orig" | "result">("orig");

  const dragSplit = useRef(false);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  // Актуальные размеры и вид читают глобальные слушатели: пересоздавать их на
  // каждое движение мыши незачем.
  const viewRef = useRef(view);
  const dispRef = useRef(disp);
  const boxRef = useRef(box);
  viewRef.current = view;
  dispRef.current = disp;
  boxRef.current = box;

  /** Размер блока и вписанной картинки: он же нужен для границ панорамирования. */
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const natW = kind === "photo" ? imgRef.current?.naturalWidth || 0 : 0;
    const natH = kind === "photo" ? imgRef.current?.naturalHeight || 0 : 0;
    const ratio = natW && natH ? natW / natH : ar || 16 / 9;
    const w = Math.min(r.width, r.height * ratio);
    setBox({ w: r.width, h: r.height });
    setDisp({ w, h: w / ratio });
    if (natW && w > 0) setOneToOne(Math.max(1, natW / w));
  }, [ar, kind]);

  useEffect(() => {
    measure();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /** Сдвиг не даёт утащить картинку целиком: она всегда покрывает блок. */
  const clampView = useCallback((v: { z: number; x: number; y: number }) => {
    const d = dispRef.current;
    const b = boxRef.current;
    const maxX = Math.max(0, (d.w * v.z - b.w) / 2);
    const maxY = Math.max(0, (d.h * v.z - b.h) / 2);
    return { z: v.z, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
  }, []);

  /** Зум колесом: масштаб растёт к точке под курсором (обычный жест в редакторах). */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || kind !== "photo") return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((prev) => {
        const z = clamp(prev.z * factor, MIN_ZOOM, MAX_ZOOM);
        if (Math.abs(z - prev.z) < 1e-4) return prev;
        const ux = (mx - r.width / 2 - prev.x) / prev.z;
        const uy = (my - r.height / 2 - prev.y) / prev.z;
        return clampView({ z, x: mx - r.width / 2 - ux * z, y: my - r.height / 2 - uy * z });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampView, kind]);

  // --- Разделитель + панорамирование фото (одни глобальные слушатели) ---
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (dragSplit.current) {
        // Позиция ручки переводится в долю изображения — она остаётся на том же
        // месте картинки, даже когда та увеличена или сдвинута.
        const d = dispRef.current;
        const v = viewRef.current;
        const span = d.w * v.z || 1;
        setSplit(clamp(0.5 + (e.clientX - r.left - r.width / 2 - v.x) / span, 0, 1));
        return;
      }
      const pd = panDrag.current;
      if (pd) {
        setView((prev) =>
          clampView({ ...prev, x: prev.x + (e.clientX - pd.x), y: prev.y + (e.clientY - pd.y) }),
        );
        panDrag.current = { x: e.clientX, y: e.clientY };
      }
    };
    const mu = () => {
      dragSplit.current = false;
      panDrag.current = null;
    };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [clampView]);

  // --- Синхронизация видео ---
  useEffect(() => {
    if (kind !== "video" || !playing) return undefined;
    const timer = window.setInterval(() => {
      const a = refA.current;
      const b = refB.current;
      if (!a || !b) return;
      const d = driftMs(a, b);
      if (Math.abs(d) > 120) {
        b.currentTime = a.currentTime; // сильное расхождение — жёсткая перемотка
        b.playbackRate = 1;
      } else {
        b.playbackRate = Math.min(rate * 1.06, Math.max(rate * 0.94, rate + (d / 1000) * rate));
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [kind, playing, rate]);

  // Звучит ровно одна дорожка: иначе двойной звук даёт слышимое «эхо».
  useEffect(() => {
    if (refA.current) refA.current.muted = audioSide !== "orig";
    if (refB.current) refB.current.muted = audioSide !== "result";
  }, [audioSide, playing, kind, originalSrc, resultSrc]);

  // Уход со страницы — стоп (звук не должен играть фоном).
  useEffect(() => {
    if (active || kind !== "video") return;
    try {
      refA.current?.pause();
      refB.current?.pause();
    } catch {
      /* noop */
    }
    setPlaying(false);
  }, [active, kind]);

  const toggle = () => {
    const a = refA.current;
    const b = refB.current;
    if (!a || !b) return;
    if (playing) {
      a.pause();
      b.pause();
      setPlaying(false);
      return;
    }
    b.currentTime = a.currentTime;
    a.playbackRate = rate;
    b.playbackRate = rate;
    Promise.all([a.play(), b.play()])
      .then(() => setPlaying(true))
      .catch(() => {
        /* автоплей может быть запрещён политикой */
      });
  };

  const seek = (frac: number) => {
    const a = refA.current;
    const b = refB.current;
    if (!a) return;
    const dur = a.duration || 0;
    if (!dur) return;
    setPos(frac);
    a.currentTime = frac * dur;
    if (b) b.currentTime = frac * (b.duration || dur);
  };

  const changeRate = (r: number) => {
    setRate(r);
    if (refA.current) refA.current.playbackRate = r;
    if (refB.current) refB.current.playbackRate = r;
  };

  /**
   * Шаг на один кадр результата: пауза + сдвиг обеих дорожек на 1/fps.
   * Именно так видно ВСТАВЛЕННЫЕ кадры: на паузе проматываем по одному.
   */
  const stepFrame = (dir: number) => {
    const a = refA.current;
    const b = refB.current;
    if (!a) return;
    if (playing) {
      a.pause();
      b?.pause();
      setPlaying(false);
    }
    const step = 1 / Math.max(1, fps || 30);
    const next = Math.min(Math.max(0, a.currentTime + dir * step), a.duration || 0);
    a.currentTime = next;
    if (b) b.currentTime = Math.min(next, b.duration || next);
    setPos(a.duration ? next / a.duration : 0);
  };

  const mediaStyle: React.CSSProperties =
    kind === "photo"
      ? {
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
          transformOrigin: "center center",
        }
      : {};

  /** Кнопки зума: 100% считается от фактического размера картинки. */
  const changeZoom = (value: number) => {
    const z = clamp(value === 0 ? oneToOne : value, MIN_ZOOM, MAX_ZOOM);
    setView((prev) => clampView({ z, x: (prev.x * z) / prev.z, y: (prev.y * z) / prev.z }));
  };

  const resetView = () => setView({ z: 1, x: 0, y: 0 });

  const startPan = (e: React.MouseEvent) => {
    if (kind !== "photo") return;
    panDrag.current = { x: e.clientX, y: e.clientY };
  };

  const zoomPct = Math.round(view.z * 100);
  /** Активна ли кнопка зума: 100% считается по фактическому масштабу картинки. */
  const zoomActive = (value: number) =>
    value === 0 ? Math.abs(view.z - oneToOne) < 0.05 : view.z === value;

  /**
   * Положение разделителя на экране — из доли изображения: блок центрирует
   * картинку, масштаб идёт от центра, сдвиг — поверх. Клипы считаются в
   * пикселях, поэтому полоса остаётся на том же пикселе картинки при зуме.
   */
  const splitX = box.w ? box.w / 2 + view.x + (split - 0.5) * disp.w * view.z : 0;
  const leftPx = clamp(splitX, 0, box.w);
  const rightPx = Math.max(0, box.w - leftPx);

  return (
    <div className="up-cmp">
      <div
        className={`up-cmp-wrap${kind === "photo" && view.z > 1 ? " is-zoom" : ""}`}
        ref={wrapRef}
        style={{ ["--up-ar" as string]: ar, ["--up-maxh" as string]: maxHeight }}
        onMouseDown={startPan}
        onDoubleClick={resetView}
        onContextMenu={(e) => {
          e.preventDefault();
          resetView();
        }}
        title={kind === "photo" ? t("up.cmpHint") : ""}
      >
        {/* Слой «до» — видно левую часть до разделителя */}
        <div className="up-cmp-layer" style={{ clipPath: `inset(0 ${rightPx}px 0 0)` }}>
          {kind === "photo" ? (
            <img
              ref={imgRef}
              className="up-cmp-img"
              src={originalSrc}
              style={mediaStyle}
              alt={originalLabel || "original"}
              draggable={false}
              onLoad={measure}
            />
          ) : (
            <video
              ref={refA}
              className="up-cmp-img"
              src={originalSrc}
              playsInline
              loop
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth) setAr(v.videoWidth / v.videoHeight);
                setDur(v.duration || 0);
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration) setPos(v.currentTime / v.duration);
              }}
              onEnded={() => setPlaying(false)}
            />
          )}
        </div>

        {/* Слой «после» — правая часть */}
        <div className="up-cmp-layer" style={{ clipPath: `inset(0 0 0 ${leftPx}px)` }}>
          {kind === "photo" ? (
            <img
              className="up-cmp-img"
              src={resultSrc}
              style={mediaStyle}
              alt={resultLabel || "result"}
              draggable={false}
            />
          ) : (
            <video ref={refB} className="up-cmp-img" src={resultSrc} playsInline loop muted />
          )}
        </div>

        {/* Разделитель */}
        <div
          className="up-cmp-handle"
          style={{ left: `${leftPx}px` }}
          onMouseDown={(e) => {
            // Только разделитель: иначе при увеличении жест ушёл бы в сдвиг картинки.
            e.stopPropagation();
            dragSplit.current = true;
          }}
        >
          <span className="up-cmp-grip">
            <MoveHorizontal size={14} />
          </span>
        </div>

        {originalLabel ? <span className="up-cmp-tag up-cmp-tag-l">{originalLabel}</span> : null}
        {resultLabel ? <span className="up-cmp-tag up-cmp-tag-r">{resultLabel}</span> : null}
      </div>

      {/* --- Управление: фото — зум, видео — транспорт --- */}
      {kind === "photo" ? (
        <div className="up-cmp-controls">
          {ZOOMS.map((z) => (
            <button
              key={z.label}
              type="button"
              className={`badge tone-neutral${zoomActive(z.value) ? " is-active" : ""}`}
              onClick={() => changeZoom(z.value)}
            >
              {z.label}
            </button>
          ))}
          <span className="muted-sm">{`${zoomPct}%`}</span>
          <span className="muted-sm">{t("up.cmpHint")}</span>
        </div>
      ) : (
        <div className="up-cmp-controls">
          <button type="button" className="icon-btn" onClick={() => stepFrame(-1)} title="-1 кадр">
            <SkipBack size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={toggle}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button type="button" className="icon-btn" onClick={() => stepFrame(1)} title="+1 кадр">
            <SkipForward size={15} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={pos}
            onChange={(e) => seek(Number(e.target.value))}
            className="up-cmp-seek"
          />
          <span className="muted-sm">{fmtTime(pos, dur)}</span>
          <select
            className="text-input up-cmp-rate"
            value={String(rate)}
            onChange={(e) => changeRate(Number(e.target.value))}
          >
            {RATES.map((r) => (
              <option key={r} value={String(r)}>
                {r}×
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setAudioSide((s) => (s === "orig" ? "result" : "orig"))}
            title={audioSide === "orig" ? originalLabel : resultLabel}
          >
            {audioSide === "orig" ? <Volume2 size={15} /> : <Volume1 size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}

/** mm:ss для каретки видео. */
function fmtTime(frac: number, dur: number): string {
  const total = Math.max(0, Math.round((frac || 0) * (dur || 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
