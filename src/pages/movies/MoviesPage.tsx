import React, { useCallback, useEffect, useState } from "react";
import {
  Search,
  RefreshCw,
  Film,
  Tv,
  LayoutGrid,
  ListVideo,
  BarChart3,
  KeyRound,
  AlertTriangle,
  Zap,
  Trash2,
  Save,
  ExternalLink,
  Download,
  Bookmark,
  Plus,
  Pencil,
  Check as CheckIcon,
  X as XIcon,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead, EmptyHint, Field, IconBtn } from "@/components/ui";
import { usePageToolbar } from "@/components/Toolbar";
import ToolbarSearch from "@/components/ToolbarSearch";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import MediaCatalog from "@/pages/movies/parts/MediaCatalog";
import MediaBrowse from "@/pages/movies/parts/MediaBrowse";
import MediaDetailModal from "@/pages/movies/parts/MediaDetailModal";
import MediaCard from "@/pages/movies/parts/MediaCard";
import PlayerModal from "@/pages/movies/parts/PlayerModal";
import MediaStatsCard from "@/pages/movies/parts/MediaStatsCard";
import DownloadsView from "@/pages/movies/parts/DownloadsView";
import { imgUrl } from "@/pages/movies/lib/mediaImg";
import type {
  MediaKind,
  MediaSummary,
  MediaStatus,
  MediaLibrary,
  MediaStats,
  MediaWatchlistEntry,
  MediaWatchStatus,
  MediaBookmarks,
} from "@/api/types";

/**
 * Страница «Фильмы и Сериалы» (id: movies).
 *
 * Объединяет три режима:
 *   • Каталог  — подборки TMDB (тренды/популярное/топ/ожидаемое) + поиск;
 *   • Мой список — watchlist/оценки из локальной БД;
 *   • Статистика — часы просмотра, жанры, актёры.
 *
 * Детали открываются в модалке, воспроизведение — в плеере (трейлер YouTube или
 * торрент, источник которого пользователь задаёт сам: magnet/.torrent).
 * Если ключ TMDB не задан — показываем понятную подсказку со ссылкой в Настройки.
 */

type ViewId = "catalog" | "library" | "bookmarks" | "stats" | "downloads";

const STATUS_TONE: Record<MediaWatchStatus, string> = {
  plan: "teal",
  watching: "violet",
  watched: "amber",
};

