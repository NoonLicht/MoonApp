/**
 * RSS / новостной ридер: подписки на ленты (RSS 2.0, Atom, RDF), хранение статей,
 * отметки «прочитано» / «сохранено», импорт и экспорт OPML и ИИ-сводка новостей.
 *
 * Всё локально: ленты и статьи лежат в БД приложения (data.db, таблица app_docs); старый rss.json импортируется один раз. Парсер написан без
 * зависимостей (регулярные выражения над тегами) и рассчитан на «грязные» ленты из
 * реального мира: CDATA, HTML в описаниях, числовые сущности, Atom с `<link href>`.
 * Сеть идёт через per-page прокси (страница "rss"), как у остальных внешних запросов.
 *
 * Чистые функции (parseFeed, parseOpml, buildOpml, mergeItems, digest-промпт) не
 * трогают диск и сеть — их покрывает tests/rss.test.ts.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";

import type { Feed, FeedWithCounts, Item, ItemWithFeed, DigestResult } from "./contracts/rss";

export type { Feed, FeedWithCounts, Item, ItemWithFeed, DigestResult };

const { FILES } = config;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { docStore } = require("./db") as typeof import("./db");

/* ------------------------------- типы ------------------------------------- */

export interface ParsedItem {
  guid: string;
  title: string;
  link: string;
  published: string;
  summary: string;
  image?: string;
}

export interface ParsedFeed {
  title: string;
  site?: string;
  items: ParsedItem[];
}

/* ------------------------------ разбор XML -------------------------------- */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** HTML → простой текст: без скриптов/стилей/тегов, с нормальными пробелами. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const unCdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/** Содержимое всех элементов `<tag>…</tag>` (теги с префиксом пространства имён тоже). */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Текст первого элемента `<tag>`; CDATA снимается, сущности раскрываются. */
function tagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? decodeEntities(unCdata(m[1])).trim() : "";
}

/** Сырое (с HTML) содержимое элемента — для поиска картинок и описаний. */
function tagRaw(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? unCdata(m[1]) : "";
}

