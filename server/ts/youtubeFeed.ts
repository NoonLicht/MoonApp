/**
 * Подписка на каналы YouTube через RSS: у каждого канала и плейлиста есть
 * публичная лента Atom, которую читает обычный RSS-ридер.
 *
 *  - /channel/UC…, голый идентификатор UC… и /playlist?list=… дают ленту сразу;
 *  - @handle, /c/имя и /user/имя требуют загрузки страницы, чтобы найти channelId.
 */

const FEED = "https://www.youtube.com/feeds/videos.xml";
const CHANNEL_ID = /^UC[\w-]{22}$/;

export type FeedResolution =
  | { kind: "feed"; url: string }
  | { kind: "page"; pageUrl: string }
  | null;

/** Определяет, как получить ленту по ссылке/идентификатору; null — это не YouTube. */
export function resolveYoutube(input: string): FeedResolution {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (CHANNEL_ID.test(raw)) return { kind: "feed", url: `${FEED}?channel_id=${raw}` };
  if (/^@[\w.-]{2,}$/.test(raw)) return { kind: "page", pageUrl: `https://www.youtube.com/${raw}` };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host !== "youtube.com") return null;
  if (u.pathname.startsWith("/feeds/videos.xml")) return { kind: "feed", url: u.toString() };
  const ch = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (ch) return { kind: "feed", url: `${FEED}?channel_id=${ch[1]}` };
  const list = u.searchParams.get("list");
  if (u.pathname === "/playlist" && list && /^[\w-]{10,}$/.test(list))
    return { kind: "feed", url: `${FEED}?playlist_id=${list}` };
  if (/^\/(@[\w.-]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname))
    return { kind: "page", pageUrl: `https://www.youtube.com${u.pathname.split("/").slice(0, 3).join("/").replace(/^(\/@[\w.-]+).*/, "$1")}` };
  return null;
}

/** Находит идентификатор канала в HTML страницы канала. */
export function channelIdFromHtml(html: string): string | null {
  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Ссылка на ленту по произвольному вводу; fetchPage — загрузка HTML. null — не YouTube. */
export async function youtubeFeedUrl(
  input: string,
  fetchPage: (url: string) => Promise<string>,
): Promise<string | null> {
  const r = resolveYoutube(input);
  if (!r) return null;
  if (r.kind === "feed") return r.url;
  const id = channelIdFromHtml(await fetchPage(r.pageUrl));
  if (!id) throw new Error("youtube_channel_not_found");
  return `${FEED}?channel_id=${id}`;
}
