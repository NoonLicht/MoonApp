import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Film, Star, RefreshCw, AlertTriangle, Loader2, Plus } from "lucide-react";
import { Glass, Btn, EmptyHint } from "../ui";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import { imgUrl } from "./mediaImg";
import { mediaErrorText } from "./MediaCatalog";
import { canAutoLoad, formatCount, hasNextPage, mergePage, nextPage } from "./browsePaging";
import type { MediaKind, MediaSummary } from "../../api/types";

/**
 * Полный список подборки («Все популярные», «Все лучшие», «Сейчас в эфире» …).
 *
 * Открывается плиткой «Все» в конце карусели каталога (см. MediaCatalog).
 * TMDB отдаёт по 20 тайтлов на страницу, поэтому список догружается:
 *   • автоматически, когда доскроллили до конца (первые `AUTO_LOAD_LIMIT` тайтлов);
 *   • вручную кнопкой «Показать ещё» — на случай ошибки или очень длинных лент.
 * В шапке видно прогресс «Показано N из M», чтобы было понятно, что 20 — это
 * только первая страница, а не весь список.
 */

interface MediaBrowseProps {
  kind: MediaKind;
  /** Подборка: popular | top_rated | upcoming | on_the_air | trending | genre:<id>. */
  category: string;
  /** Локализованное название подборки (заголовок списка). */
  title: string;
  onBack: () => void;
  onSelect: (kind: MediaKind, id: number, summary?: MediaSummary) => void;
}