/** Значение атрибута у первого подходящего тега: `<link href="…" rel="alternate"/>`. */
function attr(xml: string, tag: string, name: string, filter?: (attrs: string) => boolean): string {
  const re = new RegExp(`<${tag}(\\s[^>]*?)/?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (filter && !filter(m[1])) continue;
    const a = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(m[1]);
    if (a) return decodeEntities(a[1]).trim();
  }
  return "";
}

function toIso(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function firstImage(...sources: string[]): string | undefined {
  for (const s of sources) {
    const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(s);
    if (m) return decodeEntities(m[1]);
  }
  return undefined;
}

/** Разбор ленты RSS 2.0 / Atom / RDF. Бросает feed_not_recognized, если это не лента. */
export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""));
  const entries = blocks(xml, isAtom ? "entry" : "item");
  if (!entries.length && !/<(rss|feed|rdf:RDF|channel)[\s>]/i.test(xml)) {
    throw new Error("feed_not_recognized");
  }
  // Заголовок ленты — до первого элемента, иначе title первой статьи его подменит.
  const head = xml.slice(0, Math.max(0, xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i)) || xml.length);
  const title = tagText(head, "title") || "";
  const site = isAtom
    ? attr(head, "link", "href", (a) => !/rel\s*=\s*["'](self|hub)["']/i.test(a))
    : tagText(head, "link");

  const items: ParsedItem[] = entries.map((b) => {
    const link = isAtom
      ? attr(b, "link", "href", (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a))
      : tagText(b, "link") || attr(b, "link", "href");
    const rawBody =
      tagRaw(b, "content:encoded") || tagRaw(b, "content") || tagRaw(b, "description") || tagRaw(b, "summary");
    const rawDesc = tagRaw(b, "description") || tagRaw(b, "summary");
    const published = toIso(
      tagText(b, "pubDate") || tagText(b, "published") || tagText(b, "updated") || tagText(b, "dc:date"),
    );
    const image =
      attr(b, "media:thumbnail", "url") ||
      attr(b, "media:content", "url", (a) => /medium\s*=\s*["']image|type\s*=\s*["']image/i.test(a)) ||
      attr(b, "enclosure", "url", (a) => /type\s*=\s*["']image/i.test(a)) ||
      firstImage(decodeEntities(rawBody), rawBody, decodeEntities(rawDesc));
    const guid = tagText(b, "guid") || tagText(b, "id") || link;
    return {
      guid,
      title: stripHtml(tagText(b, "title")) || link,
      link,
      published,
      summary: stripHtml(decodeEntities(rawDesc || rawBody)).slice(0, 600),
      image: image || undefined,
    };
  });
  return { title: stripHtml(title), site: site || undefined, items: items.filter((i) => i.guid || i.link) };
}

/** Подписки из OPML (вложенные категории раскрываются в плоский список). */
export function parseOpml(xml: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  const re = /<outline\s[^>]*?xmlUrl\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const t = /(?:title|text)\s*=\s*["']([^"']*)["']/i.exec(tag);
    out.push({ title: decodeEntities(t?.[1] || ""), url: decodeEntities(m[1]) });
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildOpml(feeds: Pick<Feed, "title" | "url" | "site">[]): string {
  const rows = feeds
    .map(
      (f) =>
        `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.site ? ` htmlUrl="${esc(f.site)}"` : ""}/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>MoonApp RSS</title></head>\n  <body>\n${rows}\n  </body>\n</opml>\n`;
}

/* -------------------------- слияние и хранение ----------------------------- */

const KEEP_PER_FEED = 1000;

export const itemId = (feedId: string, guid: string): string =>
  crypto.createHash("sha1").update(`${feedId}\n${guid}`).digest("hex").slice(0, 16);

/**
 * Добавляет новые статьи к существующим: отметки read/saved у известных сохраняются,
 * дубли по guid отбрасываются, хвост старше KEEP_PER_FEED обрезается (сохранённые
 * остаются навсегда). Возвращает новый список и число действительно новых статей.
 */
export function mergeItems(
  existing: Item[],
  feedId: string,
  parsed: ParsedItem[],
  nowIso: string,
): { items: Item[]; added: number } {
  const known = new Set(existing.filter((i) => i.feedId === feedId).map((i) => i.id));
  const fresh: Item[] = [];
  for (const p of parsed) {
    const id = itemId(feedId, p.guid || p.link);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push({
      id,
      feedId,
      guid: p.guid || p.link,
      title: p.title,
      link: p.link,
      published: p.published || nowIso,
      summary: p.summary,
      image: p.image,
      read: false,
      saved: false,
    });
  }
  const all = [...existing, ...fresh];
  // Обрезка: у ленты оставляем KEEP_PER_FEED самых свежих + все сохранённые.
  const mine = all
    .filter((i) => i.feedId === feedId)
    .sort((a, b) => b.published.localeCompare(a.published));
  const drop = new Set(mine.slice(KEEP_PER_FEED).filter((i) => !i.saved).map((i) => i.id));
  return { items: all.filter((i) => !drop.has(i.id)), added: fresh.length };
}

interface Db {
  feeds: Feed[];
  items: Item[];
}

/** Документы RSS живут в таблице app_docs БД: kind "rss_feed" / "rss_item" (uid = id), JSON в колонке json. */
let legacyChecked = false;
function importLegacyRss(): void {
  if (legacyChecked) return;
  legacyChecked = true;
  try {
    if (docStore.all("rss_feed").length || docStore.all("rss_item").length) return;
    if (!fs.existsSync(FILES.rss)) return;
    const raw = JSON.parse(fs.readFileSync(FILES.rss, "utf8"));
    const feeds: Feed[] = Array.isArray(raw.feeds) ? raw.feeds : [];
    const items: Item[] = Array.isArray(raw.items) ? raw.items : [];
    if (!feeds.length && !items.length) return;
    docStore.sync("rss_feed", new Map(feeds.map((f) => [f.id, JSON.stringify(f)])));
    docStore.sync("rss_item", new Map(items.map((i) => [i.id, JSON.stringify(i)])));
    fs.renameSync(FILES.rss, FILES.rss + ".migrated");
  } catch {
    /* повреждённый старый файл не должен ронять ридер */
  }
}

function read(): Db {
  importLegacyRss();
  const parse = <T>(kind: string): T[] => {
    const out: T[] = [];
    for (const d of docStore.all(kind)) {
      try {
        out.push(JSON.parse(d.json) as T);
      } catch {
        /* битый документ пропускаем */
      }
    }
    return out;
  };
  return { feeds: parse<Feed>("rss_feed"), items: parse<Item>("rss_item") };
}
function write(db: Db): void {
  docStore.sync("rss_feed", new Map(db.feeds.map((f) => [f.id, JSON.stringify(f)])));
  docStore.sync("rss_item", new Map(db.items.map((i) => [i.id, JSON.stringify(i)])));
}

/* --------------------------------- сеть ------------------------------------ */

export interface FetchResult {
  status: number;
  text: string;
  etag?: string;
  lastModified?: string;
}
export type Fetcher = (
  url: string,
  cond: { etag?: string; lastModified?: string },
) => Promise<FetchResult>;

const MAX_BYTES = 5 * 1024 * 1024;

export function assertHttpUrl(url: unknown): string {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("invalid_url");
  return u.toString();
}

/** Загрузка через per-page прокси: страница "rss" может идти через прокси отдельно от остальных. */
export const defaultFetcher: Fetcher = async (url, cond) => {
   
  const ppr = require("./middleware/perPageProxy") as typeof import("./middleware/perPageProxy");
   
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await ppr.runWithPage("rss", () =>
      ppr.pageFetch(url, {
        signal: ctl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/1.0",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          ...(cond.etag ? { "If-None-Match": cond.etag } : {}),
          ...(cond.lastModified ? { "If-Modified-Since": cond.lastModified } : {}),
        },
      }),
    );
    if (res.status === 304) return { status: 304, text: "" };
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("feed_too_large");
    return {
      status: res.status,
      text,
      etag: res.headers.get("etag") || undefined,
      lastModified: res.headers.get("last-modified") || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
};

/* --------------------- фоновое автообновление и его настройки --------------------- */

export interface RssSettings {
  /** Раз в сколько минут обновлять ленты; 0 — выключено. */
  intervalMin: number;
  /** Необязательный e-mail для MyMemory: поднимает суточный лимит с 5 000 до 50 000 символов. */
  myMemoryEmail: string;
  /** Адрес сервера LibreTranslate (свой или публичный) и ключ, если сервер его требует. */
  libreUrl: string;
  libreKey: string;
  /** Адрес сервера Lingva Translate. */
  lingvaUrl: string;
  /** Выгружать локальную модель перевода из памяти вскоре после перевода. */
  unloadAfter: boolean;
}
const DEFAULT_SETTINGS: RssSettings = {
  intervalMin: 5,
  myMemoryEmail: "",
  libreUrl: "",
  libreKey: "",
  lingvaUrl: "https://lingva.ml",
  unloadAfter: false,
};

export function getSettings(): RssSettings {
  const d = docStore.all("rss_settings")[0];
  if (!d) return { ...DEFAULT_SETTINGS };
  try {
    return normSettings(JSON.parse(d.json));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function normSettings(v: unknown): RssSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = Number(o.intervalMin);
  const str = (x: unknown, d: string): string => (typeof x === "string" ? x.trim().slice(0, 300) : d);
  return {
    intervalMin: Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(15, Math.max(1, Math.round(n)))) : DEFAULT_SETTINGS.intervalMin,
    myMemoryEmail: str(o.myMemoryEmail, ""),
    libreUrl: str(o.libreUrl, ""),
    libreKey: str(o.libreKey, ""),
    lingvaUrl: str(o.lingvaUrl, DEFAULT_SETTINGS.lingvaUrl) || DEFAULT_SETTINGS.lingvaUrl,
    unloadAfter: o.unloadAfter === true,
  };
}

/** Настройки для клиента: ключ наружу не отдаём — только факт, что он сохранён. */
export function publicSettings(): Omit<RssSettings, "libreKey"> & { hasLibreKey: boolean } {
  const { libreKey, ...rest } = getSettings();
  return { ...rest, hasLibreKey: !!libreKey };
}

/** Частичное обновление: поля, которых нет в запросе, остаются как были; libreKey "" не затирает ключ. */
export function setSettings(v: unknown): RssSettings {
  const cur = getSettings();
  const patch = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...cur };
  for (const k of ["intervalMin", "myMemoryEmail", "libreUrl", "lingvaUrl", "unloadAfter"]) if (k in patch) merged[k] = patch[k];
  if (typeof patch.libreKey === "string" && patch.libreKey) merged.libreKey = patch.libreKey;
  if (patch.clearLibreKey === true) merged.libreKey = "";
  const s = normSettings(merged);
  docStore.sync("rss_settings", new Map([["main", JSON.stringify(s)]]));
  lastAutoRun = Date.now(); // отсчёт нового интервала — с момента сохранения
  return s;
}

let lastAutoRun = 0;
let autoBusy = false;
let autoTimer: NodeJS.Timeout | null = null;

/**
 * Запускается вместе с сервером и работает, пока приложение открыто, — страница RSS для этого
 * открываться не обязана. Каждые 30 с проверяет, не пора ли обновить ленты по настройке.
 */
export function startAutoRefresh(): void {
  if (autoTimer) return;
  lastAutoRun = Date.now() - 10 * 60 * 1000 + 20 * 1000; // первое обновление через ~20 с после старта
  autoTimer = setInterval(() => {
    const { intervalMin } = getSettings();
    if (!intervalMin || autoBusy || Date.now() - lastAutoRun < intervalMin * 60 * 1000) return;
    if (!listFeeds().length) return;
    autoBusy = true;
    lastAutoRun = Date.now();
    refresh()
      .then((r) => {
        if (r.added) reindexSemantic();
      })
      .catch(() => undefined)
      .finally(() => {
        autoBusy = false;
      });
  }, 30 * 1000);
  autoTimer.unref();
}

/* ------------------------- текст статьи по ссылке --------------------------- */

export interface ArticleBlock {
  kind: "h" | "p" | "li" | "q";
  text: string;
}
export interface Article {
  blocks: ArticleBlock[];
  /** true — вытащить текст со страницы не удалось, показан только анонс из ленты. */
  partial: boolean;
}

/** HTML страницы → читаемые блоки (заголовки, абзацы, списки, цитаты). Без картинок и меню. */
export function extractArticle(html: string): ArticleBlock[] {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|figcaption)\b[\s\S]*?<\/\1>/gi, " ");
  const pick = (tag: string): string | undefined => {
    const all = [...h.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"))].map((m) => m[0]);
    return all.sort((a, b) => b.length - a.length)[0];
  };
  h = pick("article") || pick("main") || h;
  const out: ArticleBlock[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const m of h.matchAll(/<(h[1-4]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const text = stripHtml(m[2]);
    const min = tag[0] === "h" ? 3 : 30;
    if (text.length < min) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const kind: ArticleBlock["kind"] = tag[0] === "h" ? "h" : tag === "li" ? "li" : tag === "p" ? "p" : "q";
    out.push({ kind, text });
    total += text.length;
    if (out.length >= 150 || total > 60000) break;
  }
  return out;
}

const articleCache = new Map<string, Article>();

function docGet<T>(kind: string, uid: string): T | undefined {
  const j = docStore.get(kind, uid);
  if (j === undefined) return undefined;
  try {
    return JSON.parse(j) as T;
  } catch {
    return undefined;
  }
}
function docSet(kind: string, uid: string, value: unknown): void {
  docStore.set(kind, uid, JSON.stringify(value));
}

export async function fetchArticle(id: string, fetcher: Fetcher = defaultFetcher): Promise<Article> {
  const it = getItem(id);
  if (!it) throw new Error("not_found");
  const hit = articleCache.get(id) ?? docGet<Article>("rss_article", id);
  if (hit) {
    articleCache.set(id, hit);
    return hit;
  }
  let blocks: ArticleBlock[] = [];
  try {
    const r = await fetcher(assertHttpUrl(it.link), {});
    if (r.status >= 200 && r.status < 300) blocks = extractArticle(r.text);
  } catch {
    /* страница недоступна — покажем анонс */
  }
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);
  const art: Article =
    chars >= 300
      ? { blocks, partial: false }
      : { blocks: it.summary ? [{ kind: "p", text: it.summary }] : [], partial: true };
  if (articleCache.size > 50) articleCache.clear();
  articleCache.set(id, art);
  // Полный текст сохраняем в БД (оригинал); анонс-заглушку — нет, чтобы позже попробовать снова.
  if (!art.partial) docSet("rss_article", id, art);
  return art;
}

/* ------------------- перевод новостей на язык пользователя ------------------- */

const TARGET_SCRIPT: Record<string, string> = { ru: "cyr", en: "lat", es: "lat", fr: "lat", zh: "cjk", ar: "ar" };
const LANG_NAMES: Record<string, string> = {
  ru: "Russian",
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese (Simplified)",
  ar: "Arabic",
};

/** Преобладающая письменность текста: cyr / cjk / ar / lat или "" (мало букв). */
export function scriptOf(text: string): string {
  const count = (re: RegExp) => (text.match(re) || []).length;
  const n = {
    cyr: count(/[Ѐ-ӿ]/g),
    cjk: count(/[぀-ヿ一-鿿가-힯]/g),
    ar: count(/[؀-ۿ]/g),
    lat: count(/[A-Za-zÀ-ɏ]/g),
  };
  const total = n.cyr + n.cjk + n.ar + n.lat;
  if (total < 6) return "";
  const best = (Object.entries(n) as [string, number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] / total >= 0.5 ? best[0] : "";
}

/** Вытаскивает первый JSON-массив из ответа модели (может быть в ```-блоке или с текстом вокруг). */
export function parseJsonArray(text: string): unknown[] | null {
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function askJson(prompt: string, maxTokens: number): Promise<unknown[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { askAi } = require("./notesAi") as typeof import("./notesAi");
  const r = await askAi(
    prompt,
    "You are a precise news translator. Reply with a JSON array only, no commentary, no code fences.",
    "rss",
    maxTokens,
  );
  const arr = parseJsonArray(r.text);
  if (!arr) throw new Error("bad_translation_format");
  return arr;
}

export type TranslateEngine = "ai" | "local" | "google" | "mymemory" | "libre" | "lingva";
const ENGINE_LIST: TranslateEngine[] = ["ai", "local", "google", "mymemory", "libre", "lingva"];
export const normEngine = (e: unknown): TranslateEngine =>
  ENGINE_LIST.includes(e as TranslateEngine) ? (e as TranslateEngine) : "ai";

/** Результат пакетного перевода: null на месте строки — переводить не нужно; tps — токенов/с (локальная модель). */
interface Translated {
  out: (string | null)[];
  tps?: number;
}

const CODE_ALIAS: Record<string, string> = { zh: "zh-CN" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

/** Сетевой запрос через прокси страницы «rss» (как загрузка лент). */
async function netFetch(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ppr = require("./middleware/perPageProxy") as typeof import("./middleware/perPageProxy");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await ppr.runWithPage("rss", () =>
      ppr.pageFetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { "User-Agent": BROWSER_UA, ...((init.headers as Record<string, string>) || {}) },
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Режет текст по границам предложений на куски не длиннее max (для движков с лимитом запроса). */
export function splitForLimit(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if ((cur + " " + sentence).trim().length > max) {
      if (cur) out.push(cur);
      cur = sentence;
      while (cur.length > max) {
        out.push(cur.slice(0, max));
        cur = cur.slice(max);
      }
    } else cur = (cur + " " + sentence).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------- Google Translate ------------------------------- */

const GOOGLE_BATCH_CHARS = 4000;
/** После отказа (429) движок «отдыхает»: иначе блокировка только продлевается. */
const blockedUntil: Record<string, number> = {};
const guard = (engine: string): void => {
  if (Date.now() < (blockedUntil[engine] || 0)) throw new Error(`${engine}_rate_limited`);
};
const trip = (engine: string, ms = 15 * 60 * 1000): never => {
  blockedUntil[engine] = Date.now() + ms;
  throw new Error(`${engine}_rate_limited`);
};

/**
 * Раскладывает ответ Google (список [перевод, оригинал] по предложениям) обратно по исходным
 * строкам. Строки склеены через "\n", поэтому границы определяем по накопленной длине оригиналов.
 */
export function alignGoogle(texts: string[], segments: [string, string][]): string[] {
  const starts: number[] = [];
  let pos = 0;
  for (const t of texts) {
    starts.push(pos);
    pos += t.length + 1;
  }
  const out = texts.map(() => "");
  let at = 0;
  for (const seg of segments) {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > at) i--;
    out[i] += seg[0] || "";
    at += (seg[1] || "").length;
  }
  return out.map((s) => s.trim());
}

async function googleRequest(texts: string[], lang: string): Promise<(string | null)[]> {
  guard("google");
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&ie=UTF-8&oe=UTF-8&tl=" +
    encodeURIComponent(CODE_ALIAS[lang] || lang);
  const clean = texts.map((t) => t.replace(/\s*\n\s*/g, " ").trim());
  const res = await netFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "q=" + encodeURIComponent(clean.join("\n")),
  });
  if (res.status === 429 || res.status === 403) trip("google");
  if (!res.ok) throw new Error(`google_http_${res.status}`);
  const d = (await res.json()) as [[string, string][], unknown, string];
  if (String(d[2] || "").toLowerCase().split("-")[0] === lang) return texts.map(() => null);
  const tr = alignGoogle(clean, d[0] || []);
  return tr.map((x, i) => (clean[i] ? x || null : null));
}

async function googleMany(texts: string[], lang: string): Promise<Translated> {
  const out: (string | null)[] = new Array(texts.length).fill(null);
  let i = 0;
  while (i < texts.length) {
    const idx: number[] = [];
    let chars = 0;
    while (i < texts.length && (idx.length === 0 || chars + texts[i].length < GOOGLE_BATCH_CHARS)) {
      idx.push(i);
      chars += Math.min(texts[i].length, GOOGLE_BATCH_CHARS) + 1;
      i++;
    }
    const part = await googleRequest(idx.map((k) => texts[k].slice(0, GOOGLE_BATCH_CHARS)), lang);
    idx.forEach((k, n) => {
      out[k] = part[n];
    });
    if (i < texts.length) await sleep(400);
  }
  return { out };
}

/* ------------------------------- MyMemory ------------------------------- */

/** MyMemory: бесплатно без ключа (≈5 000 символов в сутки; с e-mail в настройках — до 50 000), ≤500 символов в запросе. */
async function myMemoryMany(texts: string[], lang: string): Promise<Translated> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectLanguage } = require("./translate/languages") as typeof import("./translate/languages");
  const email = getSettings().myMemoryEmail;
  const out: (string | null)[] = [];
  for (const text of texts) {
    const src = detectLanguage(text);
    if (!text.trim() || src === lang) {
      out.push(null);
      continue;
    }
    const parts: string[] = [];
    for (const piece of splitForLimit(text, 450)) {
      guard("mymemory");
      const url =
        "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(piece) +
        `&langpair=${encodeURIComponent(`${CODE_ALIAS[src] || src}|${CODE_ALIAS[lang] || lang}`)}` +
        (email ? `&de=${encodeURIComponent(email)}` : "");
      const res = await netFetch(url);
      if (res.status === 429) trip("mymemory", 60 * 60 * 1000);
      const j = (await res.json()) as { responseData?: { translatedText?: string }; responseStatus?: number | string };
      const txt = j.responseData?.translatedText || "";
      if (String(j.responseStatus) === "429" || /MYMEMORY WARNING/i.test(txt)) trip("mymemory", 60 * 60 * 1000);
      parts.push(txt || piece);
      await sleep(150);
    }
    out.push(parts.join(" "));
  }
  return { out };
}

