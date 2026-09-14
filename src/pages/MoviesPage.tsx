import React, { useCallback, useEffect, useState } from "react";
import {
  Clapperboard, Search, RefreshCw, Film, Tv, LayoutGrid, ListVideo,
  BarChart3, KeyRound, AlertTriangle, Settings2, Zap, Trash2, Save, ExternalLink,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead, EmptyHint, Field } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import MediaCatalog from "../components/media/MediaCatalog";
import MediaDetailModal from "../components/media/MediaDetailModal";
import PlayerModal from "../components/media/PlayerModal";
import MediaStatsCard from "../components/media/MediaStatsCard";
import { imgUrl } from "../components/media/mediaImg";
import type {
  MediaKind, MediaSummary, MediaStatus, MediaLibrary, MediaStats, MediaWatchlistEntry, MediaWatchStatus,
} from "../api/types";

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

type ViewId = "catalog" | "library" | "stats";

const STATUS_TONE: Record<MediaWatchStatus, string> = { plan: "teal", watching: "violet", watched: "amber" };

export default function MoviesPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [kind, setKind] = useState<MediaKind>("movie");
  const [view, setView] = useState<ViewId>("catalog");
  const [reloadNonce, setReloadNonce] = useState(0);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchItems, setSearchItems] = useState<MediaSummary[]>([]);
  const [searched, setSearched] = useState(false);

  const [detail, setDetail] = useState<{ kind: MediaKind; id: number; summary?: MediaSummary | null } | null>(null);
  const [player, setPlayer] = useState<{ trailerKey: string | null } | null>(null);

  const [library, setLibrary] = useState<MediaLibrary | null>(null);
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [busy, setBusy] = useState(false);

  // Статус страницы (ключ TMDB + движок торрентов).
  const loadStatus = useCallback(() => {
    api.moviesStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Личная библиотека + агрегированная статистика.
  const loadLibrary = useCallback(() => {
    api.moviesLibrary().then(setLibrary).catch(() => setLibrary(null));
    api.moviesStats().then(setStats).catch(() => setStats(null));
  }, []);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try { await api.moviesRefresh(); } catch { /* кэш мог не очиститься — не критично */ }
    setReloadNonce((n) => n + 1);
    setBusy(false);
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setSearchItems([]); setSearched(false); return; }
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
    try { await api.moviesClearStats(); loadLibrary(); }
    finally { setBusy(false); }
  }, [loadLibrary]);

  const changeWatchStatus = useCallback(async (entry: MediaWatchlistEntry, next: MediaWatchStatus) => {
    setBusy(true);
    try {
      await api.moviesSetWatchlist({
        kind: entry.kind, id: entry.tmdb_id, title: entry.title,
        poster: entry.poster, year: entry.year, runtime: entry.runtime,
        genres: entry.genres, status: next,
      });
      loadLibrary();
    } finally { setBusy(false); }
  }, [loadLibrary]);

  const removeFromList = useCallback(async (entry: MediaWatchlistEntry) => {
    setBusy(true);
    try { await api.moviesRemoveWatchlist(entry.kind, entry.tmdb_id); loadLibrary(); }
    finally { setBusy(false); }
  }, [loadLibrary]);

  usePageToolbar(
    <div className="mv-toolbar">
      {/* Тип медиа: фильмы / сериалы */}
      <div className="mv-seg">
        <button className={kind === "movie" ? "is-active" : ""} onClick={() => setKind("movie")}>
          <Film size={14} /> {t("movies.movies")}
        </button>
        <button className={kind === "tv" ? "is-active" : ""} onClick={() => setKind("tv")}>
          <Tv size={14} /> {t("movies.series")}
        </button>
      </div>

      {/* Разделы страницы */}
      <div className="mv-seg">
        <button className={view === "catalog" ? "is-active" : ""} onClick={() => setView("catalog")} title={t("movies.tab_catalog")}>
          <LayoutGrid size={14} />
        </button>
        <button className={view === "library" ? "is-active" : ""} onClick={() => setView("library")} title={t("movies.tab_library")}>
          <ListVideo size={14} />
        </button>
        <button className={view === "stats" ? "is-active" : ""} onClick={() => setView("stats")} title={t("movies.tab_stats")}>
          <BarChart3 size={14} />
        </button>
      </div>

      {/* Поиск по TMDB */}
      <div className="mv-search">
        <Search size={14} />
        <input
          className="mv-search-input"
          value={query}
          placeholder={t("movies.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
        />
      </div>

      <Btn icon={RefreshCw} onClick={() => void refreshAll()} disabled={busy} title={t("movies.refresh")} />
    </div>,
    [kind, view, query, busy]
  );

  // Ключа нет — показываем форму ввода (можно не уходить в Настройки).
  if (status && !status.hasKey) {
    return (
      <div className="mv-page">
        <SectionHead eyebrow={t("nav.movies")} title={t("movies.title")} />
        <div className="mv-scroll">
          <TmdbKeyGate onSaved={() => { loadStatus(); setReloadNonce((n) => n + 1); }} />
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
          status && !status.engine.installed
            ? <Badge tone="coral" mono>{t("movies.torrentNoEngine")}</Badge>
            : undefined
        }
      />

      {/* Содержимое вкладки: скроллится только эта область, заголовок остаётся */}
      <div className="mv-scroll">
        {/* Результаты поиска (показываются поверх каталога) */}
        {searched && (
        <Glass className="mv-search-results">
          <div className="mv-row-head">
            <h3>{t("movies.searchResults", { q: query })}</h3>
            <button className="mv-row-more" onClick={() => { setSearched(false); setSearchItems([]); }}>
              {t("movies.clear")}
            </button>
          </div>
          {searching && <div className="muted-sm">{t("movies.loading")}</div>}
          {!searching && searchItems.length === 0 && <EmptyHint icon={Search} text={t("movies.noResults")} />}
          <div className="mv-similar">
            {searchItems.map((s) => (
              <button key={`${s.kind}-${s.id}`} className="mv-card" onClick={() => setDetail({ kind: s.kind, id: s.id, summary: s })}>
                <div className="mv-card-art tone-violet">
                  {s.poster ? <img src={imgUrl(s.poster)} alt="" loading="lazy" /> : <Film size={20} strokeWidth={1.5} />}
                </div>
                <div className="mv-card-title">{s.title}</div>
                <div className="mv-card-meta">{s.year || "—"}</div>
              </button>
            ))}
          </div>
        </Glass>
      )}

      {/* Каталог подборок TMDB */}
      {view === "catalog" && (
        <MediaCatalog kind={kind} reloadNonce={reloadNonce} onSelect={(k, id, s) => setDetail({ kind: k, id, summary: s })} />
      )}

      {/* Мой список: watchlist + статусы */}
      {view === "library" && (
        <div className="mv-library">
          {!library || library.watchlist.length === 0 ? (
            <EmptyHint icon={ListVideo} text={t("movies.libraryEmpty")} />
          ) : (
            <div className="mv-library-grid">
              {library.watchlist.map((e) => {
                const rating = library.ratings.find((r) => r.kind === e.kind && r.tmdb_id === e.tmdb_id)?.rating || 0;
                return (
                  <Glass key={`${e.kind}-${e.tmdb_id}`} className="mv-lib-card">
                    <button className="mv-lib-art" onClick={() => setDetail({ kind: e.kind, id: e.tmdb_id })}>
                      {e.poster ? <img src={imgUrl(e.poster)} alt="" loading="lazy" /> : <Film size={22} strokeWidth={1.5} />}
                    </button>
                    <div className="mv-lib-info">
                      <div className="mv-lib-title" title={e.title}>{e.title}</div>
                      <div className="muted-sm">{e.year || "—"}{rating > 0 ? ` · ★ ${rating}` : ""}</div>
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
                        <Btn icon={Zap} onClick={() => setPlayer({ trailerKey: null })}>{t("movies.openPlayer")}</Btn>
                        <Btn icon={Trash2} onClick={() => void removeFromList(e)} disabled={busy} title={t("movies.removeFromList")} />
                      </div>
                    </div>
                  </Glass>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* Личная статистика */}
      {view === "stats" && <MediaStatsCard stats={stats} onClear={() => void clearStats()} busy={busy} />}
      </div>

      {/* Детали тайтла */}
      {detail && (
        <MediaDetailModal
          kind={detail.kind}
          id={detail.id}
          summary={detail.summary}
          onClose={() => setDetail(null)}
          onOpenTitle={(k, id) => setDetail({ kind: k, id })}
          onOpenPlayer={(tk) => setPlayer({ trailerKey: tk })}
          onChanged={loadLibrary}
        />
      )}

      {/* Плеер (трейлер/торрент) */}
      {player && <PlayerModal trailerKey={player.trailerKey} onClose={() => setPlayer(null)} />}
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
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          />
          <Btn variant="primary" icon={Save} disabled={saving || !draft.trim()} onClick={() => void save()}>
            {t("movies.keySave")}
          </Btn>
        </div>
      </Field>
      {error && <div className="mv-error-inline"><AlertTriangle size={14} style={{ color: "var(--coral)" }} /> {error}</div>}
      <div className="mv-key-links">
        <a className="mv-providers-link" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer noopener">
          <ExternalLink size={13} /> TMDB API
        </a>
        <span className="muted-sm">{t("movies.keyWhere")}</span>
      </div>
    </Glass>
  );
}