import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Star,
  Play,
  BookmarkCheck,
  Check,
  Eye,
  Clock,
  Calendar,
  AlertTriangle,
  Users,
  Image as ImageIcon,
  Film,
  Tv,
  Layers,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Bookmark,
  Plus,
} from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, IconBtn } from "@/components/ui";
import { usePageActive } from "@/components/Toolbar";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import SourcesList from "@/pages/movies/parts/SourcesList";
import { mediaErrorText } from "@/pages/movies/parts/MediaCatalog";
import MediaCard from "@/pages/movies/parts/MediaCard";
import { imgUrl, imgCssUrl } from "@/pages/movies/lib/mediaImg";
import { stepIndex } from "@/pages/movies/lib/gallery";
import type {
  MediaKind,
  MediaSummary,
  MediaDetails,
  MediaState,
  MediaWatchStatus,
  MediaBookmarkList,
} from "@/api/types";

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
  /**
   * Открыть плеер. Второй аргумент — название тайтла: вкладка «Поиск раздач»
   * сразу ищет по нему (пользователю не нужно вводить название руками).
   */
  onOpenPlayer: (trailerKey: string | null, query?: string | null) => void;
  /** Уведомить страницу, что список/оценки/статистика изменились. */
  onChanged: () => void;
}

const TABS = ["overview", "cast", "gallery", "similar"] as const;
type TabId = (typeof TABS)[number];

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
  kind,
  id,
  onClose,
  onOpenTitle,
  onOpenPlayer,
  onChanged,
}: MediaDetailModalProps) {
  const { t } = useI18n();
  // keep-alive: страница может быть скрыта, тогда модалку не показываем (портал
  // живёт вне .page-host и правилом visibility:hidden не накрывается).
  const active = usePageActive();
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [personal, setPersonal] = useState<MediaState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{
    text: string;
    needsKey: boolean;
    needsProxy: boolean;
  } | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [busy, setBusy] = useState(false);
  /** Индекс открытого фото в ленте галереи (null — лайтбокс закрыт). */
  const [lightbox, setLightbox] = useState<number | null>(null);

  /** Лента галереи: кадры + постеры (индекс = позиция в лайтбоксе). */
  const gallery = details ? [...details.gallery.backdrops, ...details.gallery.posters] : [];
  /** Длина ленты для обработчика клавиатуры (он живёт дольше одного рендера). */
  const galleryLen = useRef(0);
  galleryLen.current = gallery.length;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDetails(null);
    setPersonal(null);
    setLightbox(null); // закрываем лайтбокс: лента галереи нового тайтла другая
    try {
      const d = await api.moviesDetails(kind, id);
      setDetails(d);
      // Личный статус грузим отдельно: его отсутствие не критично.
      try {
        setPersonal(await api.moviesState(kind, id));
      } catch {
        setPersonal(null);
      }
    } catch (e) {
      setError(mediaErrorText(t, e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Esc закрывает лайтбокс/модалку, ←/→ перелистывают фото в лайтбоксе.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightbox != null) setLightbox(null);
        else onClose();
        return;
      }
      if (lightbox == null) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setLightbox((i) => stepIndex(i, e.key === "ArrowRight" ? 1 : -1, galleryLen.current));
      }
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
        kind: details.kind,
        id: details.id,
        title: details.title,
        poster: details.poster || "",
        year: details.year,
        runtime: details.runtime,
        genres: details.genres,
        status,
      });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } catch {
      /* ошибку сети покажет следующая загрузка */
    } finally {
      setBusy(false);
    }
  };

  const removeFromList = async () => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesRemoveWatchlist(details.kind, details.id);
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /** Оценка 1–10 (0 — снять). */
  const rate = async (n: number) => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesRate({ kind: details.kind, id: details.id, title: details.title, rating: n });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /** Отметить «просмотрено» (попадёт в статистику часов/жанров/актёров). */
  const markWatched = async () => {
    if (!details) return;
    setBusy(true);
    try {
      await api.moviesWatch({
        kind: details.kind,
        id: details.id,
        title: details.title,
        genres: details.genres,
        cast: details.cast.map((c) => ({ name: c.name })),
        runtime: details.runtime,
        progress: 1,
      });
      await api.moviesSetWatchlist({
        kind: details.kind,
        id: details.id,
        title: details.title,
        poster: details.poster || "",
        year: details.year,
        runtime: details.runtime,
        genres: details.genres,
        status: "watched",
      });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const status = personal?.watchlist?.status || null;
  const myRating = personal?.rating?.rating || 0;
  const KindIcon = (details?.kind || kind) === "tv" ? Tv : Film;

  // --- Свои закладки (папки) — можно завести сколько угодно, в отличие от
  //     watchlist (один статус на тайтл на всё приложение). ---
  const [bmOpen, setBmOpen] = useState(false);
  const [bmLists, setBmLists] = useState<MediaBookmarkList[]>([]);
  const [bmMemberIds, setBmMemberIds] = useState<number[]>([]);
  const [bmNewName, setBmNewName] = useState("");
  const [bmBusy, setBmBusy] = useState(false);

  const openBookmarkPopover = async () => {
    if (!details) return;
    setBmOpen((v) => !v);
    if (bmOpen) return; // уже открыт — просто закрываем, данные не нужны
    try {
      const [all, state] = await Promise.all([
        api.moviesBookmarks(),
        api.moviesBookmarkState(details.kind, details.id),
      ]);
      setBmLists(all.lists);
      setBmMemberIds(state.lists);
    } catch {
      setBmLists([]);
      setBmMemberIds([]);
    }
  };

  const toggleBookmarkList = async (listId: number) => {
    if (!details) return;
    setBmBusy(true);
    try {
      const member = bmMemberIds.includes(listId);
      if (member) {
        await api.moviesBookmarkRemoveItem(listId, details.kind, details.id);
        setBmMemberIds((ids) => ids.filter((x) => x !== listId));
      } else {
        await api.moviesBookmarkAddItem(listId, {
          kind: details.kind,
          id: details.id,
          title: details.title,
          poster: details.poster || "",
          year: details.year,
        });
        setBmMemberIds((ids) => [...ids, listId]);
      }
    } finally {
      setBmBusy(false);
    }
  };

  // --- Прогресс просмотра сериала: сезон/серия, на которой остановился ---
  const [prSeason, setPrSeason] = useState(0);
  const [prEpisode, setPrEpisode] = useState(0);
  const [prBusy, setPrBusy] = useState(false);
  // Какой сезон сейчас развёрнут кружками — не обязательно тот, где остановился
  // просмотр (можно открыть другой сезон и подправить прогресс не по порядку).
  const [viewSeason, setViewSeason] = useState(1);
  useEffect(() => {
    const s = personal?.watchlist?.watched_season || 0;
    setPrSeason(s);
    setPrEpisode(personal?.watchlist?.watched_episode || 0);
    setViewSeason(s > 0 ? s : 1);
  }, [personal]);

  const saveProgress = async (season: number, episode: number) => {
    if (!details) return;
    setPrBusy(true);
    try {
      await api.moviesSetWatchlist({
        kind: details.kind,
        id: details.id,
        title: details.title,
        poster: details.poster || "",
        year: details.year,
        runtime: details.runtime,
        genres: details.genres,
        // Прогресс без статуса означал бы "не в списке" — если тайтла ещё
        // нет в списке, отметка серии сама переводит его в "смотрю".
        status: personal?.watchlist?.status || "watching",
        watchedSeason: season,
        watchedEpisode: episode,
      });
      setPersonal(await api.moviesState(details.kind, details.id));
      onChanged();
    } finally {
      setPrBusy(false);
    }
  };

  const createBookmarkList = async () => {
    const name = bmNewName.trim();
    if (!name || !details) return;
    setBmBusy(true);
    try {
      const r = await api.moviesBookmarkCreate(name);
      setBmLists((prev) => [r.list, ...prev]);
      setBmNewName("");
      // Новая папка — сразу с текущим тайтлом внутри, иначе пришлось бы
      // создавать папку и потом отдельным кликом добавлять в неё же.
      await api.moviesBookmarkAddItem(r.list.id, {
        kind: details.kind,
        id: details.id,
        title: details.title,
        poster: details.poster || "",
        year: details.year,
      });
      setBmMemberIds((ids) => [...ids, r.list.id]);
    } finally {
      setBmBusy(false);
    }
  };

  if (!active) return null;

  return createPortal(
    <div className="app-modal-backdrop mv-modal-backdrop" onClick={onClose}>
      <Glass className="mv-detail glass-solid" onClick={(e) => e.stopPropagation()}>
        <button className="mv-close mv-close-abs" onClick={onClose} title={t("common.close")}>
          <X size={16} />
        </button>

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
              {details.backdrop && (
                <div
                  className="mv-hero-bg"
                  style={{ backgroundImage: imgCssUrl(details.backdrop) }}
                />
              )}
              <div className="mv-hero-shade" />
              <div className="mv-detail-hero-body">
                {details.poster ? (
                  <img className="mv-detail-poster" src={imgUrl(details.poster)} alt="" />
                ) : (
                  <div className="mv-detail-poster tone-violet">
                    <KindIcon size={28} />
                  </div>
                )}
                <div className="mv-detail-info">
                  <div className="mv-hero-eyebrow">
                    <KindIcon size={13} />{" "}
                    {details.kind === "tv" ? t("movies.series") : t("movies.movie")}
                  </div>
                  <h2 className="mv-hero-title">{details.title}</h2>
                  {details.originalTitle && details.originalTitle !== details.title && (
                    <div className="muted-sm">{details.originalTitle}</div>
                  )}
                  {details.tagline && <div className="mv-tagline">«{details.tagline}»</div>}

                  <div className="mv-hero-meta">
                    {details.voteAverage > 0 && (
                      <span>
                        <Star size={12} strokeWidth={2.4} /> {details.voteAverage.toFixed(1)} (
                        {details.voteCount})
                      </span>
                    )}
                    {details.date && (
                      <span>
                        <Calendar size={12} /> {details.date}
                      </span>
                    )}
                    <span>
                      <Clock size={12} />{" "}
                      {runtimeText(details.runtime, details.seasons, details.episodes)}
                    </span>
                    {details.ageRating && <span className="mv-age">{details.ageRating}</span>}
                    {details.status && <Badge tone="neutral">{details.status}</Badge>}
                  </div>

                  {/* Действия: трейлер/плеер, список просмотра */}
                  <div className="mv-detail-actions">
                    <Btn
                      variant="primary"
                      icon={Play}
                      onClick={() => onOpenPlayer(details.trailer?.key || null, details.title)}
                    >
                      {t("movies.watchTrailer")}
                    </Btn>
                    <IconBtn
                      icon={BookmarkCheck}
                      active={status === "plan"}
                      onClick={() => void setStatus("plan")}
                      disabled={busy}
                      title={t("movies.statusPlan")}
                    />
                    <IconBtn
                      icon={Eye}
                      active={status === "watching"}
                      onClick={() => void setStatus("watching")}
                      disabled={busy}
                      title={t("movies.statusWatching")}
                    />
                    <IconBtn
                      icon={Check}
                      active={status === "watched"}
                      onClick={() => void markWatched()}
                      disabled={busy}
                      title={t("movies.statusWatched")}
                    />
                    {status && (
                      <Btn icon={X} onClick={() => void removeFromList()} disabled={busy}>
                        {t("movies.removeFromList")}
                      </Btn>
                    )}
                    <div className="mv-bookmark-wrap">
                      <Btn
                        variant={bmMemberIds.length > 0 ? "primary" : "ghost"}
                        icon={Bookmark}
                        onClick={() => void openBookmarkPopover()}
                        disabled={bmBusy}
                      >
                        {bmMemberIds.length > 0
                          ? t("movies.bookmarksAddedCount", { n: bmMemberIds.length })
                          : t("movies.bookmarksAdd")}
                      </Btn>
                      {bmOpen && (
                        <Glass className="mv-bookmark-pop glass-solid" onClick={(e) => e.stopPropagation()}>
                          {bmLists.length === 0 && (
                            <div className="muted-sm">{t("movies.bookmarksEmpty")}</div>
                          )}
                          {bmLists.map((l) => (
                            <label key={l.id} className="mv-bookmark-row">
                              <input
                                type="checkbox"
                                checked={bmMemberIds.includes(l.id)}
                                disabled={bmBusy}
                                onChange={() => void toggleBookmarkList(l.id)}
                              />
                              <span>{l.name}</span>
                            </label>
                          ))}
                          <div className="mv-bookmark-new">
                            <input
                              className="text-input"
                              placeholder={t("movies.bookmarksNewPlaceholder")}
                              value={bmNewName}
                              onChange={(e) => setBmNewName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void createBookmarkList();
                              }}
                            />
                            <IconBtn
                              icon={Plus}
                              title={t("movies.bookmarksCreate")}
                              disabled={bmBusy || !bmNewName.trim()}
                              onClick={() => void createBookmarkList()}
                            />
                          </div>
                        </Glass>
                      )}
                    </div>
                  </div>

                  {/* Личная оценка 1–10 + сброс случайной оценки */}
                  <div className="mv-detail-rating">
                    <span className="muted-sm">{t("movies.myRating")}</span>
                    <StarRating value={myRating} onRate={rate} />
                    {myRating > 0 && (
                      <button
                        className="mv-chip-btn mv-rating-reset"
                        onClick={() => void rate(0)}
                        disabled={busy}
                        title={t("movies.resetRating")}
                      >
                        <RotateCcw size={12} /> {t("movies.resetRating")}
                      </button>
                    )}
                  </div>

                  {/* Прогресс по сериям — только у сериалов, кружками (компактно,
                      кликом отмечаются просмотренные). episodeCount — по
                      КОНКРЕТНОМУ сезону (seasonList из TMDB), не общее число
                      серий по сериалу. Опциональная цепочка на seasonList —
                      сервер кэширует сырой ответ TMDB, а старый закэшированный
                      процесс сервера (до перезапуска) может ещё не знать про
                      это поле в ответе API. */}
                  {details.kind === "tv" && (details.seasonList?.length ?? 0) > 0 && (
                    <div className="mv-progress">
                      <div className="mv-progress-head">
                        <span className="muted-sm">{t("movies.watchProgress")}</span>
                        {prSeason > 0 && (
                          <span className="muted-sm">
                            {t("movies.seasonEpisodeShort", { s: prSeason, e: prEpisode })}
                          </span>
                        )}
                      </div>
                      <div className="mv-progress-seasons">
                        {(details.seasonList ?? []).map((s) => (
                          <button
                            key={s.number}
                            type="button"
                            className={`chip-toggle ${viewSeason === s.number ? "is-active" : ""}`}
                            onClick={() => setViewSeason(s.number)}
                          >
                            {t("movies.seasonShortN", { n: s.number })}
                            {(s.number < prSeason || (s.number === prSeason && prEpisode >= s.episodeCount)) &&
                              s.episodeCount > 0 && <Check size={11} />}
                          </button>
                        ))}
                      </div>
                      <div className="mv-progress-dots">
                        {Array.from(
                          {
                            length:
                              (details.seasonList ?? []).find((s) => s.number === viewSeason)
                                ?.episodeCount || 0,
                          },
                          (_, i) => i + 1,
                        ).map((ep) => {
                          const watched =
                            viewSeason < prSeason || (viewSeason === prSeason && ep <= prEpisode);
                          return (
                            <button
                              key={ep}
                              type="button"
                              className={`mv-progress-dot ${watched ? "is-watched" : ""}`}
                              disabled={prBusy}
                              title={t("movies.episodeN", { n: ep })}
                              onClick={() => {
                                // Клик по последней закрашенной серии текущего
                                // сезона — снять именно её (отступить на одну
                                // назад), иначе — закрасить всё до неё включительно.
                                if (viewSeason === prSeason && ep === prEpisode) {
                                  setPrEpisode(ep - 1);
                                  void saveProgress(viewSeason, ep - 1);
                                } else {
                                  setPrSeason(viewSeason);
                                  setPrEpisode(ep);
                                  void saveProgress(viewSeason, ep);
                                }
                              }}
                            >
                              {ep}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mv-detail-tabs">
              {TABS.map((tb) => (
                <button
                  key={tb}
                  className={tab === tb ? "is-active" : ""}
                  onClick={() => setTab(tb)}
                >
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
                    <div>
                      <span>{t("movies.factStatus")}</span>
                      <b>{details.status || "—"}</b>
                    </div>
                    <div>
                      <span>{t("movies.factRuntime")}</span>
                      <b>{runtimeText(details.runtime, details.seasons, details.episodes)}</b>
                    </div>
                    <div>
                      <span>{t("movies.factAge")}</span>
                      <b>{details.ageRating || "—"}</b>
                    </div>
                    <div>
                      <span>{t("movies.factGenres")}</span>
                      <b>{details.genres.map((g) => g.name).join(", ") || "—"}</b>
                    </div>
                    <div>
                      <span>{t("movies.factCountry")}</span>
                      <b>{details.countries.join(", ") || "—"}</b>
                    </div>
                    <div>
                      <span>{t("movies.factLang")}</span>
                      <b>{details.languages.join(", ") || "—"}</b>
                    </div>
                    <div>
                      <span>{t("movies.factBudget")}</span>
                      <b>{money(details.budget)}</b>
                    </div>
                    <div>
                      <span>{t("movies.factRevenue")}</span>
                      <b>{money(details.revenue)}</b>
                    </div>
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
                            {c.profile ? (
                              <img src={imgUrl(c.profile)} alt="" loading="lazy" />
                            ) : (
                              <Users size={18} />
                            )}
                          </div>
                          <div className="mv-person-name">{c.name}</div>
                          <div className="muted-sm">{c.character}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyHint icon={Users} text={t("movies.noCast")} />
                  )}
                  {details.crew.length > 0 && (
                    <div className="mv-crew">
                      {details.crew.map((c) => (
                        <span key={`${c.id}-${c.job}`} className="mv-crew-item">
                          <b>{c.job}</b> {c.name}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
              {/* Галерея: кадры и постеры (клик — лайтбокс, ←/→ листают) */}
              {tab === "gallery" &&
                (gallery.length > 0 ? (
                  <div className="mv-gallery">
                    {gallery.map((src, i) => (
                      <button key={i} className="mv-gallery-item" onClick={() => setLightbox(i)}>
                        <img src={imgUrl(src)} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyHint icon={ImageIcon} text={t("movies.noGallery")} />
                ))}

              {/* Похожие и рекомендованные */}
              {tab === "similar" &&
                (() => {
                  const list = details.recommendations.length
                    ? details.recommendations
                    : details.similar;
                  if (list.length === 0)
                    return <EmptyHint icon={Layers} text={t("movies.noSimilar")} />;
                  return (
                    <div className="mv-similar">
                      {list.map((s) => (
                        <MediaCard
                          key={`${s.kind}-${s.id}`}
                          item={s}
                          onSelect={(k, id) => onOpenTitle(k, id)}
                        />
                      ))}
                    </div>
                  );
                })()}
            </div>

            {/* «Где легально смотреть» + трейлер/плеер */}
            <SourcesList
              providers={details.providers}
              hasTrailer={!!details.trailer}
              onTrailer={() => onOpenPlayer(details.trailer?.key || null, details.title)}
              onTorrent={() => onOpenPlayer(null, details.title)}
            />
          </>
        )}
      </Glass>

      {/* Лайтбокс — сосед карточки (не внутри .mv-detail): у .glass есть
          backdrop-filter, а он создаёт containing block для position:fixed,
          из-за чего «полноэкранный» просмотр обрезался рамками карточки.
          Клики гасим (stopPropagation): иначе они всплывали до backdrop и
          закрывали саму карточку тайтла. */}
      {lightbox != null && gallery[lightbox] && (
        <div
          className="mv-lightbox"
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(null);
          }}
        >
          {gallery.length > 1 && (
            <button
              className="mv-lightbox-btn is-prev"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox((i) => stepIndex(i, -1, gallery.length));
              }}
              title={t("movies.prevImage")}
              aria-label={t("movies.prevImage")}
            >
              <ChevronLeft size={22} />
            </button>
          )}
          <img src={imgUrl(gallery[lightbox])} alt="" />
          {gallery.length > 1 && (
            <button
              className="mv-lightbox-btn is-next"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox((i) => stepIndex(i, 1, gallery.length));
              }}
              title={t("movies.nextImage")}
              aria-label={t("movies.nextImage")}
            >
              <ChevronRight size={22} />
            </button>
          )}
          <div className="mv-lightbox-count">
            {t("movies.photoOf", { i: lightbox + 1, n: gallery.length })}
          </div>
        </div>
      )}
    </div>,
    getOverlayRoot() ?? document.body,
  );
}