/* ------------------------------- LibreTranslate ------------------------------- */

/** LibreTranslate: свой сервер или публичный (нужен адрес; часть серверов требует ключ). Принимает пачку строк. */
async function libreMany(texts: string[], lang: string): Promise<Translated> {
  const { libreUrl, libreKey } = getSettings();
  if (!libreUrl) throw new Error("libre_not_configured");
  const base = assertHttpUrl(libreUrl).replace(/\/+$/, "");
  const out: (string | null)[] = new Array(texts.length).fill(null);
  const idx = texts.map((t, i) => i).filter((i) => texts[i].trim());
  for (let k = 0; k < idx.length; k += 20) {
    const part = idx.slice(k, k + 20);
    guard("libre");
    const res = await netFetch(`${base}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: part.map((i) => texts[i].slice(0, 4000)),
        source: "auto",
        target: lang === "zh" ? "zh" : lang,
        format: "text",
        ...(libreKey ? { api_key: libreKey } : {}),
      }),
    });
    if (res.status === 429) trip("libre", 5 * 60 * 1000);
    if (!res.ok) throw new Error(`libre_http_${res.status}`);
    const j = (await res.json()) as { translatedText?: string | string[]; detectedLanguage?: { language?: string }[] | { language?: string } };
    const tr = Array.isArray(j.translatedText) ? j.translatedText : [j.translatedText || ""];
    const det = Array.isArray(j.detectedLanguage) ? j.detectedLanguage : [j.detectedLanguage || {}];
    part.forEach((i, n) => {
      out[i] = det[n]?.language === lang ? null : tr[n] || null;
    });
  }
  return { out };
}

/* ------------------------------- Lingva ------------------------------- */

/** Lingva Translate: открытый фронт к Google (адрес сервера — в настройках). */
async function lingvaMany(texts: string[], lang: string): Promise<Translated> {
  const base = assertHttpUrl(getSettings().lingvaUrl || "https://lingva.ml").replace(/\/+$/, "");
  const out: (string | null)[] = [];
  for (const text of texts) {
    if (!text.trim()) {
      out.push(null);
      continue;
    }
    const parts: string[] = [];
    let same = false;
    for (const piece of splitForLimit(text, 1200)) {
      guard("lingva");
      const res = await netFetch(`${base}/api/v1/auto/${lang}/${encodeURIComponent(piece)}`);
      if (res.status === 429 || res.status === 403) trip("lingva");
      if (!res.ok) throw new Error(`lingva_http_${res.status}`);
      const j = (await res.json()) as { translation?: string; info?: { detectedSource?: string } };
      if ((j.info?.detectedSource || "").split("-")[0] === lang) {
        same = true;
        break;
      }
      // Сервер вернул тот же текст — значит, Google отказал ему самому.
      if (!j.translation || j.translation === piece) throw new Error("lingva_failed");
      parts.push(j.translation);
      await sleep(200);
    }
    out.push(same ? null : parts.join(" "));
  }
  return { out };
}

/* ------------------------------- локальная модель ------------------------------- */

/** Выгружает локальную модель перевода из памяти: ONNX-сессию и сервер llama.cpp. */
export function unloadLocal(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./translate/engine") as typeof import("./translate/engine")).unload();
  } catch {
    /* ONNX-движок не загружался */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./llamacpp/engine") as typeof import("./llamacpp/engine")).stopServer();
  } catch {
    /* сервер не запущен */
  }
}

let unloadTimer: NodeJS.Timeout | null = null;
/** Если включено «выгружать после перевода» — выгружаем, когда переводы закончились (пауза 20 с между пачками). */
function scheduleUnload(): void {
  if (!getSettings().unloadAfter) return;
  if (unloadTimer) clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    unloadTimer = null;
    unloadLocal();
  }, 20 * 1000);
  unloadTimer.unref();
}

/**
 * Локальная модель TranslateGemma. Сначала llama.cpp (GGUF, видеокарта, лёгкая нагрузка на CPU) —
 * если GGUF-модель установлена; иначе ONNX-движок со страницы «Перевод». Возвращает ток/с.
 */
async function localMany(texts: string[], lang: string): Promise<Translated> {
  if (unloadTimer) {
    clearTimeout(unloadTimer);
    unloadTimer = null;
  }
  try {
    return await localManyRun(texts, lang);
  } finally {
    scheduleUnload();
  }
}

async function localManyRun(texts: string[], lang: string): Promise<Translated> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectLanguage } = require("./translate/languages") as typeof import("./translate/languages");
  const todo = texts.map((t) => ({ t, src: detectLanguage(t) }));
  if (todo.every((x) => x.src === lang || !x.t.trim())) return { out: texts.map(() => null) };
  let tokens = 0;
  let genMs = 0;
  const out: (string | null)[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const llama = require("./translate/llama") as typeof import("./translate/llama");
  let useLlama = true;
  try {
    llama.pickModel("auto");
  } catch {
    useLlama = false;
  }
  if (useLlama) {
    try {
      await llama.ensureLlama("auto");
    } catch (e) {
      logger.warn("rss.local_llama_unavailable", { error: (e as Error).message });
      useLlama = false;
    }
  }
  if (useLlama) {
    for (const x of todo) {
      if (x.src === lang || !x.t.trim()) {
        out.push(null);
        continue;
      }
      const r = await llama.translateLlama("auto", x.t.slice(0, 1400), x.src, lang, {});
      tokens += r.tokens;
      genMs += r.genMs;
      out.push(r.text || null);
    }
    return { out, tps: genMs > 0 ? (tokens / genMs) * 1000 : undefined };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const model = require("./translate/model") as typeof import("./translate/model");
  if (!model.installedVariants().length) throw new Error("local_model_missing");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const eng = require("./translate/engine") as typeof import("./translate/engine");
  const l = await eng.ensureLoaded("auto", "auto");
  for (const x of todo) {
    if (x.src === lang || !x.t.trim()) {
      out.push(null);
      continue;
    }
    const r = await eng.translateChunk(l, x.t.slice(0, 1400), x.src, lang, {});
    tokens += r.tokens;
    genMs += r.genMs;
    out.push(r.text || null);
  }
  return { out, tps: genMs > 0 ? (tokens / genMs) * 1000 : undefined };
}

/** Перевод набора строк выбранным (не «ai») движком. */
async function translateStrings(texts: string[], lang: string, engine: TranslateEngine): Promise<Translated> {
  switch (engine) {
    case "local":
      return localMany(texts, lang);
    case "mymemory":
      return myMemoryMany(texts, lang);
    case "libre":
      return libreMany(texts, lang);
    case "lingva":
      return lingvaMany(texts, lang);
    default:
      return googleMany(texts, lang);
  }
}

export interface ItemTranslation {
  id: string;
  /** 0 — переводить не нужно (уже на языке пользователя). */
  tr: { title: string; summary: string } | 0;
}

/** Переводит заголовки и описания статей на язык пользователя; результат хранится в самой статье. */
export async function translateItems(
  ids: string[],
  lang: string,
  engine: TranslateEngine = "ai",
): Promise<{ items: ItemTranslation[]; tps?: number }> {
  const target = TARGET_SCRIPT[lang];
  if (!target) throw new Error("unsupported_language");
  const db = read();
  const out: ItemTranslation[] = [];
  const need: Item[] = [];
  for (const id of ids.slice(0, 40)) {
    const it = db.items.find((i) => i.id === id);
    if (!it) continue;
    const have = it.tr?.[lang];
    if (have !== undefined) {
      out.push({ id, tr: have });
      continue;
    }
    const sc = scriptOf(`${it.title} ${it.summary}`);
    if (sc === "" || (sc === target && sc !== "lat")) {
      it.tr = { ...(it.tr || {}), [lang]: 0 };
      out.push({ id, tr: 0 });
    } else need.push(it);
  }
  if (engine !== "ai") {
    // Все заголовки и описания — одним пакетом: для Google это 1–2 запроса вместо десятков.
    const { out: res, tps } = await translateStrings(need.flatMap((it) => [it.title, it.summary]), lang, engine);
    need.forEach((it, n) => {
      const title = res[n * 2];
      const summary = res[n * 2 + 1];
      const tr: ItemTranslation["tr"] =
        title === null && summary === null ? 0 : { title: title ?? it.title, summary: summary ?? it.summary };
      it.tr = { ...(it.tr || {}), [lang]: tr };
      out.push({ id: it.id, tr });
    });
    write(db);
    return { items: out, tps };
  }
  for (let i = 0; i < need.length; i += 10) {
    const chunk = need.slice(i, i + 10);
    const payload = chunk.map((it, n) => ({ i: n, title: it.title, summary: it.summary.slice(0, 400) }));
    const prompt =
      `Target language: ${LANG_NAMES[lang]}.\n` +
      `For each item: if its title and summary are already written in the target language, reply {"i":N,"same":true}. ` +
      `Otherwise translate both into the target language and reply {"i":N,"title":"...","summary":"..."}. ` +
      `Keep names, brands and numbers. Reply with a JSON array, one object per item.\n` +
      JSON.stringify(payload);
    const arr = (await askJson(prompt, 3500)) as { i?: number; same?: boolean; title?: string; summary?: string }[];
    chunk.forEach((it, n) => {
      const r = arr.find((x) => x && x.i === n);
      let tr: ItemTranslation["tr"];
      if (r && r.same) tr = 0;
      else if (r && typeof r.title === "string" && r.title.trim()) {
        tr = { title: r.title.trim(), summary: String(r.summary ?? "").trim() };
      } else return; // модель пропустила элемент — попробуем позже
      it.tr = { ...(it.tr || {}), [lang]: tr };
      out.push({ id: it.id, tr });
    });
  }
  write(db);
  return { items: out };
}

const articleTrCache = new Map<string, ArticleBlock[] | 0>();

/** Перевод текста статьи (блоки), кэшируется в памяти. 0 — перевод не нужен. */
export async function translateArticle(
  id: string,
  lang: string,
  engine: TranslateEngine = "ai",
): Promise<{ blocks: ArticleBlock[] | 0; tps?: number; cached?: boolean }> {
  const target = TARGET_SCRIPT[lang];
  if (!target) throw new Error("unsupported_language");
  const key = `${id}:${lang}`;
  // Перевод хранится в БД рядом с оригиналом: повторно в движок (и Google) не ходим.
  const hit = articleTrCache.get(key) ?? docGet<ArticleBlock[] | 0>("rss_article_tr", key);
  if (hit !== undefined) {
    articleTrCache.set(key, hit);
    return { blocks: hit, cached: true };
  }
  const art = await fetchArticle(id);
  const sample = art.blocks.slice(0, 5).map((b) => b.text).join(" ");
  const sc = scriptOf(sample);
  let result: ArticleBlock[] | 0;
  let tps: number | undefined;
  if (sc === "" || (sc === target && sc !== "lat")) {
    result = 0;
  } else if (engine !== "ai") {
    const r = await translateStrings(art.blocks.map((b) => b.text), lang, engine);
    tps = r.tps;
    result = r.out.every((x) => x === null) ? 0 : art.blocks.map((b, n) => ({ kind: b.kind, text: r.out[n] ?? b.text }));
  } else {
    const out: ArticleBlock[] = [];
    let i = 0;
    while (i < art.blocks.length) {
      let j = i;
      let chars = 0;
      while (j < art.blocks.length && (j === i || chars + art.blocks[j].text.length < 5000)) chars += art.blocks[j++].text.length;
      const part = art.blocks.slice(i, j);
      const prompt =
        `Translate every string of this JSON array into ${LANG_NAMES[lang]}. If a string is already in that language keep it. ` +
        `Keep the same number of items in the same order. Reply with a JSON array of strings only.\n` +
        JSON.stringify(part.map((b) => b.text));
      const arr = (await askJson(prompt, 6000)) as unknown[];
      part.forEach((b, n) => out.push({ kind: b.kind, text: typeof arr[n] === "string" && arr[n] ? (arr[n] as string) : b.text }));
      i = j;
    }
    result = out;
  }
  if (!art.partial) docSet("rss_article_tr", key, result);
  if (articleTrCache.size > 30) articleTrCache.clear();
  articleTrCache.set(key, result);
  return { blocks: result, tps };
}

/* ------------------------------- операции ---------------------------------- */

export function listFeeds(): FeedWithCounts[] {
  const db = read();
  return db.feeds
    .map((f) => {
      const mine = db.items.filter((i) => i.feedId === f.id);
      return { ...f, unread: mine.filter((i) => !i.read).length, total: mine.length };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function load(feed: Feed, fetcher: Fetcher): Promise<{ feed: Feed; parsed?: ParsedFeed }> {
  const r = await fetcher(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
  if (r.status === 304) return { feed: { ...feed, lastFetched: Date.now(), error: undefined } };
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const parsed = parseFeed(r.text);
  return {
    parsed,
    feed: {
      ...feed,
      title: feed.title || parsed.title || feed.url,
      site: parsed.site || feed.site,
      etag: r.etag,
      lastModified: r.lastModified,
      lastFetched: Date.now(),
      error: undefined,
    },
  };
}

export async function addFeed(url: unknown, fetcher: Fetcher = defaultFetcher): Promise<Feed> {
  const clean = assertHttpUrl(url);
  const db = read();
  const dup = db.feeds.find((f) => f.url === clean);
  if (dup) return dup;
  const draft: Feed = { id: crypto.randomUUID(), url: clean, title: "", addedAt: Date.now() };
  const { feed, parsed } = await load(draft, fetcher);
  db.feeds.push(feed);
  db.items = mergeItems(db.items, feed.id, parsed?.items ?? [], new Date().toISOString()).items;
  write(db);
  logger.info("rss.add", { id: feed.id, items: parsed?.items.length ?? 0 });
  return feed;
}

export function removeFeed(id: string): boolean {
  const db = read();
  const n = db.feeds.length;
  db.feeds = db.feeds.filter((f) => f.id !== id);
  if (db.feeds.length === n) return false;
  db.items = db.items.filter((i) => i.feedId !== id);
  write(db);
  return true;
}

/** Обновляет ленты (все или одну) с ограничением параллелизма; ошибка одной не роняет остальные. */
export async function refresh(
  feedId?: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ added: number; failed: number }> {
  const db = read();
  const targets = db.feeds.filter((f) => !feedId || f.id === feedId);
  let added = 0;
  let failed = 0;
  const queue = [...targets];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        const { feed, parsed } = await load(f, fetcher);
        const idx = db.feeds.findIndex((x) => x.id === f.id);
        if (idx >= 0) db.feeds[idx] = feed;
        if (parsed) {
          const m = mergeItems(db.items, f.id, parsed.items, new Date().toISOString());
          db.items = m.items;
          added += m.added;
        }
      } catch (e) {
        failed++;
        const idx = db.feeds.findIndex((x) => x.id === f.id);
        if (idx >= 0) db.feeds[idx] = { ...db.feeds[idx], error: (e as Error).message, lastFetched: Date.now() };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  write(db);
  logger.info("rss.refresh", { feeds: targets.length, added, failed });
  return { added, failed };
}

export interface ItemQuery {
  feedId?: string;
  unread?: boolean;
  saved?: boolean;
  q?: string;
  limit?: number;
}

export function listItems(query: ItemQuery = {}): ItemWithFeed[] {
  const db = read();
  const titles = new Map(db.feeds.map((f) => [f.id, f.title]));
  const q = (query.q || "").trim().toLowerCase();
  return db.items
    .filter(
      (i) =>
        (!query.feedId || i.feedId === query.feedId) &&
        (!query.unread || !i.read) &&
        (!query.saved || i.saved) &&
        (!q || `${i.title} ${i.summary}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, Math.max(1, Math.min(500, query.limit ?? 100)))
    .map((i) => ({ ...i, feedTitle: titles.get(i.feedId) || "" }));
}

/* ------------------------- поиск по статьям (по смыслу) ------------------------- */

/**
 * Поиск по статьям: по смыслу через EmbeddingGemma (общий индекс приложения), а если модель
 * недоступна или индекс ещё не построен — обычный поиск по подстроке.
 */
export async function searchItems(
  query: string,
  f: Omit<ItemQuery, "q"> = {},
): Promise<{ mode: "semantic" | "text"; items: ItemWithFeed[] }> {
  const q = query.trim();
  const text = (): { mode: "text"; items: ItemWithFeed[] } => ({
    mode: "text",
    items: listItems({ ...f, q }),
  });
  if (!q) return { mode: "text", items: listItems(f) };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sem = require("./semantic") as typeof import("./semantic");
    const st = sem.status();
    if (!st.enabled || !st.model) return text();
    const hits = await sem.search(q, { sources: ["rss"], limit: 120 });
    if (!hits.length) {
      // Индекса статей ещё нет (или совсем ничего похожего) — строим в фоне и пока отвечаем текстом.
      if (!st.indexed.rss) sem.syncAll();
      return text();
    }
    const all = new Map(listItems({ ...f, limit: 500 }).map((i) => [i.id, i]));
    const items = hits.map((h) => all.get(h.ref)).filter((i): i is ItemWithFeed => !!i);
    return items.length ? { mode: "semantic", items } : text();
  } catch {
    return text();
  }
}