export default function MoviesPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [kind, setKind] = useState<MediaKind>("movie");
  const [view, setView] = useState<ViewId>("catalog");
  const [libFilter, setLibFilter] = useState<MediaWatchStatus | "all">("all");
  const [reloadNonce, setReloadNonce] = useState(0);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchItems, setSearchItems] = useState<MediaSummary[]>([]);
  const [searched, setSearched] = useState(false);

  const [detail, setDetail] = useState<{
    kind: MediaKind;
    id: number;
    summary?: MediaSummary | null;
  } | null>(null);
  const [player, setPlayer] = useState<{
    trailerKey: string | null;
    /** Название тайтла — для автопоиска раздач на вкладке форума. */
    query?: string | null;
    /** Открыть конкретную загрузку из вкладки «Скачанные» (окно восстановится). */
    download?: { infoHash: string; title?: string } | null;
  } | null>(null);
  /** Открытая подборка «Все …» (null — обычный каталог каруселей). */
  const [browse, setBrowse] = useState<{ category: string; title: string } | null>(null);

  const [library, setLibrary] = useState<MediaLibrary | null>(null);
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [busy, setBusy] = useState(false);

  // Свои закладки (папки) — можно завести сколько угодно, в отличие от
  // watchlist (один статус на тайтл на всё приложение).
  const [bookmarks, setBookmarks] = useState<MediaBookmarks | null>(null);
  const [bmNewName, setBmNewName] = useState("");
  const [bmRenaming, setBmRenaming] = useState<number | null>(null);
  const [bmRenameValue, setBmRenameValue] = useState("");
  const loadBookmarks = useCallback(() => {
    api
      .moviesBookmarks()
      .then(setBookmarks)
      .catch(() => setBookmarks(null));
  }, []);
  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const createBookmarkList = useCallback(async () => {
    const name = bmNewName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.moviesBookmarkCreate(name);
      setBmNewName("");
      loadBookmarks();
    } finally {
      setBusy(false);
    }
  }, [bmNewName, loadBookmarks]);

  const deleteBookmarkList = useCallback(
    async (id: number, name: string) => {
      if (!window.confirm(t("movies.bookmarksDeleteConfirm", { name }))) return;
      setBusy(true);
      try {
        await api.moviesBookmarkDelete(id);
        loadBookmarks();
      } finally {
        setBusy(false);
      }
    },
    [loadBookmarks, t],
  );

  const renameBookmarkList = useCallback(async () => {
    const name = bmRenameValue.trim();
    if (!name || bmRenaming == null) return;
    setBusy(true);
    try {
      await api.moviesBookmarkRename(bmRenaming, name);
      setBmRenaming(null);
      loadBookmarks();
    } finally {
      setBusy(false);
    }
  }, [bmRenaming, bmRenameValue, loadBookmarks]);

  const removeBookmarkItem = useCallback(
    async (listId: number, kind2: MediaKind, tmdbId: number) => {
      setBusy(true);
      try {
        await api.moviesBookmarkRemoveItem(listId, kind2, tmdbId);
        loadBookmarks();
      } finally {
        setBusy(false);
      }
    },
    [loadBookmarks],
  );

  // Статус страницы (ключ TMDB + движок торрентов).
  const loadStatus = useCallback(() => {
    api
      .moviesStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Смена типа медиа (фильмы/сериалы) меняет набор подборок — закрываем открытый список.
  useEffect(() => {
    setBrowse(null);
  }, [kind]);

  // Личная библиотека + агрегированная статистика.
  const loadLibrary = useCallback(() => {
    api
      .moviesLibrary()
      .then(setLibrary)
      .catch(() => setLibrary(null));
    api
      .moviesStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);
  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      await api.moviesRefresh();
    } catch {
      /* кэш мог не очиститься — не критично */
    }
    setReloadNonce((n) => n + 1);
    setBusy(false);
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setSearchItems([]);
      setSearched(false);
      return;
    }
    setBrowse(null); // поиск показываем поверх каталога, а не поверх открытой подборки
    setSearching(true);
    setSearched(true);
    try {
      const r = await api.moviesSearch(q, "multi", 1);
      setSearchItems(r.items);
    } catch {
      setSearchItems([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const clearStats = useCallback(async () => {
    setBusy(true);
    try {
      await api.moviesClearStats();
      loadLibrary();
    } finally {
      setBusy(false);
    }
  }, [loadLibrary]);

  const changeWatchStatus = useCallback(
    async (entry: MediaWatchlistEntry, next: MediaWatchStatus) => {
      setBusy(true);
      try {
        await api.moviesSetWatchlist({
          kind: entry.kind,
          id: entry.tmdb_id,
          title: entry.title,
          poster: entry.poster,
          year: entry.year,
          runtime: entry.runtime,
          genres: entry.genres,
          status: next,
        });
        loadLibrary();
      } finally {
        setBusy(false);
      }
    },
    [loadLibrary],
  );

  const removeFromList = useCallback(
    async (entry: MediaWatchlistEntry) => {
      setBusy(true);
      try {
        await api.moviesRemoveWatchlist(entry.kind, entry.tmdb_id);
        loadLibrary();
      } finally {
        setBusy(false);
      }
    },
    [loadLibrary],
  );

  /**
   * Доп. пункты контекстного меню карточки тайтла (правая кнопка) — статус
   * просмотра и добавление в закладки прямо из каталога/карусели/поиска, без
   * открытия карточки тайтла. Меню плоское (без подменю), поэтому пункты
   * закладок собираются из уже загруженного bookmarks.lists (обновляется той
   * же loadBookmarks, что и вкладка «Закладки»).
   */
  const cardMenuExtra = useCallback(
    (item: MediaSummary) => [
      { separator: true },
      {
        label: t("movies.statusPlan"),
        icon: Bookmark,
        onClick: () =>
          void api
            .moviesSetWatchlist({ kind: item.kind, id: item.id, title: item.title, status: "plan" })
            .then(loadLibrary),
      },
      {
        label: t("movies.statusWatching"),
        icon: ListVideo,
        onClick: () =>
          void api
            .moviesSetWatchlist({
              kind: item.kind,
              id: item.id,
              title: item.title,
              status: "watching",
            })
            .then(loadLibrary),
      },
      {
        label: t("movies.statusWatched"),
        icon: CheckIcon,
        onClick: () =>
          void api
            .moviesSetWatchlist({
              kind: item.kind,
              id: item.id,
              title: item.title,
              status: "watched",
            })
            .then(loadLibrary),
      },
      { separator: true },
      ...(bookmarks?.lists || []).map((l) => ({
        label: t("movies.bookmarksAddToList", { name: l.name }),
        icon: Bookmark,
        onClick: () =>
          void api
            .moviesBookmarkAddItem(l.id, {
              kind: item.kind,
              id: item.id,
              title: item.title,
              poster: item.poster || "",
              year: item.year,
            })
            .then(loadBookmarks),
      })),
      {
        label: t("movies.bookmarksCreate"),
        icon: Plus,
        onClick: () => {
          const name = window.prompt(t("movies.bookmarksNewPlaceholder"));
          if (!name?.trim()) return;
          void api
            .moviesBookmarkCreate(name.trim())
            .then((r) =>
              api.moviesBookmarkAddItem(r.list.id, {
                kind: item.kind,
                id: item.id,
                title: item.title,
                poster: item.poster || "",
                year: item.year,
              }),
            )
            .then(loadBookmarks);
        },
      },
    ],
    [t, bookmarks, loadLibrary, loadBookmarks],
  );

  usePageToolbar(
    <div className="mv-toolbar">
      {/* Обновить — левее всего остального в тулбаре страницы (в самой левой
          части экрана живёт только глобальная кнопка диспетчера задач —
          App.tsx, tb-side-left; тулбар страницы рендерится в соседней,
          центральной зоне, tb-dynamic, и левее самого себя сдвинуться не
          может — это ближайшая к ней позиция). */}
      <Btn
        icon={RefreshCw}
        onClick={() => void refreshAll()}
        disabled={busy}
        title={t("movies.refresh")}
      />
      {/* Тип медиа: фильмы / сериалы */}
      <div className="mv-seg">
        <button
          className={kind === "movie" ? "is-active" : ""}
          onClick={() => setKind("movie")}
          title={t("movies.movies")}
        >
          <Film size={14} /> <span className="mv-seg-label">{t("movies.movies")}</span>
        </button>
        <button
          className={kind === "tv" ? "is-active" : ""}
          onClick={() => setKind("tv")}
          title={t("movies.series")}
        >
          <Tv size={14} /> <span className="mv-seg-label">{t("movies.series")}</span>
        </button>
      </div>

      {/* Разделы страницы */}
      <div className="mv-seg">
        <button
          className={view === "catalog" ? "is-active" : ""}
          onClick={() => setView("catalog")}
          title={t("movies.tab_catalog")}
        >
          <LayoutGrid size={14} />
        </button>
        <button
          className={view === "library" ? "is-active" : ""}
          onClick={() => setView("library")}
          title={t("movies.tab_library")}
        >
          <ListVideo size={14} />
        </button>
        <button
          className={view === "bookmarks" ? "is-active" : ""}
          onClick={() => setView("bookmarks")}
          title={t("movies.tab_bookmarks")}
        >
          <Bookmark size={14} />
        </button>
        <button
          className={view === "stats" ? "is-active" : ""}
          onClick={() => setView("stats")}
          title={t("movies.tab_stats")}
        >
          <BarChart3 size={14} />
        </button>
        {/* «Скачанные» — сразу справа от «Статистики»: там реестр загрузок плеера
            (что качается, что остановлено, что уже скачано). */}
        <button
          className={view === "downloads" ? "is-active" : ""}
          onClick={() => setView("downloads")}
          title={t("movies.tab_downloads")}
        >
          <Download size={14} />
        </button>
      </div>

      {/* Поиск по TMDB: в широкой панели — полем, ниже 1200px — под иконкой
          с поповером чуть ниже панели (см. src/components/ToolbarSearch.tsx). */}
      <ToolbarSearch
        value={query}
        onChange={setQuery}
        placeholder={t("movies.searchPlaceholder")}
        title={t("movies.searchPlaceholder")}
        clearTitle={t("movies.clear")}
        onSubmit={() => void runSearch()}
      />
    </div>,
    [kind, view, query, busy],
  );

  // Ключа нет — показываем форму ввода (можно не уходить в Настройки).
  // Вкладка «Скачанные» работает без TMDB: она показывает локальные загрузки,
  // поэтому форму ключа там не навязываем.
  if (status && !status.hasKey && view !== "downloads") {
    return (
      <div className="mv-page">
        <SectionHead eyebrow={t("nav.movies")} title={t("movies.title")} />
        <div className="mv-scroll">
          <TmdbKeyGate
            onSaved={() => {
              loadStatus();
              setReloadNonce((n) => n + 1);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mv-page">
      <SectionHead
        eyebrow={t("nav.movies")}
        title={t("movies.title")}
        action={
          <div className="mv-header-actions">
            {status && !status.engine.installed && (
              <Badge tone="coral" mono>
                {t("movies.torrentNoEngine")}
              </Badge>
            )}
          </div>
        }
      />

      {/* Содержимое вкладки: скроллится только эта область, заголовок остаётся */}
      <div className="mv-scroll">
        {/* Результаты поиска (показываются поверх каталога) */}
        {searched && (
          <Glass className="mv-search-results">
            <div className="mv-row-head">
              <h3>{t("movies.searchResults", { q: query })}</h3>
              <button
                className="mv-row-more"
                onClick={() => {
                  setSearched(false);
                  setSearchItems([]);
                }}
              >
                {t("movies.clear")}
              </button>
            </div>
            {searching && <div className="muted-sm">{t("movies.loading")}</div>}
            {!searching && searchItems.length === 0 && (
              <EmptyHint icon={Search} text={t("movies.noResults")} />
            )}
            <div className="mv-similar">
              {searchItems.map((s) => (
                <MediaCard
                  key={`${s.kind}-${s.id}`}
                  item={s}
                  onSelect={(k, id, summary) => setDetail({ kind: k, id, summary })}
                  menuExtra={cardMenuExtra}
                />
              ))}
            </div>
          </Glass>
        )}

        {/* Каталог подборок TMDB либо полный список выбранной подборки («Все …») */}
        {view === "catalog" &&
          (browse ? (
            <MediaBrowse
              kind={kind}
              category={browse.category}
              title={browse.title}
              onBack={() => setBrowse(null)}
              onSelect={(k, id, s) => setDetail({ kind: k, id, summary: s })}
              menuExtra={cardMenuExtra}
            />
          ) : (
            <MediaCatalog
              kind={kind}
              reloadNonce={reloadNonce}
              onSelect={(k, id, s) => setDetail({ kind: k, id, summary: s })}
              onSeeAll={(category, title) => setBrowse({ category, title })}
              menuExtra={cardMenuExtra}
            />
          ))}

        {/* Мой список: watchlist + статусы */}
        {view === "library" && (
          <div className="mv-library">
            {library && library.watchlist.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(
                  [
                    ["all", t("movies.filterAll"), library.watchlist.length],
                    ...(["plan", "watching", "watched"] as MediaWatchStatus[]).map(
                      (st) =>
                        [
                          st,
                          t(`movies.status${st.charAt(0).toUpperCase()}${st.slice(1)}`),
                          library.watchlist.filter((e) => e.status === st).length,
                        ] as const,
                    ),
                  ] as const
                )
                  .filter(([key, , count]) => key === "all" || count > 0)
                  .map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      className={`chip-toggle${libFilter === key ? " is-active" : ""}`}
                      onClick={() => setLibFilter(key)}
                    >
                      {label} <Badge tone="neutral" mono>{count}</Badge>
                    </button>
                  ))}
              </div>
            )}

            {!library || library.watchlist.length === 0 ? (
              <EmptyHint icon={ListVideo} text={t("movies.libraryEmpty")} />
            ) : (
              <div className="mv-library-grid">
                {library.watchlist
                  .filter((e) => libFilter === "all" || e.status === libFilter)
                  .map((e) => {
                  const rating =
                    library.ratings.find((r) => r.kind === e.kind && r.tmdb_id === e.tmdb_id)
                      ?.rating || 0;
                  return (
                    <Glass key={`${e.kind}-${e.tmdb_id}`} className="mv-lib-card">
                      <button
                        className="mv-lib-art"
                        onClick={() => setDetail({ kind: e.kind, id: e.tmdb_id })}
                      >
                        {e.poster ? (
                          <img src={imgUrl(e.poster)} alt="" loading="lazy" />
                        ) : (
                          <Film size={22} strokeWidth={1.5} />
                        )}
                      </button>
                      <div className="mv-lib-info">
                        <div className="mv-lib-title" title={e.title}>
                          {e.title}
                        </div>
                        <div className="muted-sm">
                          {e.year || "—"}
                          {rating > 0 ? ` · ★ ${rating}` : ""}
                          {e.kind === "tv" && e.watched_season > 0
                            ? ` · ${t("movies.seasonEpisodeShort", { s: e.watched_season, e: e.watched_episode })}`
                            : ""}
                        </div>
                        <div className="mv-lib-status">
                          {(["plan", "watching", "watched"] as MediaWatchStatus[]).map((st) => (
                            <Badge
                              key={st}
                              tone={STATUS_TONE[st]}
                              active={e.status === st}
                              onClick={() => void changeWatchStatus(e, st)}
                            >
                              {t(`movies.status${st.charAt(0).toUpperCase()}${st.slice(1)}`)}
                            </Badge>
                          ))}
                        </div>
                        <div className="mv-lib-actions">
                          <Btn
                            icon={Zap}
                            onClick={() => setPlayer({ trailerKey: null, query: null })}
                          >
                            {t("movies.openPlayer")}
                          </Btn>
                          <Btn
                            icon={Trash2}
                            onClick={() => void removeFromList(e)}
                            disabled={busy}
                            title={t("movies.removeFromList")}
                          />
                        </div>
                      </div>
                    </Glass>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* Свои закладки: любое число именованных папок, тайтл может быть
            сразу в нескольких (в отличие от «Мой список» — там один статус
            на тайтл на всё приложение). */}
        {view === "bookmarks" && (
          <div className="mv-bookmarks-view">
            <div className="mv-bookmarks-new-row">
              <input
                className="text-input"
                placeholder={t("movies.bookmarksNewPlaceholder")}
                value={bmNewName}
                onChange={(e) => setBmNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createBookmarkList();
                }}
              />
              <Btn
                variant="primary"
                icon={Plus}
                disabled={busy || !bmNewName.trim()}
                onClick={() => void createBookmarkList()}
              >
                {t("movies.bookmarksCreate")}
              </Btn>
            </div>

            {!bookmarks || bookmarks.lists.length === 0 ? (
              <EmptyHint icon={Bookmark} text={t("movies.bookmarksTabEmpty")} />
            ) : (
              bookmarks.lists.map((l) => {
                const items = bookmarks.items.filter((it) => it.list_id === l.id);
                return (
                  <Glass key={l.id} className="mv-bookmark-list">
                    <div className="mv-row-head">
                      {bmRenaming === l.id ? (
                        <div className="mv-bookmark-rename">
                          <input
                            className="text-input"
                            autoFocus
                            value={bmRenameValue}
                            onChange={(e) => setBmRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void renameBookmarkList();
                              if (e.key === "Escape") setBmRenaming(null);
                            }}
                          />
                          <IconBtn icon={CheckIcon} title={t("common.save")} onClick={() => void renameBookmarkList()} />
                          <IconBtn icon={XIcon} title={t("common.cancel")} onClick={() => setBmRenaming(null)} />
                        </div>
                      ) : (
                        <h3>
                          {l.name} <span className="muted-sm">({items.length})</span>
                        </h3>
                      )}
                      <div style={{ display: "flex", gap: 4 }}>
                        <IconBtn
                          icon={Pencil}
                          title={t("movies.bookmarksRename")}
                          onClick={() => {
                            setBmRenaming(l.id);
                            setBmRenameValue(l.name);
                          }}
                        />
                        <IconBtn
                          icon={Trash2}
                          title={t("movies.bookmarksDeleteList")}
                          onClick={() => void deleteBookmarkList(l.id, l.name)}
                        />
                      </div>
                    </div>
                    {items.length === 0 ? (
                      <div className="muted-sm">{t("movies.bookmarksListEmpty")}</div>
                    ) : (
                      <div className="mv-library-grid">
                        {items.map((it) => (
                          <Glass key={`${it.kind}-${it.tmdb_id}`} className="mv-lib-card">
                            <button
                              className="mv-lib-art"
                              onClick={() => setDetail({ kind: it.kind, id: it.tmdb_id })}
                            >
                              {it.poster ? (
                                <img src={imgUrl(it.poster)} alt="" loading="lazy" />
                              ) : (
                                <Film size={22} strokeWidth={1.5} />
                              )}
                            </button>
                            <div className="mv-lib-info">
                              <div className="mv-lib-title" title={it.title}>
                                {it.title}
                              </div>
                              <div className="muted-sm">{it.year || "—"}</div>
                              <div className="mv-lib-actions">
                                <IconBtn
                                  icon={XIcon}
                                  title={t("movies.bookmarksRemoveItem")}
                                  onClick={() => void removeBookmarkItem(l.id, it.kind, it.tmdb_id)}
                                />
                              </div>
                            </div>
                          </Glass>
                        ))}
                      </div>
                    )}
                  </Glass>
                );
              })
            )}
          </div>
        )}
        {/* Личная статистика */}
        {view === "stats" && (
          <MediaStatsCard stats={stats} onClear={() => void clearStats()} busy={busy} />
        )}
        {/* Скачанные: реестр загрузок торрент-плеера. Клик по раздаче открывает
            плеер на ней же — окно восстанавливается, если его закрыли случайно. */}
        {view === "downloads" && (
          <DownloadsView
            onPlay={(d) =>
              setPlayer({
                trailerKey: null,
                query: d.title || d.name || null,
                download: { infoHash: d.infoHash, title: d.title },
              })
            }
          />
        )}
      </div>

      {/* Детали тайтла */}
      {detail && (
        <MediaDetailModal
          kind={detail.kind}
          id={detail.id}
          summary={detail.summary}
          onClose={() => setDetail(null)}
          onOpenTitle={(k, id) => setDetail({ kind: k, id })}
          onOpenPlayer={(tk, title) => setPlayer({ trailerKey: tk, query: title ?? null })}
          onChanged={() => {
            loadLibrary();
            loadBookmarks();
          }}
        />
      )}

      {/* Плеер (трейлер/торрент) */}
      {player && (
        <PlayerModal
          trailerKey={player.trailerKey}
          query={player.query}
          download={player.download ?? null}
          onClose={() => setPlayer(null)}
        />
      )}
    </div>
  );
}

/**
 * Форма ввода API-ключа TMDB, когда ключа ещё нет.
 * Ключ уходит один раз и хранится зашифрованным (storage/secrets.json).
 */
function TmdbKeyGate({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setSaving(true);
    setError("");
    try {
      await api.moviesSaveKey(key);
      onSaved();
    } catch (e) {
      setError((e as Error).message || t("movies.errGeneric"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Glass className="mv-key-gate">
      <KeyRound size={22} />
      <h3>{t("movies.keyTitle")}</h3>
      <p className="muted-sm">{t("movies.keyHint")}</p>
      <Field label={t("movies.keyLabel")}>
        <div className="mv-magnet-row">
          <input
            className="text-input"
            type="password"
            value={draft}
            placeholder="API Key / Read Access Token"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          <Btn
            variant="primary"
            icon={Save}
            disabled={saving || !draft.trim()}
            onClick={() => void save()}
          >
            {t("movies.keySave")}
          </Btn>
        </div>
      </Field>
      {error && (
        <div className="mv-error-inline">
          <AlertTriangle size={14} style={{ color: "var(--coral)" }} /> {error}
        </div>
      )}
      <div className="mv-key-links">
        <a
          className="mv-providers-link"
          href="https://www.themoviedb.org/settings/api"
          target="_blank"
          rel="noreferrer noopener"
        >
          <ExternalLink size={13} /> TMDB API
        </a>
        <span className="muted-sm">{t("movies.keyWhere")}</span>
      </div>
    </Glass>
  );
}
