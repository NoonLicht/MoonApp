/** Контракты API RSS-ридера (server/ts/rss.ts, routes/rss.ts). Только типы. */

export interface Feed {
  id: string;
  url: string;
  title: string;
  /** Сайт ленты (для ссылки в заголовке). */
  site?: string;
  addedAt: number;
  lastFetched?: number;
  /** Текст последней ошибки загрузки; пусто — лента в порядке. */
  error?: string;
  etag?: string;
  lastModified?: string;
}

/** Лента со счётчиками для списка подписок. */
export type FeedWithCounts = Feed & { unread: number; total: number };

export interface Item {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  /** ISO-дата публикации (если лента не дала дату — момент загрузки). */
  published: string;
  /** Короткое описание простым текстом. */
  summary: string;
  /** Первая картинка статьи, если нашлась. */
  image?: string;
  read: boolean;
  saved: boolean;
  /** Перевод заголовка и описания по коду языка интерфейса; 0 — переводить не нужно. */
  tr?: Record<string, { title: string; summary: string } | 0>;
}

export type ItemWithFeed = Item & { feedTitle: string };

export interface DigestResult {
  markdown: string;
  count: number;
  provider: string;
  model: string;
}