/** Новые статьи появились — подтягиваем их в индекс смысла (если индекс вообще используется). */
export function reindexSemantic(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sem = require("./semantic") as typeof import("./semantic");
    const st = sem.status();
    if (st.enabled && st.model) sem.syncAll();
  } catch {
    /* без индекса поиск останется текстовым */
  }
}

/** Очистка БД ридера: удаляет статьи (кроме сохранённых) вместе с сохранёнными текстами и переводами. */
export function clearStore(): { removed: number } {
  const db = read();
  const keep = db.items.filter((i) => i.saved);
  const gone = db.items.filter((i) => !i.saved).map((i) => i.id);
  db.items = keep;
  write(db);
  docStore.deleteWhere("rss_article", (uid) => gone.includes(uid));
  docStore.deleteWhere("rss_article_tr", (uid) => gone.includes(uid.split(":")[0]));
  articleCache.clear();
  articleTrCache.clear();
  reindexSemantic();
  return { removed: gone.length };
}

export function getItem(id: string): Item | undefined {
  return read().items.find((i) => i.id === id);
}

export function patchItem(id: string, patch: { read?: boolean; saved?: boolean }): Item | null {
  const db = read();
  const it = db.items.find((i) => i.id === id);
  if (!it) return null;
  if (typeof patch.read === "boolean") it.read = patch.read;
  if (typeof patch.saved === "boolean") it.saved = patch.saved;
  write(db);
  return it;
}