export default function MediaBrowse({ kind, category, title, onBack, onSelect }: MediaBrowseProps) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<MediaSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<{ text: string; needsKey: boolean; needsProxy: boolean } | null>(null);
  /** Маркер конца сетки: попав в область видимости, он запускает догрузку. */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** Защита от параллельных догрузок (кнопка + автоподгрузка могут совпасть). */
  const busyRef = useRef(false);

  /** Одна страница подборки: тренды/жанр/категория — разными эндпоинтами. */
  const fetchPage = useCallback(
    (p: number) => {
      if (category === "trending") return api.moviesTrending(kind, "week", p);
      if (category.startsWith("genre:")) {
        const genre = category.slice("genre:".length);
        return api.moviesDiscover(kind, { genre, page: p });
      }
      return api.moviesList(kind, category, p);
    },
    [kind, category]
  );

  /**
   * Первая страница подборки (и повтор после ошибки).
   * `alive` — проверка, что компонент ещё жив: запрос может завершиться после
   * закрытия списка (вернулись в каталог), тогда state не трогаем.
   */
  const loadFirst = useCallback(
    (alive: () => boolean = () => true) => {
      setLoading(true);
      setError(null);
      return fetchPage(1)
        .then((r) => {
          if (!alive()) return;
          setItems(r.items);
          setTotalPages(r.totalPages || 1);
          setTotalResults(r.totalResults || r.items.length);
        })
        .catch((e) => { if (alive()) setError(mediaErrorText(t, e)); })
        .finally(() => { if (alive()) setLoading(false); });
    },
    [fetchPage, t]
  );

  // Смена подборки/типа — начинаем с первой страницы.
  useEffect(() => {
    let ok = true;
    setItems([]);
    setPage(1);
    setTotalPages(1);
    setTotalResults(0);
    void loadFirst(() => ok);
    return () => { ok = false; };
  }, [loadFirst]);

  /** Догрузить следующую страницу и дописать её к сетке. */
  const loadMore = useCallback(async () => {
    if (busyRef.current) return;
    const next = nextPage(page, totalPages);
    if (next === page) return; // страницы кончились
    busyRef.current = true;
    setMore(true);
    try {
      const r = await fetchPage(next);
      setItems((prev) => mergePage(prev, r.items));
      setTotalPages(r.totalPages || totalPages);
      setTotalResults((prev) => Math.max(prev, r.totalResults || 0));
      setPage(next);
    } catch (e) {
      setError(mediaErrorText(t, e));
    } finally {
      busyRef.current = false;
      setMore(false);
    }
  }, [fetchPage, page, totalPages, t]);

  /**
   * Повтор после ошибки: если не загрузилось ничего — просим первую страницу,
   * иначе догружаем следующую (ошибка могла случиться на подкачке).
   */
  const retry = useCallback(() => {
    if (items.length === 0) void loadFirst();
    else void loadMore();
  }, [items.length, loadFirst, loadMore]);

  const hasMore = hasNextPage(page, totalPages);
  /**
   * Автоподгрузка при подъезде к низу списка.
   *
   * Наблюдатель пересоздаётся после каждой загруженной страницы: если маркер
   * остался в зоне видимости (окно большое, сетка ещё не заполнила экран),
   * IntersectionObserver сразу пришлёт первичное уведомление и подгрузит ещё.
   * `busyRef` в loadMore не даёт двум запросам уйти одновременно.
   */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loading || more) return;
    if (typeof IntersectionObserver === "undefined") return; // старый Chromium — останется кнопка
    if (!canAutoLoad(items.length, page, totalPages)) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); },
      { rootMargin: "500px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loading, more, loadMore, items.length, page, totalPages]);

  return (
    <div className="mv-browse">
      <div className="mv-browse-head">
        <button className="mv-browse-back" onClick={onBack} title={t("movies.browseBack")}>
          <ArrowLeft size={15} /> {t("movies.browseBack")}
        </button>
        <h3>{title}</h3>
        {items.length > 0 && (
          <span className="muted-sm">
            {totalResults > items.length
              ? t("movies.browseProgress", { n: formatCount(items.length, lang), total: formatCount(totalResults, lang) })
              : t("movies.browseCount", { n: formatCount(items.length, lang) })}
          </span>
        )}
      </div>

      {error && (
        <Glass className="mv-error">
          <AlertTriangle size={20} style={{ color: "var(--coral)" }} />
          <div className="mv-error-text">{error.text}</div>
          {error.needsProxy && <div className="muted-sm">{t("movies.errProxyHint")}</div>}
          <Btn icon={RefreshCw} onClick={retry}>{t("movies.retry")}</Btn>
        </Glass>
      )}

      {loading ? (
        <div className="mv-browse-grid">
          {Array.from({ length: 12 }).map((_, i) => <div key={i} className="mv-card is-skeleton" />)}
        </div>
      ) : items.length === 0 && !error ? (
        <EmptyHint icon={Film} text={t("movies.empty")} />
      ) : (
        <div className="mv-browse-grid">
          {items.map((it) => (
            <button
              key={`${it.kind}-${it.id}`} className="mv-card"
              onClick={() => onSelect(it.kind, it.id, it)} title={it.title}
            >
              <div className="mv-card-art tone-violet">
                {it.poster || it.backdrop
                  ? <img src={imgUrl(it.poster || it.backdrop)} alt="" loading="lazy" />
                  : <Film size={22} strokeWidth={1.5} />}
                {it.voteAverage > 0 && (
                  <span className="mv-card-score"><Star size={11} strokeWidth={2.4} />{it.voteAverage.toFixed(1)}</span>
                )}
              </div>
              <div className="mv-card-title">{it.title}</div>
              <div className="mv-card-meta">{it.year || "—"}</div>
            </button>
          ))}
        </div>
      )}

      {hasMore && !loading && (
        <div className="mv-browse-more">
          {/* Маркер для автоподгрузки: как только он в зоне видимости — грузим ещё */}
          <div ref={sentinelRef} className="mv-browse-sentinel" aria-hidden="true" />
          <Btn icon={more ? Loader2 : Plus} onClick={() => void loadMore()} disabled={more}>
            {more ? t("movies.loading") : t("movies.loadMore")}
          </Btn>
        </div>
      )}

      {!loading && !hasMore && items.length > 0 && (
        <div className="mv-browse-end">{t("movies.browseEnd", { total: formatCount(totalResults || items.length, lang) })}</div>
      )}
    </div>
  );
}