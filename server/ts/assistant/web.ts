/**
 * Интернет для помощника в «Документах» и «Таблицах»: поиск и чтение страниц.
 *
 * Бесплатные поисковики без ключа (Bing, DuckDuckGo, Mojeek) отдают ботам капчу или подменённую
 * выдачу, поэтому поиск устроен так: SearXNG (свой адрес) → Brave Search (ключ) → Wikipedia
 * (всегда работает, без ключа). Чтение страницы по ссылке работает всегда.
 */
import dns from "dns/promises";
import fs from "fs";
import net from "net";
import path from "path";
import config from "../config";
import { getSecret, setSecret } from "../security";
import { privateIp } from "../llamacpp/ocr";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/1.0";
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
  return { searxng: typeof v.searxng === "string" ? v.searxng : "", hasBrave: !!getSecret("brave") };
}

export function setWebSettings(p: { searxng?: string; braveKey?: string }): ReturnType<typeof webSettings> {
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
    .map((x) => ({ title: decode(x.title ?? ""), url: String(x.url), snippet: decode(x.content ?? "") }));
}

async function brave(key: string, q: string, lang: string, n: number): Promise<SearchHit[]> {
  const j = await getJson<{
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  }>(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: String(n), search_lang: lang || "en" })}`, {
    "X-Subscription-Token": key,
  });
  return (j.web?.results ?? [])
    .filter((x) => x.url)
    .map((x) => ({ title: decode(x.title ?? ""), url: String(x.url), snippet: decode(x.description ?? "") }));
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

/** Поиск в интернете: первый настроенный источник, который ответил. */
export async function webSearch(
  q: string,
  lang = "en",
  limit = 6,
): Promise<{ provider: string; hits: SearchHit[] }> {
  const s = webSettings();
  const errors: string[] = [];
  const tries: [string, () => Promise<SearchHit[]>][] = [];
  if (s.searxng) tries.push(["searxng", () => searxng(s.searxng, q, lang, limit)]);
  const key = getSecret("brave");
  if (key) tries.push(["brave", () => brave(key, q, lang, limit)]);
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
    .replace(/<(script|style|noscript|svg|nav|footer|header|head|form|iframe|template)[\s\S]*?<\/\1>/gi, " ");
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
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5" },
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
