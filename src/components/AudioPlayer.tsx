import React, { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, RotateCw, Gauge } from "lucide-react";
import { useI18n } from "../i18n";

/**
 * AudioPlayer — стилизованный плеер в стиле приложения (стекло + янтарный
 * акцент) поверх нативного <audio>. Умеет:
 *   - play / pause;
 *   - перемотку секундами: ±5 с и ±10 с (стрелки клавиатуры на полосе — по 1 с);
 *   - перетаскивание полосы позиции;
 *   - время «текущее / общее» в формате м:сс или ч:мм:сс (аудиокниги длинные);
 *   - выбор скорости воспроизведения (0.75x … 2x).
 *
 * `compact` — уменьшенный вариант для коротких превью (например референс-сэмпл).
 */

export interface AudioPlayerProps {
  src?: string;
  compact?: boolean;
  className?: string;
}

const RATES = [0.75, 1, 1.25, 1.5, 2];

/** Секунды → м:сс / ч:мм:сс. */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export default function AudioPlayer({ src, compact = false, className = "" }: AudioPlayerProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);

  // Новый файл → сбрасываем позицию и состояние (сам трек подхватывает <audio>).
  useEffect(() => {
    setCur(0);
    setDur(0);
    setPlaying(false);
  }, [src]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { a.pause(); setPlaying(false); }
  };

  const seekTo = (sec: number) => {
    const a = ref.current;
    if (!a) return;
    const max = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : dur;
    const next = Math.max(0, Math.min(max || 0, sec));
    a.currentTime = next;
    setCur(next);
  };

  const step = (delta: number) => seekTo((ref.current?.currentTime || 0) + delta);

  const cycleRate = () => {
    const i = RATES.indexOf(rate);
    setRate(RATES[(i + 1) % RATES.length]);
  };

  const pct = dur > 0 ? (cur / dur) * 100 : 0;

  return (
    <div className={`audio-player ${compact ? "is-compact" : ""} ${className}`.trim()}>
      <audio
        ref={ref}
        src={src || undefined}
        preload="metadata"
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCur(0); }}
      />

      <button type="button" className="ap-btn ap-play" disabled={!src}
        title={playing ? t("player.pause") : t("player.play")} onClick={toggle}>
        {playing ? <Pause size={16} strokeWidth={2.4} /> : <Play size={16} strokeWidth={2.4} />}
      </button>

      {!compact && (
        <div className="ap-jumps">
          <button type="button" className="ap-btn" disabled={!src} title={t("player.back10")} onClick={() => step(-10)}>
            <RotateCcw size={15} strokeWidth={2} /><span className="ap-btn-num">10</span>
          </button>
          <button type="button" className="ap-btn" disabled={!src} title={t("player.back5")} onClick={() => step(-5)}>
            <RotateCcw size={15} strokeWidth={2} /><span className="ap-btn-num">5</span>
          </button>
        </div>
      )}

      <span className="ap-time">{fmtTime(cur)}</span>

      <div className="ap-track" style={{ ["--ap-progress" as string]: `${pct}%` } as React.CSSProperties}>
        <input type="range" className="ap-seek" min={0} max={dur || 0} step={1} value={cur}
          disabled={!src || !dur} aria-label={t("player.seek")}
          onChange={(e) => seekTo(Number(e.target.value))} />
      </div>

      <span className="ap-time ap-time-total">{fmtTime(dur)}</span>

      {!compact && (
        <>
          <div className="ap-jumps">
            <button type="button" className="ap-btn" disabled={!src} title={t("player.forward5")} onClick={() => step(5)}>
              <RotateCw size={15} strokeWidth={2} /><span className="ap-btn-num">5</span>
            </button>
            <button type="button" className="ap-btn" disabled={!src} title={t("player.forward10")} onClick={() => step(10)}>
              <RotateCw size={15} strokeWidth={2} /><span className="ap-btn-num">10</span>
            </button>
          </div>
          <button type="button" className="ap-rate" title={t("player.speed")} onClick={cycleRate}>
            <Gauge size={13} strokeWidth={2} />{rate}×
          </button>
        </>
      )}
    </div>
  );
}
