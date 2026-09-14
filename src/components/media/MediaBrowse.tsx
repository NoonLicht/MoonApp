import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Film, Star, RefreshCw, AlertTriangle, Plus } from "lucide-react";
import { Glass, Btn, EmptyHint } from "../ui";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import { imgUrl } from "./mediaImg";
import { mediaErrorText } from "./MediaCatalog";
import type { MediaKind, MediaSummary } from "../../api/types";

/**
 * Полный список подборки («Все популярные», «Все лучшие», «Сейчас в эфире» …).
 *
 * Открывается плиткой «Все» в конце карусели каталога (см. MediaCatalog).
 * Показывает сетку карточек с догрузкой страниц TMDB: листать бесконечно
 * длинную ленту неудобно, поэтому подгрузка — по кнопке.
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
  const { t } = useI18n();
  const [items, setItems] = useState<MediaSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<{ text: string; needsKey: boolean; needsProxy: boolean } | null>(null);

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

  // Смена подборки/типа — начинаем с первой страницы.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setItems([]);
    setPage(1);
    fetchPage(1)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setTotalPages(r.totalPages || 1);
      })
      .catch((e) => { if (alive) setError(mediaErrorText(t, e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  /** Догрузить следующую страницу и дописать её к сетке. */
  const loadMore = async () => {
    const next = page + 1;
    setMore(true);
    try {
      const r = await fetchPage(next);
      setItems((prev) => [...prev, ...r.items]);
      setTotalPages(r.totalPages || totalPages);
      setPage(next);
    } catch (e) {
      setError(mediaErrorText(t, e));
    } finally {
      setMore(false);
    }
  };

  const hasMore = page < totalPages;

  return (
    <div className="mv-browse">
      <div className="mv-browse-head">
        <button className="mv-browse-back" onClick={onBack} title={t("movies.browseBack")}>
          <ArrowLeft size={15} /> {t("movies.browseBack")}
        </button>
        <h3>{title}</h3>
        <span className="muted-sm">{t("movies.browseCount", { n: items.length })}</span>
      </div>

      {error && (
        <Glass className="mv-error">
          <AlertTriangle size={20} style={{ color: "var(--coral)" }} />
          <div className="mv-error-text">{error.text}</div>
          {error.needsProxy && <div className="muted-sm">{t("movies.errProxyHint")}</div>}
          <Btn icon={RefreshCw} onClick={() => void loadMore()}>{t("movies.retry")}</Btn>
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
          <Btn icon={Plus} onClick={() => void loadMore()} disabled={more}>
            {more ? t("movies.loading") : t("movies.loadMore")}
          </Btn>
        </div>
      )}
    </div>
  );
}