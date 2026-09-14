import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X, Star, Play, Bookmark, BookmarkCheck, Check, Eye, Clock, Calendar,
  AlertTriangle, Users, Image as ImageIcon, Film, Tv, Layers,
} from "lucide-react";
import { Glass, Btn, Badge, EmptyHint } from "../ui";
import { usePageActive } from "../Toolbar";
import { getOverlayRoot } from "../overlayHost";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import SourcesList from "./SourcesList";
import { mediaErrorText } from "./MediaCatalog";
import { imgUrl, imgCssUrl } from "./mediaImg";
import type {
  MediaKind, MediaSummary, MediaDetails, MediaState, MediaWatchStatus,
} from "../../api/types";

/**
 * Карточка тайтла (Seerr-style): большой постер/бэкдроп, метаданные, каст и
 * съёмочная группа, галерея, похожие/рекомендации, площадки «где смотреть»,
 * личный рейтинг 1–10 и статус просмотра (хранятся в локальной БД).
 */

interface MediaDetailModalProps {
  kind: MediaKind;
  id: number;
  summary?: MediaSummary | null;
  onClose: () => void;
  onOpenTitle: (kind: MediaKind, id: number) => void;
  onOpenPlayer: (trailerKey: string | null) => void;
  /** Уведомить страницу, что список/оценки/статистика изменились. */
  onChanged: () => void;
}

const TABS = ["overview", "cast", "gallery", "similar"] as const;
type TabId = typeof TABS[number];

/** Ряд звёзд 1–10 (клик — поставить оценку, повторный клик по той же — снять). */
function StarRating({ value, onRate }: { value: number; onRate: (n: number) => void }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="mv-stars" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          className={`mv-star ${n <= shown ? "is-on" : ""}`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onRate(n === value ? 0 : n)}
          title={String(n)}
        >
          <Star size={14} strokeWidth={2} fill={n <= shown ? "currentColor" : "none"} />
        </button>
      ))}
      <span className="mv-stars-value">{value > 0 ? `${value}/10` : "—"}</span>
    </div>
  );
}

