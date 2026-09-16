import { useEffect, useState, useCallback, useRef } from "react";
import { Star, Calendar, Film, Tv, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { Glass, Btn, Badge, EmptyHint } from "../ui";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import { imgUrl, imgCssUrl } from "./mediaImg";
import type { MediaKind, MediaSummary, MediaListResult, MediaGenre } from "../../api/types";

/**
 * Каталог «Фильмы и Сериалы» в стиле Seerr: hero-баннер тренда + горизонтальные
 * карусели (популярное, топ, ожидаемое, по жанрам). Все данные — из TMDB,
 * запросы идут через бэкенд (уважает per-page прокси, см. server/tmdb.js).
 */

interface MediaCatalogProps {
  kind: MediaKind;
  onSelect: (kind: MediaKind, id: number, summary?: MediaSummary) => void;
  /** Внешний счётчик обновления (кнопка «Обновить» в тулбаре страницы). */
  reloadNonce: number;
  /** Открыть полный список подборки (плитка «Все» в конце карусели). */
  onSeeAll?: (category: string, title: string) => void;
}

function posterOf(item: MediaSummary): string | null {
  return item.poster || item.backdrop || null;
}

/** Одна карточка тайтла в карусели. */
function MediaCard({ item, onSelect }: { item: MediaSummary; onSelect: (k: MediaKind, id: number, s?: MediaSummary) => void }) {
  const { t } = useI18n();
  const img = posterOf(item);
  return (
    <button className="mv-card" onClick={() => onSelect(item.kind, item.id, item)} title={item.title}>
      <div className="mv-card-art tone-violet">
        {img ? <img src={imgUrl(img)} alt="" loading="lazy" /> : <Film size={22} strokeWidth={1.5} />}
        {item.voteAverage > 0 && (
          <span className="mv-card-score"><Star size={11} strokeWidth={2.4} />{item.voteAverage.toFixed(1)}</span>
        )}
        <span className="mv-card-kind">{item.kind === "tv" ? t("movies.series") : t("movies.movie")}</span>
      </div>
      <div className="mv-card-title">{item.title}</div>
      <div className="mv-card-meta">{item.year || "—"}</div>
    </button>
  );
}

/**
 * Плитка «Все» в конце карусели: открывает полный список подборки.
 * Стоит последней карточкой, поэтому видна после прокрутки ряда.
 */
function SeeAllCard({ title, onClick }: { title: string; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button className="mv-card mv-card-all" onClick={onClick} title={`${t("movies.seeAll")}: ${title}`}>
      <span className="mv-card-all-art">
        <ArrowRight size={22} strokeWidth={2} />
      </span>
      <span className="mv-card-all-text">{t("movies.seeAll")}</span>
      <span className="mv-card-all-sub">{title}</span>
    </button>
  );
}

/**
 * Горизонтальная карусель с заголовком и стрелками листания.
 *
 * Колесом мыши ряд НЕ прокручивается (страница скроллится вертикально как
 * обычно) — листать нужно стрелками «‹ ›» в заголовке, которые появляются,
 * когда ряд действительно шире видимой области, и гаснут на краях.
 */
function MediaRow({
  title, items, loading, onSelect, onSeeAll, category,
}: {
  title: string; items: MediaSummary[]; loading?: boolean;
  onSelect: (k: MediaKind, id: number, s?: MediaSummary) => void;
  onSeeAll?: (category: string, title: string) => void;
  /** Идентификатор подборки для плитки «Все» (popular, top_rated, genre:28…). */
  category?: string;
}) {
  const { t } = useI18n();
  const railRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ prev: false, next: false });

  /** Пересчитать доступность стрелок по текущей позиции и ширине ряда. */
  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ prev: el.scrollLeft > 4, next: max > 4 && el.scrollLeft < max - 4 });
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    sync();
    // Картинки приезжают асинхронно и меняют scrollWidth — пересчитываем ещё раз.
    const late = window.setTimeout(sync, 400);
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    el.addEventListener("scroll", sync, { passive: true });
    return () => {
      window.clearTimeout(late);
      ro.disconnect();
      el.removeEventListener("scroll", sync);
    };
  }, [sync, items, loading]);

  /** Листнуть ряд на видимую страницу (плавно, как слайдер). */
  const page = useCallback((dir: number) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.85), behavior: "smooth" });
  }, []);

  if (!loading && items.length === 0) return null;
  const showNav = edges.prev || edges.next;

  return (
    <section className="mv-row">
      <div className="mv-row-head">
        <h3>{title}</h3>
        {showNav && (
          <div className="mv-rail-nav">
            <button
              className="mv-rail-btn" onClick={() => page(-1)} disabled={!edges.prev}
              title={t("movies.prevImage")} aria-label={t("movies.prevImage")}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              className="mv-rail-btn" onClick={() => page(1)} disabled={!edges.next}
              title={t("movies.nextImage")} aria-label={t("movies.nextImage")}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="mv-row-scroll" ref={railRef}>
        {loading && Array.from({ length: 6 }).map((_, i) => <div key={i} className="mv-card is-skeleton" />)}
        {!loading && items.map((it) => (
          <MediaCard key={`${it.kind}-${it.id}`} item={it} onSelect={onSelect} />
        ))}
        {!loading && onSeeAll && category && items.length > 0 && (
          <SeeAllCard title={title} onClick={() => onSeeAll(category, title)} />
        )}
      </div>
    </section>
  );
}

/** Понятный текст ошибки по коду от бэкенда. */
export function mediaErrorText(
  t: (k: string, p?: Record<string, unknown>) => string,
  e: unknown
): { text: string; needsKey: boolean; needsProxy: boolean } {
  const code = (e as { code?: string })?.code || "";
  if (code === "no_api_key" || code === "bad_api_key") return { text: t("movies.errNoKey"), needsKey: true, needsProxy: false };
  if (code === "rate_limited") return { text: t("movies.errRateLimit"), needsKey: false, needsProxy: false };
  if (code === "network_error") return { text: t("movies.errProxy"), needsKey: false, needsProxy: true };
  return { text: (e as Error)?.message || t("movies.errGeneric"), needsKey: false, needsProxy: false };
}

export default function MediaCatalog({ kind, onSelect, reloadNonce, onSeeAll }: MediaCatalogProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ text: string; needsKey: boolean; needsProxy: boolean } | null>(null);
  const [trending, setTrending] = useState<MediaSummary[]>([]);
  const [popular, setPopular] = useState<MediaSummary[]>([]);
  const [topRated, setTopRated] = useState<MediaSummary[]>([]);
  const [upcoming, setUpcoming] = useState<MediaSummary[]>([]);
  const [genres, setGenres] = useState<MediaGenre[]>([]);
  const [genre, setGenre] = useState<number | null>(null);
  const [genreItems, setGenreItems] = useState<MediaSummary[]>([]);
  const [genreLoading, setGenreLoading] = useState(false);

  // «Ожидаемое» зависит от типа: у фильмов upcoming, у сериалов on_the_air.
  const upcomingCategory = kind === "tv" ? "on_the_air" : "upcoming";
  const upcomingTitle = kind === "tv" ? t("movies.onTheAir") : t("movies.upcoming");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, pop, top, up] = await Promise.all([
        api.moviesTrending(kind, "week", 1),
        api.moviesList(kind, "popular", 1),
        api.moviesList(kind, "top_rated", 1),
        api.moviesList(kind, upcomingCategory, 1),
      ]);
      setTrending(tr.items);
      setPopular(pop.items);
      setTopRated(top.items);
      setUpcoming(up.items);
    } catch (e) {
      setError(mediaErrorText(t, e));
    } finally {
      setLoading(false);
    }
    // Жанры грузим отдельно: их отсутствие не должно ломать каталог.
    try {
      const g: { genres: MediaGenre[] } = await api.moviesGenres(kind);
      setGenres(g.genres || []);
    } catch { setGenres([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, upcomingCategory]);

  useEffect(() => { void load(); }, [load, reloadNonce]);

  // Фильтр по жанру: подгружаем discover-подборку.
  useEffect(() => {
    if (genre == null) { setGenreItems([]); return; }
    let alive = true;
    setGenreLoading(true);
    api.moviesDiscover(kind, { genre, page: 1 })
      .then((r: MediaListResult) => { if (alive) setGenreItems(r.items); })
      .catch(() => { if (alive) setGenreItems([]); })
      .finally(() => { if (alive) setGenreLoading(false); });
    return () => { alive = false; };
  }, [genre, kind]);

  if (error) {
    return (
      <Glass className="mv-error">
        <AlertTriangle size={20} style={{ color: "var(--coral)" }} />
        <div className="mv-error-text">{error.text}</div>
        {error.needsProxy && <div className="muted-sm">{t("movies.errProxyHint")}</div>}
        <Btn icon={RefreshCw} onClick={() => void load()}>{t("movies.retry")}</Btn>
      </Glass>
    );
  }

  const hero = trending[0] || popular[0] || null;
  const KindIcon = kind === "tv" ? Tv : Film;

  return (
    <div className="mv-catalog">
      {/* Hero-баннер: лучший тренд с фоном и кратким описанием */}
      {hero && (
        <div className="mv-hero" onClick={() => onSelect(hero.kind, hero.id, hero)}>
          {hero.backdrop && <div className="mv-hero-bg" style={{ backgroundImage: imgCssUrl(hero.backdrop) }} />}
          <div className="mv-hero-shade" />
          <div className="mv-hero-body">
            <div className="mv-hero-eyebrow"><KindIcon size={13} /> {t("movies.trending")}</div>
            <h2 className="mv-hero-title">{hero.title}</h2>
            <div className="mv-hero-meta">
              {hero.voteAverage > 0 && <span><Star size={12} strokeWidth={2.4} /> {hero.voteAverage.toFixed(1)}</span>}
              {hero.year && <span><Calendar size={12} /> {hero.year}</span>}
            </div>
            {hero.overview && <p className="mv-hero-overview">{hero.overview}</p>}
            <Btn variant="primary" icon={KindIcon}>{t("movies.open")}</Btn>
          </div>
        </div>
      )}

      {/* Фильтр по жанрам */}
      {genres.length > 0 && (
        <div className="mv-genres">
          <Badge tone="teal" active={genre == null} onClick={() => setGenre(null)}>{t("movies.allGenres")}</Badge>
          {genres.map((g) => (
            <Badge key={g.id} tone="violet" active={genre === g.id} onClick={() => setGenre(genre === g.id ? null : g.id)}>{g.name}</Badge>
          ))}
        </div>
      )}

      {genre != null ? (
        <MediaRow
          title={t("movies.byGenre", { name: genres.find((g) => g.id === genre)?.name || "" })}
          items={genreItems} loading={genreLoading} onSelect={onSelect}
          category={`genre:${genre}`} onSeeAll={onSeeAll}
        />
      ) : (
        <>
          <MediaRow title={t("movies.trending")} items={trending} loading={loading} onSelect={onSelect}
            category="trending" onSeeAll={onSeeAll} />
          <MediaRow title={t("movies.popular")} items={popular} loading={loading} onSelect={onSelect}
            category="popular" onSeeAll={onSeeAll} />
          <MediaRow title={t("movies.topRated")} items={topRated} loading={loading} onSelect={onSelect}
            category="top_rated" onSeeAll={onSeeAll} />
          <MediaRow title={upcomingTitle} items={upcoming} loading={loading} onSelect={onSelect}
            category={upcomingCategory} onSeeAll={onSeeAll} />
        </>
      )}

      {!loading && !hero && <EmptyHint icon={KindIcon} text={t("movies.empty")} />}
    </div>
  );
}