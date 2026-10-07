/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req } from "@/api/apiHttp";
import type {
  MediaStatus,
  MediaKind,
  MediaListResult,
  MediaGenre,
  MediaDetails,
  MediaProviders,
  MediaLibrary,
  MediaState,
  MediaWatchStatus,
  MediaWatchlistEntry,
  MediaBookmarks,
  MediaBookmarkList,
  MediaRatingEntry,
  MediaStats,
  TorrentAddResult,
  TorrentStatus,
  TorrentDownloadsResult,
  FfmpegStatus,
  TorrentMediaFileList,
  TorrentFile,
  TorrentTrackList,
  TorrentSeekInfo,
  TrackerStatus,
  TrackerConfigPatch,
  TrackerEngine,
  BrowserProbe,
  TrackerErrorDetails,
  TrackerSearchResult,
} from "@/api/types";

export const moviesApi = {
  // --- Фильмы и сериалы: каталог TMDB, библиотека, торрент-плеер ---
  moviesStatus: () => req<MediaStatus>("GET", "/movies/status"),
  moviesSaveKey: (key: string) =>
    req<{ ok: boolean; hasKey: boolean }>("POST", "/movies/key", { key }),
  moviesRefresh: () => req<{ ok: boolean }>("POST", "/movies/refresh"),
  moviesTrending: (kind: MediaKind, window: "day" | "week" = "week", page = 1) =>
    req<MediaListResult>("GET", `/movies/trending?kind=${kind}&window=${window}&page=${page}`),
  moviesList: (kind: MediaKind, category = "popular", page = 1) =>
    req<MediaListResult>("GET", `/movies/list?kind=${kind}&category=${category}&page=${page}`),
  moviesSearch: (q: string, kind: MediaKind | "multi" = "multi", page = 1) =>
    req<MediaListResult>(
      "GET",
      `/movies/search?q=${encodeURIComponent(q)}&kind=${kind}&page=${page}`,
    ),
  moviesGenres: (kind: MediaKind) =>
    req<{ genres: MediaGenre[] }>("GET", `/movies/genres?kind=${kind}`),
  moviesDiscover: (
    kind: MediaKind,
    p: { genre?: string | number; year?: string | number; sort?: string; page?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    qs.set("kind", kind);
    if (p.genre) qs.set("genre", String(p.genre));
    if (p.year) qs.set("year", String(p.year));
    if (p.sort) qs.set("sort", p.sort);
    if (p.page) qs.set("page", String(p.page));
    return req<MediaListResult>("GET", `/movies/discover?${qs.toString()}`);
  },
  moviesDetails: (kind: MediaKind, id: number) =>
    req<MediaDetails>("GET", `/movies/details/${kind}/${id}`),
  moviesProviders: (kind: MediaKind, id: number) =>
    req<MediaProviders>("GET", `/movies/providers/${kind}/${id}`),
  moviesLibrary: () => req<MediaLibrary>("GET", "/movies/library"),
  moviesState: (kind: MediaKind, id: number) =>
    req<MediaState>("GET", `/movies/state/${kind}/${id}`),
  moviesSetWatchlist: (p: {
    kind: MediaKind;
    id: number;
    title: string;
    poster?: string;
    year?: number | null;
    runtime?: number | null;
    genres?: (string | MediaGenre)[];
    status: MediaWatchStatus;
    /** Прогресс по сериалу — необязательно, не передан = не трогать сохранённое. */
    watchedSeason?: number;
    watchedEpisode?: number;
  }) => req<{ ok: boolean; watchlist: MediaWatchlistEntry }>("POST", "/movies/watchlist", p),
  moviesRemoveWatchlist: (kind: MediaKind, id: number) =>
    req<{ ok: boolean }>("DELETE", `/movies/watchlist/${kind}/${id}`),
  // --- Свои закладки (папки) — в отличие от watchlist их можно завести сколько угодно ---
  moviesBookmarks: () => req<MediaBookmarks>("GET", "/movies/bookmarks"),
  moviesBookmarkCreate: (name: string) =>
    req<{ ok: boolean; list: MediaBookmarkList }>("POST", "/movies/bookmarks", { name }),
  moviesBookmarkRename: (id: number, name: string) =>
    req<{ ok: boolean }>("PATCH", `/movies/bookmarks/${id}`, { name }),
  moviesBookmarkDelete: (id: number) => req<{ ok: boolean }>("DELETE", `/movies/bookmarks/${id}`),
  moviesBookmarkAddItem: (
    listId: number,
    p: { kind: MediaKind; id: number; title: string; poster?: string; year?: number | null },
  ) => req<{ ok: boolean }>("POST", `/movies/bookmarks/${listId}/items`, p),
  moviesBookmarkRemoveItem: (listId: number, kind: MediaKind, id: number) =>
    req<{ ok: boolean }>("DELETE", `/movies/bookmarks/${listId}/items/${kind}/${id}`),
  moviesBookmarkState: (kind: MediaKind, id: number) =>
    req<{ lists: number[] }>("GET", `/movies/bookmarks/state/${kind}/${id}`),
  moviesRate: (p: { kind: MediaKind; id: number; title?: string; rating: number }) =>
    req<{ ok: boolean; rating: MediaRatingEntry | null }>("POST", "/movies/rate", p),
  moviesWatch: (p: {
    kind: MediaKind;
    id: number;
    title?: string;
    genres?: (string | MediaGenre)[];
    cast?: { name: string }[];
    runtime?: number | null;
    progress?: number;
  }) => req<{ ok: boolean }>("POST", "/movies/watch", p),
  moviesRemoveWatch: (kind: MediaKind, id: number) =>
    req<{ ok: boolean }>("DELETE", `/movies/watch/${kind}/${id}`),
  moviesStats: () => req<MediaStats>("GET", "/movies/stats"),
  moviesClearStats: () => req<{ ok: boolean }>("POST", "/movies/stats/clear"),

  // Торрент-плеер: источник (magnet/.torrent) задаёт пользователь.
  moviesTorrentEngine: () =>
    req<{ installed: boolean; client?: boolean; error?: string }>("GET", "/movies/torrent/engine"),
  moviesTorrentActive: () =>
    req<{ infoHash: string; name: string; progress: number; peers: number }[]>(
      "GET",
      "/movies/torrent/active",
    ),
  /** Добавить раздачу. title — название фильма (для реестра «Скачанные»). */
  moviesTorrentAdd: (p: { magnet?: string; torrent?: string; title?: string }) =>
    req<TorrentAddResult>("POST", "/movies/torrent/add", p),
  moviesTorrentStatus: (infoHash: string) =>
    req<TorrentStatus>("GET", `/movies/torrent/status/${encodeURIComponent(infoHash)}`),
  /** Удалить раздачу: files=false — «убрать из списка, файлы оставить». */
  moviesTorrentRemove: (infoHash: string, opts: { files?: boolean } = {}) =>
    req<{ removed: boolean; files: boolean }>(
      "DELETE",
      `/movies/torrent/${encodeURIComponent(infoHash)}${opts.files === false ? "?files=0" : ""}`,
    ),
  /** Вкладка «Скачанные»: реестр загрузок + галочка по умолчанию. */
  moviesTorrentDownloads: () => req<TorrentDownloadsResult>("GET", "/movies/torrent/downloads"),
  /** Остановить загрузку (пауза): скачанное остаётся на диске. */
  moviesTorrentStop: (infoHash: string) =>
    req<{ stopped: boolean; state: string }>("POST", "/movies/torrent/stop", { infoHash }),
  /** Возобновить остановленную загрузку по сохранённому .torrent/magnet. */
  moviesTorrentResume: (infoHash: string) =>
    req<TorrentAddResult>("POST", "/movies/torrent/resume", { infoHash }),
  /**
   * Галочка «хранить скачанный торрент после просмотра»: для одной раздачи
   * (infoHash) и/или как значение по умолчанию для новых (saveDefault).
   */
  moviesTorrentKeep: (p: { infoHash?: string; keep: boolean; saveDefault?: boolean }) =>
    req<{ ok: boolean; keep: boolean; keepDefault: boolean; purged: number }>(
      "POST",
      "/movies/torrent/keep",
      p,
    ),
  /** Сохранить позицию просмотра (секунды) — продолжим с неё в следующий раз. */
  moviesTorrentPosition: (infoHash: string, position: number) =>
    req<{ ok: boolean }>("POST", "/movies/torrent/position", { infoHash, position }),
  /** Убрать завершённые раздачи, которые решили не хранить (освободить место). */
  moviesTorrentCleanup: () => req<{ purged: number }>("POST", "/movies/torrent/cleanup"),
  /** ffmpeg для плеера: путь, версия и где искали; force — пересобрать кэш. */
  moviesFfmpeg: (force = false) =>
    req<FfmpegStatus>("GET", `/movies/ffmpeg${force ? "?force=1" : ""}`),
  moviesTorrentFile: (infoHash: string, index: number) =>
    req<{ name: string; length: number; mime: string }>(
      "GET",
      `/movies/torrent/file/${encodeURIComponent(infoHash)}/${index}`,
    ),
  /** URL стрима для HTML5 <video> (Range поддерживается). */
  moviesTorrentStreamUrl: (infoHash: string, index: number) =>
    `/api/movies/torrent/stream/${encodeURIComponent(infoHash)}/${index}`,

  // Сценарий А: файлы раздачи (серии) — метаданные до полной загрузки.
  moviesTorrentFiles: (p: {
    magnet?: string;
    torrent?: string;
    infoHash?: string;
    mediaOnly?: boolean;
  }) => req<TorrentMediaFileList>("POST", "/movies/torrent/files", p),
  /** Переключить файл (серию): куски выбранного файла получают приоритет загрузки. */
  moviesTorrentSelect: (infoHash: string, index: number) =>
    req<TorrentFile>("POST", "/movies/torrent/select", { infoHash, index }),

  // Сценарий Б: дорожки файла через ffprobe (аудио, субтитры, длительность).
  moviesTorrentTracks: (infoHash: string, index: number) =>
    req<TorrentTrackList>("GET", `/movies/torrent/tracks/${encodeURIComponent(infoHash)}/${index}`),
  /**
   * Честная секунда старта перемотки.
   *
   * Копирование (`copy=true`) отдаёт начало только с ключевого кадра, и звук после
   * этого расходится с картинкой на длину GOP (живой замер: 2.294 с), поэтому плеер
   * перематывает точным seek — `copy=false`: видео перекодируется, `startSec` равна
   * запрошенной секунде, и шкала с субтитрами не врут.
   */
  moviesTorrentSeek: (infoHash: string, index: number, at: number, copy = true) =>
    req<TorrentSeekInfo>(
      "GET",
      `/movies/torrent/seek/${encodeURIComponent(infoHash)}/${index}` +
        `?at=${Math.max(0, Math.floor(Number(at) || 0))}&copy=${copy ? 1 : 0}`,
    ),

  /* --- Форум-трекер: поиск раздач (rutracker.org и phpBB-совместимые) --- */
  moviesTrackerStatus: () =>
    req<TrackerStatus & { ffmpeg: boolean; ffprobe: boolean }>("GET", "/movies/tracker/status"),
  moviesTrackerConfig: (patch: TrackerConfigPatch) =>
    req<{ ok: boolean; status: TrackerStatus }>("POST", "/movies/tracker/config", patch),
  /**
   * Переключить трекер (rutracker ↔ rutor): бэкенд применяет пресет площадки
   * целиком — пути, кодировку, способ поиска и движок разбора выдачи.
   */
  moviesTrackerPreset: (id: string) =>
    req<{
      ok: boolean;
      id: string;
      engine: TrackerEngine;
      label: string;
      baseUrl: string;
      status: TrackerStatus;
    }>("POST", "/movies/tracker/preset", { id }),
  moviesTrackerLogin: () =>
    req<{ ok: boolean; sid: string | null }>("POST", "/movies/tracker/login"),
  moviesTrackerLogout: () => req<{ ok: boolean }>("POST", "/movies/tracker/logout"),
  /**
   * Импорт куки из браузера: приложение само читает базу куки установленных
   * браузеров. Пользователь просто входит на форум в браузере и жмёт кнопку.
   */
  moviesTrackerCookiesFromBrowser: () =>
    req<{
      ok: boolean;
      cookies: string[];
      probes: BrowserProbe[];
      source: { browser: string; profile: string; version: string } | null;
      userAgent: string;
      probe: TrackerErrorDetails;
      session: { sid: string | null; updatedAt: string };
      status: TrackerStatus;
    }>("POST", "/movies/tracker/cookies/from-browser"),
  /** Проверка текущей сессии форума (пустил / Cloudflare / форма входа). */
  moviesTrackerSession: () => req<{ probe: TrackerErrorDetails }>("GET", "/movies/tracker/session"),
  /**
   * Импорт куки строкой вручную: «cf_clearance=…; bb_data=…». Запасной путь,
   * когда браузер не найден или нужен профиль другого пользователя Windows.
   */
  moviesTrackerCookies: (cookies: string, userAgent?: string) =>
    req<{
      ok: boolean;
      cookies: string[];
      session: { sid: string | null; updatedAt: string };
      status: TrackerStatus;
    }>("POST", "/movies/tracker/cookies", { cookies, userAgent }),
  moviesTrackerSearch: (query: string, opts: { limit?: number; refresh?: boolean } = {}) =>
    req<TrackerSearchResult>("POST", "/movies/tracker/search", { query, ...opts }),
  /**
   * Открыть раздачу: .torrent скачивает бэкенд своими сессионными куками форума
   * (в браузер они не попадают), а нам возвращается список файлов раздачи.
   */
  moviesTrackerAdd: (id: string, opts: { title?: string; magnet?: string } = {}) =>
    req<TorrentMediaFileList & { release: { id: string; name: string } }>(
      "POST",
      "/movies/tracker/add",
      { id, ...opts },
    ),
};