export function markAllRead(feedId?: string): number {
  const db = read();
  let n = 0;
  for (const i of db.items) {
    if (!i.read && (!feedId || i.feedId === feedId)) {
      i.read = true;
      n++;
    }
  }
  if (n) write(db);
  return n;
}

export async function importOpml(
  xml: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ added: number; skipped: number; failed: number }> {
  const entries = parseOpml(xml);
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    try {
      const before = read().feeds.length;
      const f = await addFeed(e.url, fetcher);
      if (e.title && !f.title) f.title = e.title;
      if (read().feeds.length > before) added++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  return { added, skipped, failed };
}

export const exportOpml = (): string => buildOpml(read().feeds);

/* ----------------------------- ИИ-сводка новостей --------------------------- */

/** Промпт сводки: заголовки и краткие описания, сгруппированные по лентам. */
export function buildDigestPrompt(
  items: { title: string; summary: string; feedTitle: string; published: string }[],
  language: string,
): string {
  const lines = items
    .slice(0, 40)
    .map((i, n) => `${n + 1}. [${i.feedTitle}] ${i.title} — ${i.summary.slice(0, 280)}`);
  return [
    `Ответь на языке: ${language}.`,
    "Ниже — свежие новости из RSS-лент пользователя. Сделай сводку: 1) 3–6 главных тем " +
      "(каждая — одно-два предложения; объединяй похожие новости из разных источников и " +
      "указывай номера статей в скобках), 2) отдельным коротким списком — что можно " +
      "пропустить. Не выдумывай ничего сверх данного текста.",
    "НОВОСТИ:",
    ...lines,
  ].join("\n");
}

export async function digest(
  scope: "unread" | "saved" | "all",
  language: string,
  feedId?: string,
): Promise<DigestResult> {
  const items = listItems({ feedId, unread: scope === "unread", saved: scope === "saved", limit: 40 });
  if (!items.length) throw new Error("no_items");
   
  const { askAi } = require("./notesAi") as typeof import("./notesAi");
  const r = await askAi(
    buildDigestPrompt(items, language),
    "Ты редактор новостной сводки. Пиши кратко, по делу, в Markdown, без вступлений.",
    "rss",
    1500,
  );
  if (!r.text) throw new Error("empty_answer");
  const out: DigestResult = { markdown: r.text, count: items.length, provider: r.provider, model: r.model };
  saveDigest(out, scope);
  return out;
}

/* --------------------- последняя ИИ-сводка (хранится в БД) --------------------- */

export interface SavedDigest extends DigestResult {
  createdAt: string;
  scope: string;
}

export function getLastDigest(): SavedDigest | null {
  const d = docStore.all("rss_digest")[0];
  if (!d) return null;
  try {
    return JSON.parse(d.json) as SavedDigest;
  } catch {
    return null;
  }
}

/** Сводка живёт до следующей: новая заменяет прежнюю. */
function saveDigest(d: DigestResult, scope: string): void {
  const rec: SavedDigest = { ...d, scope, createdAt: new Date().toISOString() };
  docStore.sync("rss_digest", new Map([["last", JSON.stringify(rec)]]));
}

/** «Отложить на чтение»: сохраняет статью в закладки (с текстом в Vault). */
export async function saveForLater(id: string): Promise<{ bookmarkId: string; note: string | null }> {
  const it = getItem(id);
  if (!it || !it.link) throw new Error("not_found");
   
  const bm = require("./bookmarks") as typeof import("./bookmarks");
  const b = await bm.create({ title: it.title, url: it.link, tags: ["rss"], saveForLater: true });
  patchItem(id, { saved: true, read: true });
  return { bookmarkId: b.id, note: b.articleNotePath };
}
