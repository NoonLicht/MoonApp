/**
 * Картинки TMDB — через прокси приложения.
 *
 * TMDB отдаёт постеры/кадры/аватары с `image.tmdb.org`, и Chromium грузит их
 * НАПРЯМУЮ, минуя per-page прокси страницы. На сетях с блокировкой TMDB такие
 * запросы падают с ERR_CONNECTION_REFUSED (а в собранной версии их ещё и режет
 * CSP `img-src 'self'`). Поэтому все ссылки на картинки TMDB прогоняем через
 * `/api/movies/image` (см. server/tmdb.js → fetchImage + server/routes/movies.js):
 * там используется тот же прокси, что и для API-запросов страницы.
 */

/** https://image.tmdb.org/t/p/<size>/<path> → размер + путь */
const TMDB_IMG = /^https?:\/\/image\.tmdb\.org\/t\/p\/([A-Za-z0-9]+)(\/.+)$/;

/** Уже проксированный URL — возвращаем как есть (идемпотентность). */
const ALREADY_PROXIED = /^\/api\/movies\/image\?/;

/**
 * Привести ссылку на картинку к прокси-URL приложения.
 * Для пустого значения возвращает "" — удобно писать `{url && <img src={url} />}`.
 * Нетематографические/внешние ссылки не трогаем.
 */
export function imgUrl(url?: string | null): string {
  if (!url) return "";
  if (ALREADY_PROXIED.test(url)) return url;
  const m = TMDB_IMG.exec(url);
  if (!m) return url;
  return `/api/movies/image?s=${encodeURIComponent(m[1])}&p=${encodeURIComponent(m[2])}`;
}

/** То же, но строкой CSS для инлайнового background-image. */
export function imgCssUrl(url?: string | null): string {
  const u = imgUrl(url);
  return u ? `url("${u}")` : "none";
}