function money(n: number): string {
  if (!n) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

function runtimeText(min?: number | null, seasons?: number, episodes?: number): string {
  if (seasons && seasons > 0) return `${seasons} · ${episodes || 0}`;
  if (!min) return "—";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

export default function MediaDetailModal({
  kind, id, summary, onClose, onOpenTitle, onOpenPlayer, onChanged,
}: MediaDetailModalProps) {
  const { t } = useI18n();
  // keep-alive: страница может быть скрыта, тогда модалку не показываем (портал
  // живёт вне .page-host и правилом visibility:hidden не накрывается).
  const active = usePageActive();
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [personal, setPersonal] = useState<MediaState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ text: string; needsKey: boolean; needsProxy: boolean } | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDetails(null);
    setPersonal(null);
    try {
      const d = await api.moviesDetails(kind, id);
      setDetails(d);
      // Личный статус грузим отдельно: его отсутствие не критично.
      try { setPersonal(await api.moviesState(kind, id)); } catch { setPersonal(null); }
    } catch (e) {
      setError(mediaErrorText(t, e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  useEffect(() => { void load(); }, [load]);

  // Esc закрывает модалку/лайтбокс.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightbox) setLightbox(null); else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose]);

  /** Сохранить статус в списке просмотра. */
  const setStatus = async (status: MediaWatchStatus) => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesSetWatchlist({
        kind: details.kind, id: details.id, title: details.title,
        poster: details.poster || "", year: details.year, runtime: details.runtime,
        genres: details.genres, status,
      });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } catch { /* ошибку сети покажет следующая загрузка */ }
    finally { setBusy(false); }
  };

  const removeFromList = async () => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesRemoveWatchlist(details.kind, details.id);
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally { setBusy(false); }
  };

  /** Оценка 1–10 (0 — снять). */
  const rate = async (n: number) => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesRate({ kind: details.kind, id: details.id, title: details.title, rating: n });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally { setBusy(false); }
  };

  /** Отметить «просмотрено» (попадёт в статистику часов/жанров/актёров). */
  const markWatched = async () => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesWatch({
        kind: details.kind, id: details.id, title: details.title,
        genres: details.genres, cast: details.cast.map((c) => ({ name: c.name })),
        runtime: details.runtime, progress: 1,
      });
      await api.moviesSetWatchlist({
        kind: details.kind, id: details.id, title: details.title,
        poster: details.poster || "", year: details.year, runtime: details.runtime,
        genres: details.genres, status: "watched",
      });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally { setBusy(false); }
  };

  const status = personal?.watchlist?.status || null;
  const myRating = personal?.rating?.rating || 0;
  const KindIcon = (details?.kind || kind) === "tv" ? Tv : Film;

  if (!active) return null;

  return createPortal(
    <div className="mv-modal-backdrop" onClick={onClose}>
      <Glass className="mv-detail" onClick={(e) => e.stopPropagation()}>
        <button className="mv-close mv-close-abs" onClick={onClose} title={t("common.close")}><X size={16} /></button>

        {loading && <div className="mv-detail-loading">{t("movies.loading")}</div>}

        {error && (
          <div className="mv-error-inline">
            <AlertTriangle size={15} style={{ color: "var(--coral)" }} />
            <span>{error.text}</span>
            {error.needsProxy && <span className="muted-sm">{t("movies.errProxyHint")}</span>}
          </div>
        )}

        {details && !loading && (
          <>
            <div className="mv-detail-hero">
              {details.backdrop && <div className="mv-hero-bg" style={{ backgroundImage: imgCssUrl(details.backdrop) }} />}
              <div className="mv-hero-shade" />
              <div className="mv-detail-hero-body">
                {details.poster
                  ? <img className="mv-detail-poster" src={imgUrl(details.poster)} alt="" />
                  : <div className="mv-detail-poster tone-violet"><KindIcon size={28} /></div>}
                <div className="mv-detail-info">
                  <div className="mv-hero-eyebrow">
                    <KindIcon size={13} /> {details.kind === "tv" ? t("movies.series") : t("movies.movie")}
                  </div>
                  <h2 className="mv-hero-title">{details.title}</h2>
                  {details.originalTitle && details.originalTitle !== details.title && (
                    <div className="muted-sm">{details.originalTitle}</div>
                  )}
                  {details.tagline && <div className="mv-tagline">«{details.tagline}»</div>}

                  <div className="mv-hero-meta">
                    {details.voteAverage > 0 && (
                      <span><Star size={12} strokeWidth={2.4} /> {details.voteAverage.toFixed(1)} ({details.voteCount})</span>
                    )}
                    {details.date && <span><Calendar size={12} /> {details.date}</span>}
                    <span><Clock size={12} /> {runtimeText(details.runtime, details.seasons, details.episodes)}</span>
                    {details.ageRating && <span className="mv-age">{details.ageRating}</span>}
                    {details.status && <Badge tone="neutral">{details.status}</Badge>}
                  </div>

                  {/* Действия: трейлер/плеер, список просмотра */}
                  <div className="mv-detail-actions">
                    <Btn variant="primary" icon={Play} onClick={() => onOpenPlayer(details.trailer?.key || null)}>
                      {t("movies.watchTrailer")}
                    </Btn>
                    <Btn icon={BookmarkCheck} onClick={() => void setStatus("plan")} disabled={busy}>
                      {t("movies.statusPlan")}
                    </Btn>
                    <Btn icon={Eye} onClick={() => void setStatus("watching")} disabled={busy}>
                      {t("movies.statusWatching")}
                    </Btn>
                    <Btn icon={Check} onClick={() => void markWatched()} disabled={busy}>
                      {t("movies.statusWatched")}
                    </Btn>
                    {status && (
                      <Btn icon={X} onClick={() => void removeFromList()} disabled={busy}>{t("movies.removeFromList")}</Btn>
                    )}
                  </div>

                  {/* Личная оценка 1–10 */}
                  <div className="mv-detail-rating">
                    <span className="muted-sm">{t("movies.myRating")}</span>
                    <StarRating value={myRating} onRate={rate} />
                  </div>
                </div>
              </div>
            </div>

            <div className="mv-detail-tabs">
              {TABS.map((tb) => (
                <button key={tb} className={tab === tb ? "is-active" : ""} onClick={() => setTab(tb)}>
                  {t(`movies.tab_${tb}`)}
                </button>
              ))}
            </div>

            <div className="mv-detail-body">
              {/* Обзор: описание + ключевые факты */}
              {tab === "overview" && (
                <div className="mv-overview">
                  {details.overview && <p className="mv-overview-text">{details.overview}</p>}
                  <div className="mv-facts">
                    <div><span>{t("movies.factStatus")}</span><b>{details.status || "—"}</b></div>
                    <div><span>{t("movies.factRuntime")}</span><b>{runtimeText(details.runtime, details.seasons, details.episodes)}</b></div>
                    <div><span>{t("movies.factAge")}</span><b>{details.ageRating || "—"}</b></div>
                    <div><span>{t("movies.factGenres")}</span><b>{details.genres.map((g) => g.name).join(", ") || "—"}</b></div>
                    <div><span>{t("movies.factCountry")}</span><b>{details.countries.join(", ") || "—"}</b></div>
                    <div><span>{t("movies.factLang")}</span><b>{details.languages.join(", ") || "—"}</b></div>
                    <div><span>{t("movies.factBudget")}</span><b>{money(details.budget)}</b></div>
                    <div><span>{t("movies.factRevenue")}</span><b>{money(details.revenue)}</b></div>
                  </div>
                </div>
              )}

              {/* Актёры + съёмочная группа */}
              {tab === "cast" && (
                <>
                  {details.cast.length > 0 ? (
                    <div className="mv-cast-grid">
                      {details.cast.map((c) => (
                        <div key={c.id} className="mv-person">
                          <div className="mv-person-photo">
                            {c.profile ? <img src={imgUrl(c.profile)} alt="" loading="lazy" /> : <Users size={18} />}
                          </div>
                          <div className="mv-person-name">{c.name}</div>
                          <div className="muted-sm">{c.character}</div>
                        </div>
                      ))}
                    </div>
                  ) : <EmptyHint icon={Users} text={t("movies.noCast")} />}
                  {details.crew.length > 0 && (
                    <div className="mv-crew">
                      {details.crew.map((c) => (
                        <span key={`${c.id}-${c.job}`} className="mv-crew-item"><b>{c.job}</b> {c.name}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
              {/* Галерея: кадры и постеры (клик — лайтбокс) */}
              {tab === "gallery" && (
                (details.gallery.backdrops.length + details.gallery.posters.length) > 0 ? (
                  <div className="mv-gallery">
                    {[...details.gallery.backdrops, ...details.gallery.posters].map((src, i) => (
                      <button key={i} className="mv-gallery-item" onClick={() => setLightbox(src)}>
                        <img src={imgUrl(src)} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : <EmptyHint icon={ImageIcon} text={t("movies.noGallery")} />
              )}

              {/* Похожие и рекомендованные */}
              {tab === "similar" && (() => {
                const list = details.recommendations.length ? details.recommendations : details.similar;
                if (list.length === 0) return <EmptyHint icon={Layers} text={t("movies.noSimilar")} />;
                return (
                  <div className="mv-similar">
                    {list.map((s) => (
                      <button key={`${s.kind}-${s.id}`} className="mv-card" onClick={() => onOpenTitle(s.kind, s.id)}>
                        <div className="mv-card-art tone-violet">
                          {s.poster ? <img src={imgUrl(s.poster)} alt="" loading="lazy" /> : <Film size={20} strokeWidth={1.5} />}
                        </div>
                        <div className="mv-card-title">{s.title}</div>
                        <div className="mv-card-meta">{s.year || "—"}</div>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* «Где легально смотреть» + трейлер/плеер */}
            <SourcesList
              providers={details.providers}
              hasTrailer={!!details.trailer}
              onTrailer={() => onOpenPlayer(details.trailer?.key || null)}
              onTorrent={() => onOpenPlayer(null)}
            />
          </>
        )}

        </Glass>

      {/* Лайтбокс — сосед карточки (не внутри .mv-detail): у .glass есть
          backdrop-filter, а он создаёт containing block для position:fixed,
          из-за чего «полноэкранный» просмотр обрезался рамками карточки. */}
      {lightbox && (
        <div className="mv-lightbox" onClick={() => setLightbox(null)}>
          <img src={imgUrl(lightbox)} alt="" />
        </div>
      )}
    </div>,
    getOverlayRoot() ?? document.body
  );
}