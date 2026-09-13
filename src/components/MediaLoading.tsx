import React from "react";
import { Music2, Video } from "lucide-react";
import { Glass, ProgressBar } from "./ui";

/**
 * Единый блок загрузки для страниц «Видео» и «Музыка».
 *
 * Раньше на обеих страницах был простой ряд «крутилка + ProgressBar», из-за
 * чего загрузка выглядела по-разному/дёшево. Теперь это карточка в стиле
 * media-preview: арт с коническим индикатором прогресса, заголовок (что именно
 * качается), полоса прогресса и анимированные точки.
 *
 * indeterminate — когда точный процент ещё неизвестен (поиск/получение мета):
 * индикатор пульсирует, процент скрыт.
 */
export default function MediaLoading({
  kind,
  title,
  label,
  progress,
  indeterminate = false,
}: {
  kind: "video" | "music";
  title?: string;
  label: string;
  progress?: number;
  indeterminate?: boolean;
}) {
  const Icon = kind === "music" ? Music2 : Video;
  const tone = kind === "music" ? "violet" : "amber";
  const pct = Math.max(0, Math.min(100, Math.round(progress || 0)));
  return (
    <Glass className="media-loading">
      <div
        className={`media-loading-art tone-${tone} ${indeterminate ? "is-indeterminate" : ""}`}
        style={{ ["--p" as string]: `${pct}%` } as React.CSSProperties}
      >
        <Icon size={26} strokeWidth={1.6} />
      </div>
      <div className="media-loading-info">
        <div className="media-loading-title" title={title}>{title || label}</div>
        {!indeterminate && <div className="media-loading-bar"><ProgressBar value={pct} /></div>}
        <div className="media-loading-foot">
          <span className="media-loading-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="media-loading-label">{label}</span>
          {!indeterminate && <span className="media-loading-pct">{pct}%</span>}
        </div>
      </div>
    </Glass>
  );
}
