/**
 * API RSS-ридера (server/ts/routes/rss.ts).
 */
import { req, BASE, tokenHeaders } from "@/api/apiHttp";
import type {
  DigestResult,
  FeedWithCounts as RssFeed,
  ItemWithFeed as RssItem,
} from "@contracts/rss";

export type { RssFeed, RssItem };

export interface RssSettingsView {
  intervalMin: number;
  myMemoryEmail: string;
  libreUrl: string;
  lingvaUrl: string;
  hasLibreKey: boolean;
  unloadAfter: boolean;
}

export interface RssQuery {
  feed?: string;
  unread?: boolean;
  saved?: boolean;
  q?: string;
  limit?: number;
}

export const rssApi = {
  rssFeeds: () => req<RssFeed[]>("GET", "/rss/feeds"),
  rssAddFeed: (url: string) => req<RssFeed>("POST", "/rss/feeds", { url }),
  rssRemoveFeed: (id: string) => req<{ ok: boolean }>("DELETE", `/rss/feeds/${id}`),
  rssRefresh: (feedId?: string) =>
    req<{ added: number; failed: number }>("POST", "/rss/refresh", { feedId }),
  rssItems: (q: RssQuery = {}) => {
    const p = new URLSearchParams();
    if (q.feed) p.set("feed", q.feed);
    if (q.unread) p.set("unread", "1");
    if (q.saved) p.set("saved", "1");
    if (q.q) p.set("q", q.q);
    if (q.limit) p.set("limit", String(q.limit));
    return req<RssItem[]>("GET", `/rss/items?${p.toString()}`);
  },
  rssArticle: (id: string) =>
    req<{ blocks: { kind: "h" | "p" | "li" | "q"; text: string }[]; partial: boolean }>(
      "GET",
      `/rss/items/${id}/article`,
    ),
  rssTranslate: (ids: string[], lang: string, engine: string) =>
    req<{ items: { id: string; tr: { title: string; summary: string } | 0 }[]; tps?: number }>(
      "POST",
      "/rss/translate",
      { ids, lang, engine },
    ),
  rssArticleTranslate: (id: string, lang: string, engine: string) =>
    req<{
      blocks: { kind: "h" | "p" | "li" | "q"; text: string }[] | 0;
      tps?: number;
      cached?: boolean;
    }>("POST", `/rss/items/${id}/article-translate`, { lang, engine }),
  /** Поиск по статьям: по смыслу (EmbeddingGemma), с запасным текстовым поиском. */
  rssSearch: (q: RssQuery & { q: string }) => {
    const p = new URLSearchParams({ q: q.q });
    if (q.feed) p.set("feed", q.feed);
    if (q.unread) p.set("unread", "1");
    if (q.saved) p.set("saved", "1");
    return req<{ mode: "semantic" | "text"; items: RssItem[] }>(
      "GET",
      `/rss/search?${p.toString()}`,
    );
  },
  rssSettings: () => req<RssSettingsView>("GET", "/rss/settings"),
  /** Частичное сохранение: уходят только переданные поля (libreKey "" ключ не затирает). */
  rssSaveSettings: (
    patch: Partial<RssSettingsView> & { libreKey?: string; clearLibreKey?: boolean },
  ) => req<RssSettingsView>("PUT", "/rss/settings", patch),
  /** Очистка БД ридера: все статьи, кроме сохранённых, вместе с текстами и переводами. */
  rssUnloadModel: () => req<{ ok: boolean }>("POST", "/rss/translate/unload"),
  rssClear: () => req<{ removed: number }>("DELETE", "/rss/items"),
  rssItem: (id: string) => req<RssItem>("GET", `/rss/items/${id}`),
  rssPatchItem: (id: string, patch: { read?: boolean; saved?: boolean }) =>
    req<RssItem>("PATCH", `/rss/items/${id}`, patch),
  rssReadAll: (feedId?: string) =>
    req<{ marked: number }>("POST", "/rss/items/read-all", { feedId }),
  rssReadLater: (id: string) =>
    req<{ bookmarkId: string; note: string | null }>("POST", `/rss/items/${id}/read-later`),
  rssLastDigest: () =>
    req<(DigestResult & { createdAt: string; scope: string }) | null>("GET", "/rss/digest/last"),
  rssDigest: (scope: "unread" | "saved" | "all", language: string, feedId?: string) =>
    req<DigestResult>("POST", "/rss/digest", {
      scope,
      language,
      feedId,
    }),
  /** Текст OPML со всеми подписками (запрос идёт с токеном API, поэтому не обычной ссылкой). */
  rssExportOpml: async (): Promise<string> => {
    const r = await fetch(`${BASE}/api/rss/opml/export`, { headers: tokenHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  },
  rssImportOpml: (opml: string) =>
    req<{ added: number; skipped: number; failed: number }>("POST", "/rss/opml/import", { opml }),
};
