/**
 * Интернет для помощника в «Документах» и «Таблицах»: поиск и чтение страниц.
 *
 * По умолчанию поиск идёт без ключей и настроек: DuckDuckGo (страница HTML) → Brave Search (страница
 * HTML) → Wikipedia. Bing не годится: ботам он подсовывает подменённую выдачу. Свой SearXNG и ключ
 * Brave API остаются необязательными и, если заданы, проверяются первыми. Чтение страницы по ссылке
 * работает всегда.
 */
import dns from "dns/promises";
import fs from "fs";
import net from "net";
import path from "path";
import config from "../config";
import { getSecret, setSecret } from "../security";
import { privateIp } from "../llamacpp/ocr";
import { browserSearch } from "./browserSearch";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/1.0";
/** Поисковые страницы без ключа отвечают только на «браузерный» User-Agent. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FILE = path.join(config.DIRS.storage, "llama", "assistant.json");

export interface WebSettings {
  /** Адрес SearXNG (например https://searx.example.org), у которого включён формат JSON. */
  searxng: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function webSettings(): WebSettings & { hasBrave: boolean } {
  let v: Partial<WebSettings> = {};
  try {
    v = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<WebSettings>;
  } catch {
    /* первый запуск */
  }
  return {
    searxng: typeof v.searxng === "string" ? v.searxng : "",
    hasBrave: !!getSecret("brave"),
  };
}

export function setWebSettings(p: {
  searxng?: string;
  braveKey?: string;
}): ReturnType<typeof webSettings> {
  const cur = webSettings();
  let searxng = typeof p.searxng === "string" ? p.searxng.trim().replace(/\/+$/, "") : cur.searxng;
  if (searxng && !/^https?:\/\//i.test(searxng)) searxng = `https://${searxng}`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ searxng }), "utf8");
  if (typeof p.braveKey === "string" && p.braveKey.trim()) setSecret("brave", p.braveKey.trim());
  return webSettings();
}

/** Тег целиком: значения атрибутов в кавычках могут содержать «>» (JSON в data-props). */
const TAG = /<\/?[a-zA-Z][^\s>/]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/g;

const INLINE =
  /<\/?(?:b|i|u|s|em|strong|a|span|code|small|sup|sub|mark|abbr|font|cite|q)(?=[\s>/])(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/gi;

const decode = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(TAG, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`search_http_${r.status}`);
  return (await r.json()) as T;
}

async function searxng(base: string, q: string, lang: string, n: number): Promise<SearchHit[]> {
  const j = await getJson<{ results?: { title?: string; url?: string; content?: string }[] }>(
    `${base}/search?${new URLSearchParams({ q, format: "json", language: lang || "auto" })}`,
  );
  return (j.results ?? [])
    .filter((x) => x.url)
    .slice(0, n)
    .map((x) => ({
      title: decode(x.title ?? ""),
      url: String(x.url),
      snippet: decode(x.content ?? ""),
    }));
}

async function brave(key: string, q: string, lang: string, n: number): Promise<SearchHit[]> {
  const j = await getJson<{
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  }>(
    `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: String(n), search_lang: lang || "en" })}`,
    {
      "X-Subscription-Token": key,
    },
  );
  return (j.web?.results ?? [])
    .filter((x) => x.url)
    .map((x) => ({
      title: decode(x.title ?? ""),
      url: String(x.url),
      snippet: decode(x.description ?? ""),
    }));
}

/** Ссылка DuckDuckGo-редиректа → настоящий адрес. */
const ddgUrl = (href: string): string => {
  const h = href.replace(/&amp;/g, "&");
  const m = /[?&]uddg=([^&]+)/.exec(h);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }
  return h.startsWith("//") ? `https:${h}` : h;
};

async function getHtml(url: string, init: RequestInit = {}, lang = "en"): Promise<string> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": `${lang || "en"},en;q=0.7`,
      ...((init.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`search_http_${r.status}`);
  return r.text();
}

/** Разбор страницы DuckDuckGo HTML. Страница «anomaly» (капча) — это ошибка, а не пустая выдача. */
export function parseDuckduckgo(html: string, n: number): SearchHit[] {
  if (/anomaly|captcha/i.test(html) && !/result__a/.test(html)) throw new Error("search_blocked");
  const hits: SearchHit[] = [];
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
  for (let m = re.exec(html); m && hits.length < n; m = re.exec(html)) {
    const url = ddgUrl(m[1]);
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    hits.push({ title: decode(m[2]), url, snippet: decode(sn?.[1] ?? "") });
  }
  return hits;
}

async function duckduckgo(q: string, lang: string, n: number): Promise<SearchHit[]> {
  const kl = lang === "ru" ? "ru-ru" : lang === "en" ? "wt-wt" : `${lang}-${lang}`;
  const html = await getHtml(
    "https://html.duckduckgo.com/html/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q, kl }).toString(),
    },
    lang,
  );
  return parseDuckduckgo(html, n);
}

/** Разбор страницы Brave Search (HTML). */
export function parseBrave(html: string, n: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re =
    /<div[^>]*class="snippet[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="snippet[^"]*"|<\/main>|$)/g;
  for (let m = re.exec(html); m && hits.length < n; m = re.exec(html)) {
    const a = /<a[^>]*href="(https?:\/\/(?!search\.brave\.com)[^"]+)"/.exec(m[1]);
    if (!a) continue;
    const title = /class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(m[1]);
    const desc = /class="generic-snippet[^"]*"[^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/.exec(m[1]);
    hits.push({
      title: decode(title?.[1] ?? a[1]),
      url: a[1].replace(/&amp;/g, "&"),
      snippet: decode(desc?.[1] ?? ""),
    });
  }
  return hits;
}

async function braveHtml(q: string, lang: string, n: number): Promise<SearchHit[]> {
  const html = await getHtml(
    `https://search.brave.com/search?${new URLSearchParams({ q, source: "web" })}`,
    {},
    lang,
  );
  return parseBrave(html, n);
}

async function wikipedia(q: string, lang: string, n: number): Promise<SearchHit[]> {
  const one = async (l: string): Promise<SearchHit[]> => {
    const j = await getJson<{ query?: { search?: { title: string; snippet: string }[] } }>(
      `https://${l}.wikipedia.org/w/api.php?${new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: q,
        format: "json",
        srlimit: String(n),
        utf8: "1",
      })}`,
    );
    return (j.query?.search ?? []).map((x) => ({
      title: x.title,
      url: `https://${l}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`,
      snippet: decode(x.snippet),
    }));
  };
  const own = /^[a-z]{2,3}$/.test(lang) ? lang : "en";
  const hits = await one(own).catch(() => []);
  if (hits.length >= n || own === "en") return hits;
  return [...hits, ...(await one("en").catch(() => []))].slice(0, n);
}

/** Свежие ответы хранятся недолго: агент часто повторяет один и тот же запрос, а поисковики режут частые обращения. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; v: { provider: string; hits: SearchHit[] } }>();
/** Между обращениями к поисковым страницам держим паузу: иначе DuckDuckGo и Brave отвечают «слишком часто». */
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
const spaced = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(async () => {
    const wait = lastCall + 1200 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
};

/** Поиск в интернете: первый настроенный источник, который ответил. */
export async function webSearch(
  q: string,
  lang = "en",
  limit = 6,
): Promise<{ provider: string; hits: SearchHit[] }> {
  const key0 = `${lang}|${limit}|${q.toLowerCase()}`;
  const hit = cache.get(key0);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const found = await searchUncached(q, lang, limit);
  if (found.hits.length) {
    if (cache.size > 100) cache.clear();
    cache.set(key0, { at: Date.now(), v: found });
  }
  return found;
}

async function searchUncached(
  q: string,
  lang: string,
  limit: number,
): Promise<{ provider: string; hits: SearchHit[] }> {
  const s = webSettings();
  const errors: string[] = [];
  const tries: [string, () => Promise<SearchHit[]>][] = [];
  if (s.searxng) tries.push(["searxng", () => searxng(s.searxng, q, lang, limit)]);
  const key = getSecret("brave");
  if (key) tries.push(["brave", () => brave(key, q, lang, limit)]);
  tries.push([
    "browser-duckduckgo",
    () => spaced(() => browserSearch("duckduckgo", q, lang, limit)),
  ]);
  tries.push(["browser-brave", () => spaced(() => browserSearch("brave", q, lang, limit))]);
  tries.push(["browser-bing", () => spaced(() => browserSearch("bing", q, lang, limit))]);
  tries.push(["duckduckgo", () => spaced(() => duckduckgo(q, lang, limit))]);
  tries.push(["brave-web", () => spaced(() => braveHtml(q, lang, limit))]);
  tries.push(["wikipedia", () => wikipedia(q, lang, limit)]);
  for (const [provider, fn] of tries) {
    try {
      const hits = await fn();
      if (hits.length) return { provider, hits };
    } catch (e) {
      errors.push(`${provider}: ${(e as Error).message}`);
    }
  }
  return { provider: tries[tries.length - 1][0], hits: [] };
}

/** HTML → читаемый текст: без скриптов, меню и разметки. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|nav|footer|header|head|form|iframe|template)[\s\S]*?<\/\1>/gi,
      " ",
    );
  const main = /<(main|article)[\s\S]*?<\/\1>/i.exec(h);
  if (main && main[0].length > 800) h = main[0];
  h = h
    // Строчные теги склеивают слова («<b>абзац</b>.» → «абзац.»), остальные — разделяют.
    .replace(INLINE, "")
    .replace(/<\/(p|div|tr|h[1-6]|section|blockquote|pre|table|ul|ol)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(TAG, " ");
  const text = h
    .split("\n")
    .map((l) => decode(l))
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

const MAX_BYTES = 3 * 1024 * 1024;

/** Прочитать страницу по ссылке (локальные адреса запрещены); текст режется по `offset`/`maxChars`. */
export async function webFetch(
  url: string,
  offset = 0,
  maxChars = 9000,
): Promise<{ url: string; title: string; text: string; total: number; next: number | null }> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad_url");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (!addrs.length || addrs.some(privateIp)) throw new Error("private_address");
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5",
      },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok) throw new Error(`remote_${res.status}`);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^(text\/|application\/(json|xml|xhtml))/.test(type) && type) throw new Error("not_text");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("empty");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(Buffer.from(value));
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const { title, text } =
      type === "text/html" || type === "application/xhtml+xml" || !type
        ? htmlToText(raw)
        : { title: "", text: raw };
    const from = Math.max(0, offset);
    const out = text.slice(from, from + maxChars);
    const next = from + maxChars < text.length ? from + maxChars : null;
    return { url: u.toString(), title, text: out, total: text.length, next };
  }
  throw new Error("too_many_redirects");
}
