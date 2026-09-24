/**
 * Web Archive Engine: краулер + упаковщик офлайн-копий сайтов в .sitebak.
 *
 * Как это работает (5 стадий):
 *  1. Рендер: если установлен playwright — headless Chromium с автоскроллом
 *     до ленивых картинок и ожиданием networkidle; иначе fetch-краулер
 *     (статический HTML, rendered:false в статистике).
 *  2. Сбор ссылок: href/src из HTML, фильтр по домену/поддомену/пути/глубине,
 *     очередь с дедупликацией (Set посещённых), лимит maxPages.
 *  3. Оптимизация: stripScripts, blockAds, конвертация изображений в
 *     WebP/AVIF через FFmpeg (заодно стирает EXIF).
 *  4. Упаковка .sitebak: манифест (карта путей, sha256, параметры) + записи.
 *     Текст сжимается ZSTD (если доступна нативная библиотека) или Brotli
 *     (встроен в Node); медиа хранятся как есть (двойное сжатие бессмысленно).
 *
 * Формат .sitebak (бинарный, little-endian):
 *   MAGIC "SITEBAK1" | u32 manifestLen | manifest(JSON) |
 *   записи: u8 flags(bit0=text) | u32 pathLen | path(utf8) |
 *           10 ASCII-символов исходной длины | u32 compLen | data
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { execFile } from "child_process";
import settings from "./settings";
import logger from "./logger";
import config from "./config";
import { detectFfmpeg } from "./convertEngine";
import { trimJobs } from "./jobStore";
import { removeOlderThan } from "./fsUtil";

const { DIRS } = config;

const MAGIC = "SITEBAK1";
const AD_HOSTS =
  /doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adnxs|taboola|outbrain|criteo|facebook\.net|hotjar|mixpanel|segment\.io|scorecardresearch/i;

/** Секция sitebak.* в settings.json (DEFAULTS в server/ts/settings.ts). */
interface SitebakConfig {
  maxConcurrent?: number;
  crawlDelayMs?: number;
  userAgent?: string; // пусто = стандартный UA Chromium
  zstdDictKb?: number;
  mediaFormat?: string; // original | lossless | webp | avif
  stripExif?: boolean;
  stripScripts?: boolean;
  blockAds?: boolean;
  maxPages?: number;
}

/** Параметры запуска краула (тело POST /api/archive): необязательны все, кроме url. */
interface CrawlInput {
  url: string;
  depth?: number | "full";
  domainScope?: string;
  maxPages?: number | string;
  imageMode?: string;
  videoMode?: string;
  videoCrf?: number | string;
  stripScripts?: boolean;
  inlineAssets?: boolean;
  blockAds?: boolean;
  stripExif?: boolean;
  delayMs?: number | string;
  concurrency?: number | string;
  cookies?: string;
  userAgent?: string;
}

/** Нормализованные параметры задания (job.opts). */
interface CrawlOptions {
  depth: number | "full";
  domainScope: string;
  maxPages: number;
  imageMode: string;
  videoMode: string;
  videoCrf: number;
  stripScripts: boolean;
  inlineAssets: boolean;
  blockAds: boolean;
  stripExif: boolean;
  delayMs: number;
  concurrency: number;
  cookies: string;
  userAgent: string;
}

/** Задание краула: то, что роут отдаёт в UI (stats — сводка по архиву). */
interface SitebakJob {
  id: string;
  url: string;
  name: string;
  stage: string;
  progress: number;
  pages: number;
  origSize: number;
  bakSize: number;
  error: string;
  done: boolean;
  file: string;
  stats: Record<string, unknown>;
  createdAt: number;
  opts: CrawlOptions;
  /** Пользователь запросил остановку — цикл обхода страниц проверяет между пачками. */
  cancelled?: boolean;
}

/** Запись внутри архива: buf — содержимое (сжатое или как есть), text — «сжимать». */
interface ArchiveFile {
  buf: Buffer;
  text: boolean;
}

/** Файл манифеста .sitebak: путь, sha256 и исходный размер. */
interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  text: boolean;
}

/** Манифест .sitebak (заголовок архива сразу после magic). */
interface SitebakManifest {
  version: number;
  site: string;
  name: string;
  createdAt: string;
  opts: Omit<CrawlOptions, "cookies">;
  files?: ManifestFile[];
  compression?: { textAlgo: string; ratio: number };
}

/** Строка списка архивов (storage/sitebak/archives.json). */
interface ArchiveListItem {
  id: string;
  name: string;
  site: string;
  createdAt: number;
  stats: Record<string, unknown>;
}

/** Необязательная нативная ZSTD-библиотека: набор методов у пакетов различается. */
interface ZstdLib {
  compressSync?: (buf: Buffer, level?: number) => Buffer;
  decompressSync?: (buf: Buffer) => Buffer;
}

/** Минимум из API Playwright, который нужен краулеру (пакет тянется лениво). */
interface PwRoute {
  abort(): unknown;
}
interface PwPage {
  route(re: RegExp, handler: (r: PwRoute) => unknown): Promise<unknown>;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  evaluate(fn: () => Promise<void>): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
}
interface PwBrowser {
  newContext(opts: {
    userAgent?: string;
    extraHTTPHeaders?: Record<string, string>;
  }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(opts: { headless: boolean }): Promise<PwBrowser> };
}

const jobs = new Map<string, SitebakJob>(); // id -> job
const JOB_LIMIT = 20;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// С6: чистим распакованные копии старше 7 дней (сами .sitebak не трогаем —
// это пользовательские данные). Ограничение Map заданий — trimJobs (jobStore).
removeOlderThan({ dir: DIRS.sitebakExtracted, ttlMs: TTL_MS });

// Опциональная нативная ZSTD-библиотека; если не установлена — Brotli из Node.
let zstdLib: ZstdLib | null = null;
for (const name of ["@napi-rs/zstd", "zstd-napi", "simple-zstd"]) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    zstdLib = require(name) as ZstdLib;
    break;
  } catch {
    /* не установлена */
  }
}

function compressText(buf: Buffer, hintKb?: unknown): { data: Buffer; algo: string } {
  if (zstdLib?.compressSync) {
    try {
      return { data: zstdLib.compressSync(buf, 19), algo: "zstd" };
    } catch {
      /* fallback */
    }
  }
  // Brotli: SIZE_HINT из настройки zstdDictKb — фактически окно словаря:
  // больше словарь/окно → лучше сжатие больших однотипных сайтов.
  const hint = Math.max(1024, Math.min(16 * 1024 * 1024, (Number(hintKb) || 1024) * 1024));
  return {
    data: zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: hint,
      },
    }),
    algo: "brotli",
  };
}

function decompressText(buf: Buffer, algo: string): Buffer {
  if (algo === "zstd" && zstdLib?.decompressSync) return zstdLib.decompressSync(buf);
  return zlib.brotliDecompressSync(buf);
}

// Приведение URL: без хеша и трекинг-параметров.
function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"])
      url.searchParams.delete(p);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * SSRF-защита: краулер ходит по ссылкам СО СТРАНИЦЫ (не только по URL,
 * который ввёл пользователь) — злонамеренная/скомпрометированная страница
 * может подсунуть ссылку на localhost/внутреннюю сеть, и приложение (сервер
 * слушает только 127.0.0.1, но сам он и есть "внутренняя сеть" для своих
 * же API, плюс роутер/NAS/принтер и другие устройства в LAN пользователя)
 * сходит туда от имени пользователя. Проверка по буквальному хосту/IP —
 * НЕ защищает от DNS rebinding (домен, который резолвится в приватный IP
 * только ПОСЛЕ первой проверки), это осознанный компромисс: полная защита
 * требует кастомного DNS-резолвера на каждый fetch, что явно избыточно для
 * desktop-приложения одного пользователя.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1", "metadata.google.internal"]);
export function isBlockedHost(hostname: string): boolean {
  // Тесты поднимают одноразовые фикстуры на 127.0.0.1 и специально
  // архивируют их — это не реальный SSRF, а проверка самого краулера.
  // Оверрайд только по явной переменной окружения, по умолчанию блокировка
  // работает как обычно (тот же паттерн, что MOONAPP_BUNDLED_KEYS в tmdb.ts).
  if (process.env.MOONAPP_ALLOW_LOCAL_CRAWL === "1") return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  // IPv4 loopback/private/link-local (включая 169.254.169.254 — облачные метаданные).
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  // IPv6 loopback/private/link-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

// Подходит ли ссылка под правила обхода (домен/поддомен/путь) и не ведёт ли
// она во внутреннюю сеть (см. isBlockedHost выше).
function inScope(candidate: string, base: string, opts: { domainScope?: string }): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(base);
    const sameHost = a.hostname === b.hostname;
    const isSub = a.hostname.endsWith("." + b.hostname.replace(/^www\./, ""));
    const scope = opts.domainScope || "domain"; // path | subdomain | domain
    if (
      scope === "path" &&
      !(sameHost && a.pathname.startsWith(b.pathname.replace(/\/[^/]*$/, "/")))
    )
      return false;
    if (scope !== "path" && !(sameHost || isSub)) return false;
    if (!/^https?:$/.test(a.protocol)) return false;
    if (isBlockedHost(a.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// fetch-краулер: HTML с лимитом размера и таймаутом.
async function fetchPage(
  url: string,
  ua?: string,
  cookies?: string,
): Promise<{ buf: Buffer; contentType: string }> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent":
        ua ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Accept: "text/html,*/*",
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error("too_large");
  return { buf, contentType: ct };
}

// Извлечение ссылок из HTML (регэкспы — DOM-движок не нужен).
// links — страницы для обхода (HTML), assets — ресурсы для скачивания
// (css/js/img/font/media) — нужны офлайн-превью (С2).
const ASSET_EXT =
  /\.(css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|eot|mp4|webm|mp3|ogg|wav|m4a)$/i;
function harvestLinks(html: string, base: string): { links: string[]; assets: string[] } {
  const links = new Set<string>();
  const assets = new Set<string>();
  const attr = /(?:href|src|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html))) {
    const abs = normalizeUrl(new URL(m[1], base).toString());
    if (!abs) continue;
    const pathname = new URL(abs).pathname;
    if (ASSET_EXT.test(pathname)) {
      assets.add(abs);
      continue;
    }
    if (/\.(html?|php|aspx?|jsp)(\?|$)/i.test(abs) || !path.extname(pathname)) links.add(abs);
  }
  return { links: [...links], assets: [...assets] };
}

// Экранирование спецсимволов регулярного выражения.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Абсолютное и протокол-относительное написание ссылки: https://h/a.jpg и //h/a.jpg.
function absVariants(url: string): string[] {
  const noProto = url.replace(/^https?:/, "");
  return noProto === url ? [url] : [url, noProto];
}

// Относительные написания: "/img/a.jpg", "img/a.jpg", "./img/a.jpg" (с query).
// Нужны потому, что большинство сайтов ссылается на ресурсы именно так, и без
// них офлайн-превью тянуло картинки/стили со своего адреса и получало 404.
function relVariants(url: string): string[] {
  try {
    const u = new URL(url);
    if (u.pathname.length < 2) return []; // "/" — сама страница, не ресурс
    const rest = u.pathname.replace(/^\//, "");
    return [...new Set([`${u.pathname}${u.search}`, `${rest}${u.search}`, `./${rest}${u.search}`])];
  } catch {
    return []; // не URL — сопоставлять нечего
  }
}

// Перезапись путей в HTML/CSS на локальные ссылки превью (/raw/<rel>).
function rewriteRefs(text: string, id: string, urlMap: Map<string, string>): string {
  let out = text;
  for (const [url, rel] of urlMap) {
    const local = `/api/archive/${id}/raw/${rel}`;
    for (const cand of absVariants(url)) {
      out = out.split(cand).join(local);
    }
    // Относительные ссылки заменяем только ВНУТРИ кавычек атрибутов и в CSS
    // url(...) — так текст страницы не портится.
    for (const cand of relVariants(url)) {
      if (cand.length < 2) continue;
      const esc = escapeRe(cand);
      out = out.replace(new RegExp(`(["'])${esc}\\1`, "g"), (_m, q: string) => `${q}${local}${q}`);
      out = out.replace(new RegExp(`url\\(\\s*${esc}\\s*\\)`, "g"), `url(${local})`);
    }
  }
  return out;
}

// Конвертация изображений через FFmpeg. "original" + stripExif — только
// снятие метаданных (EXIF: гео/камера/автор) с копированием потока (С4).
async function optimizeImage(
  src: string,
  fmt: string,
  ffmpeg: string | null,
  stripExif: boolean,
): Promise<{ buf: Buffer; ext: string }> {
  if (!ffmpeg || (fmt === "original" && !stripExif))
    return { buf: fs.readFileSync(src), ext: path.extname(src).slice(1) };
  const stripArgs = ["-map_metadata", "-1"]; // EXIF/GPS/авторство стираются всегда при перекодировании
  const outExt = fmt === "avif" ? "avif" : fmt === "original" ? path.extname(src).slice(1) : "webp";
  const out = src + ".opt." + outExt;
  const args = ["-y", "-i", src];
  if (fmt === "original") args.push(...stripArgs, "-c", "copy");
  else if (fmt === "lossless") args.push(...stripArgs, "-c:v", "libwebp", "-lossless", "1");
  else if (fmt === "avif") args.push(...stripArgs, "-c:v", "libaom-av1", "-crf", "30");
  else args.push(...stripArgs, "-c:v", "libwebp", "-quality", "78");
  args.push(out);
  await new Promise<void>((resolve) => {
    execFile(ffmpeg, args, { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }, () =>
      resolve(),
    );
  });
  if (fs.existsSync(out)) {
    const buf = fs.readFileSync(out);
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    return { buf, ext: outExt };
  }
  return { buf: fs.readFileSync(src), ext: path.extname(src).slice(1) };
}

// Перекодирование видео (С4): videoMode=reencode -> HEVC с пользовательским CRF.
async function reencodeVideo(
  src: string,
  crf: number,
  ffmpeg: string | null,
): Promise<{ buf: Buffer; ext: string } | null> {
  if (!ffmpeg) return null;
  const out = src + ".re.mp4";
  await new Promise<void>((resolve) => {
    execFile(
      ffmpeg,
      [
        "-y",
        "-i",
        src,
        "-map_metadata",
        "-1",
        "-c:v",
        "libx265",
        "-crf",
        String(crf),
        "-preset",
        "fast",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        out,
      ],
      { timeout: 300000, windowsHide: true, maxBuffer: 1024 * 1024 },
      () => resolve(),
    );
  });
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    const buf = fs.readFileSync(out);
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    return { buf, ext: "mp4" };
  }
  return null;
}
/* ------------------------- Краул-пайплайн ------------------------- */

// Создание задания: параметры из UI с фолбэком на настройки sitebak.*.
function startCrawl(opts: CrawlInput): SitebakJob {
  const id = crypto.randomBytes(6).toString("hex");
  const cfg = (settings.get("sitebak") || {}) as SitebakConfig;
  const job = {
    id,
    url: opts.url,
    name: "",
    stage: "queued",
    progress: 0,
    pages: 0,
    origSize: 0,
    bakSize: 0,
    error: "",
    done: false,
    file: "",
    stats: {},
    createdAt: Date.now(),
    opts: {
      depth: opts.depth ?? 2, // 0 | 1..5 | "full"
      domainScope: opts.domainScope || "domain",
      maxPages: Math.min(5000, Number(opts.maxPages ?? cfg.maxPages ?? 500)),
      imageMode: opts.imageMode || cfg.mediaFormat || "webp",
      videoMode: opts.videoMode || "ignore", // ignore | reencode
      videoCrf: Number(opts.videoCrf ?? 30),
      stripScripts: opts.stripScripts ?? cfg.stripScripts ?? true,
      inlineAssets: opts.inlineAssets ?? true,
      blockAds: opts.blockAds ?? cfg.blockAds ?? true,
      stripExif: opts.stripExif ?? cfg.stripExif ?? true,
      delayMs: Math.max(0, Number(opts.delayMs ?? cfg.crawlDelayMs ?? 500)),
      concurrency: Math.max(1, Math.min(8, Number(opts.concurrency ?? cfg.maxConcurrent ?? 3))),
      cookies: String(opts.cookies || "").slice(0, 4000),
      userAgent: String(opts.userAgent || cfg.userAgent || "").trim(),
    },
  };
  jobs.set(id, job);
  trimJobs(jobs, JOB_LIMIT);
  // С5: краулы идут по одному (очередь), чтобы не плодить десятки браузеров.
  pending.push(() => runCrawl(job));
  pump();
  return job;
}

function getJob(id: string): SitebakJob | null {
  return jobs.get(id) || null;
}

/**
 * Остановить активный краул: раньше это было нельзя вообще (см.
 * AUDIT_REPORT.md, раздел 10) — только ждать естественного завершения или
 * закрывать приложение. Уже посещённые страницы упаковываются в частичный
 * .sitebak (см. проверку job.cancelled в цикле обхода выше).
 */
function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.cancelled = true;
  logger.action("sitebak.cancelled", { id });
  return true;
}

// Очередь заданий (С5): одно активное задание на модуль.
let active = false;
const pending: Array<() => unknown> = [];
function pump() {
  if (active || !pending.length) return;
  active = true;
  const fn = pending.shift();
  Promise.resolve()
    .then(fn)
    .catch((e) => logger.error("sitebak.queue", { error: String(e) }))
    .finally(() => {
      active = false;
      pump();
    });
}
/* ------------------------- Выполнение краула ------------------------- */

const LIST_FILE = path.join(DIRS.sitebak, "archives.json");

function loadArchiveList(): ArchiveListItem[] {
  try {
    return JSON.parse(fs.readFileSync(LIST_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveArchiveList(list: ArchiveListItem[]): void {
  fs.writeFileSync(LIST_FILE, JSON.stringify(list, null, 2), "utf8");
}

function isTextAsset(ext: string): boolean {
  return ["html", "htm", "css", "js", "json", "svg", "txt", "xml", "woff2", "woff"].includes(ext);
}

async function runCrawl(job: SitebakJob): Promise<void> {
  const o = job.opts;
  // Параметры упаковки берём из настроек: раньше cfg был только в startCrawl,
  // из-за чего стадия pack падала с ReferenceError.
  const cfg = (settings.get("sitebak") || {}) as SitebakConfig;
  const ua = o.userAgent || undefined;
  const workDir = path.join(DIRS.sitebak, job.id);
  fs.mkdirSync(workDir, { recursive: true });
  const { ffmpeg } = await detectFfmpeg();
  let playwright: PlaywrightModule | null = null;
  try {
    // playwright опционален: без него работает fetch-режим.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    playwright = require("playwright") as PlaywrightModule;
  } catch {
    /* fetch-режим (статический HTML) */
  }
  const visited = new Set<string>(); // посещённые URL (дедупликация очереди)
  const files = new Map<string, ArchiveFile>(); // relPath -> { buf, text }
  const urlMap = new Map<string, string>(); // исходный URL -> локальный relPath (перезапись, С2)
  const assetQueue: Array<{ url: string; depth: number }> = []; // ассеты страниц (С2)
  let assetTotal = 0;
  const queue: Array<{ url: string; depth: number }> = [{ url: job.url, depth: 0 }];

  try {
    job.stage = "crawl";
    let browser: PwBrowser | null = null,
      context: PwContext | null = null;
    if (playwright) {
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: ua,
        extraHTTPHeaders: o.cookies ? { Cookie: o.cookies } : undefined,
      });
    }
    // Получение страницы: Playwright с networkidle + автоскролл, либо fetch.
    const getPage = async (url: string): Promise<{ buf: Buffer; contentType: string }> => {
      if (context) {
        const page = await context.newPage();
        if (o.blockAds) {
          await page.route(
            /doubleclick|googlesyndication|google-analytics|googletagmanager|adnxs|taboola|criteo|facebook\.net|hotjar|mixpanel/i,
            (r) => r.abort(),
          );
        }
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await page
          .evaluate(async () => {
            await new Promise<void>((res) => {
              let y = 0;
              const step = () => {
                y += 600;
                window.scrollTo(0, y);
                if (y >= document.body.scrollHeight) res();
                else setTimeout(step, 120);
              };
              step();
            });
          })
          .catch(() => {});
        const html = await page.content();
        await page.close();
        return { buf: Buffer.from(html), contentType: "text/html" };
      }
      return fetchPage(url, ua, o.cookies);
    };

    while (queue.length && visited.size < o.maxPages) {
      // Остановка по запросу пользователя (Диспетчер фоновых задач): проверяем
      // между пачками — раньше краул нельзя было прервать вообще, только
      // ждать естественного завершения или закрывать приложение целиком.
      // Уже посещённые страницы всё равно упаковываются в валидный .sitebak
      // ниже (частичный архив полезнее, чем полная потеря прогресса).
      if (job.cancelled) break;
      const batch = queue.splice(0, o.concurrency);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const url = normalizeUrl(item.url);
          if (!url || visited.has(url)) return null;
          if (!inScope(url, job.url, o)) return null;
          if (o.blockAds && AD_HOSTS.test(url)) return null;
          visited.add(url);
          const { buf, contentType } = await getPage(url);
          await new Promise((r) => setTimeout(r, o.delayMs));
          return { url, buf, contentType, depth: item.depth };
        }),
      );
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const { url, buf, contentType, depth } = r.value;
        const isHtml = /text\/html/i.test(contentType) || /\.html?$/i.test(url);
        const rel =
          crypto.createHash("sha1").update(url).digest("hex").slice(0, 12) +
          (isHtml ? ".html" : path.extname(new URL(url).pathname));
        urlMap.set(url, rel);
        files.set(rel, { buf, text: isHtml });
        job.pages++;
        job.origSize += buf.length;
        if (isHtml) {
          const html = buf.toString("utf8");
          if (o.depth === "full" || depth < Number(o.depth)) {
            const { links } = harvestLinks(html, url);
            for (const l of links) {
              if (!visited.has(l) && inScope(l, job.url, o))
                queue.push({ url: l, depth: depth + 1 });
            }
          }
          // С2: собираем ассеты страницы (css/js/шрифты/картинки/медиа) —
          // без них офлайн-превью пустое.
          const { assets } = harvestLinks(html, url);
          for (const a of assets) {
            if (o.blockAds && AD_HOSTS.test(a)) continue;
            if (!urlMap.has(a)) assetQueue.push({ url: a, depth });
          }
        }
      }
      // Скачивание ассетов пачками с теми же delay/UA/cookies.
      while (assetQueue.length && assetTotal < o.maxPages * 40) {
        const abatch = assetQueue.splice(0, o.concurrency);
        const ares = await Promise.allSettled(
          abatch.map(async (item) => {
            const url = normalizeUrl(item.url);
            if (!url || urlMap.has(url)) return null;
            if (o.blockAds && AD_HOSTS.test(url)) return null;
            const { buf } = await fetchPage(url, ua, o.cookies);
            await new Promise((r) => setTimeout(r, o.delayMs));
            return { url, buf };
          }),
        );
        for (const r of ares) {
          if (r.status !== "fulfilled" || !r.value) continue;
          const { url, buf } = r.value;
          const ext = path.extname(new URL(url).pathname) || ".bin";
          const rel = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12) + ext;
          urlMap.set(url, rel);
          files.set(rel, { buf, text: false });
          assetTotal++;
          job.origSize += buf.length;
        }
      }
      job.progress = Math.min(80, Math.round((80 * visited.size) / Math.max(1, o.maxPages)));
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }

    // --- Стадия 3: оптимизация ассетов ---
    job.stage = "optimize";
    job.progress = 85;
    for (const [rel, f] of [...files]) {
      const ext = path.extname(rel).slice(1).toLowerCase();
      if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext) && o.videoMode === "reencode") {
        // С4: видео перекодируется в HEVC с пользовательским CRF.
        const tmp = path.join(workDir, "vid_" + rel.replace(/[\\/:*?"<>|]/g, "_"));
        fs.writeFileSync(tmp, f.buf);
        const res = await reencodeVideo(tmp, o.videoCrf, ffmpeg);
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
        if (res) {
          files.delete(rel);
          const newRel = rel.replace(/\.[a-z]+$/i, ".mp4");
          files.set(newRel, { buf: res.buf, text: false });
          // Ссылки в HTML переписываются по urlMap (rewriteRefs) — в нём должен
          // лежать НОВЫЙ ключ. Иначе превью ссылалось бы на .mkv, которого в
          // архиве уже нет: картинки/видео показывались бы «битыми».
          for (const [u, r] of urlMap) if (r === rel) urlMap.set(u, newRel);
        }
        continue;
      }
      if (
        ["png", "jpg", "jpeg", "bmp", "tiff"].includes(ext) &&
        (o.imageMode !== "original" || o.stripExif)
      ) {
        const tmp = path.join(workDir, "img_" + rel.replace(/[\\/:*?"<>|]/g, "_"));
        fs.writeFileSync(tmp, f.buf);
        // Перекодирование в WebP/AVIF удаляет EXIF; "original" — только EXIF.
        // Расширение берём у самой функции: если ffmpeg недоступен, она вернула
        // исходные байты, и переименовывать файл в .webp нельзя — иначе архив
        // отдавал бы JPEG под MIME image/webp.
        const { buf, ext } = await optimizeImage(tmp, o.imageMode, ffmpeg, o.stripExif);
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
        const newExt = `.${String(ext || path.extname(rel).slice(1)).replace(/^\./, "") || "bin"}`;
        const newRel = rel.replace(/\.[a-z]+$/i, newExt);
        files.delete(rel);
        files.set(newRel, { buf, text: false });
        // Ключ файла сменился (jpg → webp): в urlMap должен уехать именно он,
        // иначе rewriteRefs оставил бы в HTML ссылку на несуществующий .jpg и
        // все картинки в превью были бы битыми (реальная жалоба пользователя).
        if (newRel !== rel) {
          for (const [u, r] of urlMap) if (r === rel) urlMap.set(u, newRel);
        }
      }
      if (f.text && o.stripScripts) {
        f.buf = Buffer.from(
          f.buf.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, ""),
          "utf8",
        );
      }
    }

    // --- С2: перезапись URL в HTML/CSS на локальные пути превью ---
    // Порядок принципиален: сперва переписываем CSS (у них флажок text не
    // выставлен, но ссылки внутри те же — url(/img/...) в фоне), затем вшиваем
    // УЖЕ переписанный CSS в HTML и только потом переписываем сам HTML.
    // Раньше вшивание шло после перезаписи HTML и потому не срабатывало:
    // <link href> к тому моменту был уже локальным, а шаблон искал исходный
    // адрес — в итоге правило inlineAssets не вшивало ничего, а вшитый (если бы
    // он вшился) CSS уносил в страницу не переписанные url().
    for (const [rel, f] of files) {
      if (f.text || !/\.css$/i.test(rel)) continue;
      f.buf = Buffer.from(rewriteRefs(f.buf.toString("utf8"), job.id, urlMap), "utf8");
    }
    // Снимок [...files] нужен осознанно: ниже из Map удаляются вшитые CSS.
    for (const [_rel, f] of [...files]) {
      if (!f.text) continue;
      let text = f.buf.toString("utf8");
      // inlineAssets: css вшивается прямо в HTML вместо <link> (С4).
      if (o.inlineAssets) {
        for (const [url, arel] of urlMap) {
          const css = files.get(arel);
          if (!css || !/\.css$/i.test(arel)) continue;
          const cssText = css.buf.toString("utf8").replace(/<\/style/gi, "<\\/style");
          // Ищем <link> по всем написаниям адреса: сайты пишут и абсолютный, и
          // корневой "/css/site.css", и относительный "css/site.css".
          for (const cand of [...absVariants(url), ...relVariants(url)]) {
            if (cand.length < 2) continue;
            const linkRe = new RegExp(`<link[^>]*href=["']${escapeRe(cand)}["'][^>]*>`, "gi");
            if (!linkRe.test(text)) continue;
            text = text.replace(linkRe, `<style>${cssText}</style>`);
            files.delete(arel);
            break;
          }
        }
      }
      f.buf = Buffer.from(rewriteRefs(text, job.id, urlMap), "utf8");
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // --- Стадия 4: упаковка .sitebak (текст — сжатие, медиа — как есть) ---
    job.stage = "pack";
    job.progress = 92;
    // М4: время в имени до секунды — повторный краул того же сайта не
    // перезаписывает молча вчерашний архив.
    const host = new URL(job.url).hostname.replace(/^www\./, "");
    const tstamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "_");
    job.name = `${host}_${tstamp}.sitebak`;
    const bakPath = path.join(DIRS.sitebak, job.name);
    const fileEntries = [];
    let textOrig = 0,
      textComp = 0;
    // Явная аннотация: Buffer.from(...) в @types/node 22 отдаёт Buffer<ArrayBuffer>,
    // а элементы из compressText/fs.readFileSync — Buffer<ArrayBufferLike>.
    const parts: Buffer[] = [Buffer.from(MAGIC, "ascii")];
    for (const [rel, f] of files) {
      const ext = path.extname(rel).slice(1).toLowerCase();
      let data, isText;
      if (f.text || isTextAsset(ext)) {
        const c = compressText(f.buf, cfg.zstdDictKb);
        data = c.data;
        isText = true;
        textOrig += f.buf.length;
        textComp += data.length;
      } else {
        data = f.buf;
        isText = false;
      }
      fileEntries.push({
        path: rel,
        sha256: crypto.createHash("sha256").update(f.buf).digest("hex"),
        size: f.buf.length,
        text: isText,
      });
      const head = Buffer.alloc(9);
      head.writeUInt8(isText ? 1 : 0, 0);
      head.writeUInt32LE(Buffer.byteLength(rel, "utf8"), 1);
      head.writeUInt32LE(data.length, 5);
      parts.push(
        head,
        Buffer.from(rel, "utf8"),
        Buffer.from(String(f.buf.length).padStart(10, "0"), "ascii"),
        data,
      );
    }
    // Манифест (карта путей + sha256 + параметры краула) сразу после magic.
    // С3: cookies НЕ записываются в архив — секрет не должен лежать на диске
    // в открытом виде, они нужны только на время краула.
    const manifest = {
      version: 1,
      site: job.url,
      name: job.name,
      createdAt: new Date().toISOString(),
      opts: { ...o, cookies: undefined },
      files: fileEntries,
      compression: {
        textAlgo: zstdLib ? "zstd" : "brotli",
        ratio: textOrig ? +(textComp / textOrig).toFixed(3) : 1,
      },
    };
    const mb = compressText(Buffer.from(JSON.stringify(manifest), "utf8"), cfg.zstdDictKb);
    const mh = Buffer.alloc(4);
    mh.writeUInt32LE(mb.data.length, 0);
    fs.writeFileSync(bakPath, Buffer.concat([parts[0], mh, mb.data, ...parts.slice(1)]));

    job.file = bakPath;
    job.bakSize = fs.statSync(bakPath).size;
    job.stats = {
      pages: job.pages,
      origSize: job.origSize,
      bakSize: job.bakSize,
      savedPct: job.origSize
        ? Math.max(0, Math.round(100 - (100 * job.bakSize) / job.origSize))
        : 0,
      compression: manifest.compression,
      rendered: !!playwright,
    };
    job.progress = 100;
    job.done = true;
    job.stage = "done";
    const list = loadArchiveList().filter((a) => a.id !== job.id);
    list.unshift({
      id: job.id,
      name: job.name,
      site: job.url,
      createdAt: job.createdAt,
      stats: job.stats,
    });
    saveArchiveList(list.slice(0, 100));
    logger.info("sitebak.done", { id: job.id, pages: job.pages, bakSize: job.bakSize });
  } catch (e) {
    job.error = String((e as Error).message || e);
    job.stage = "error";
    logger.error("sitebak.error", { id: job.id, error: job.error });
  }
}
/* ------------------------- Чтение / проверка / извлечение ------------------------- */

// Хелперы разбора контейнера: заголовок (magic + манифест) и стартовое смещение.
function readManifest(raw: Buffer): SitebakManifest {
  if (raw.slice(0, 8).toString("ascii") !== MAGIC) throw new Error("bad_magic");
  const mLen = raw.readUInt32LE(8);
  const manifestRaw = raw.slice(12, 12 + mLen);
  try {
    return JSON.parse(manifestRaw.toString("utf8"));
  } catch {
    return JSON.parse(decompressText(manifestRaw, "brotli").toString("utf8"));
  }
}
// Смещение данных в архиве: 12 байт заголовка (magic + u32 длины манифеста).
function readHeader(raw: Buffer): number {
  const mLen = raw.readUInt32LE(8);
  return 12 + mLen;
}

// Парсинг .sitebak -> { manifest, entries: Map(path -> {buf, text}) }.
function readBak(file: string): { manifest: SitebakManifest; entries: Map<string, ArchiveFile> } {
  const raw = fs.readFileSync(file);
  const manifest = readManifest(raw);
  const entries = new Map<string, ArchiveFile>();
  const algo = manifest.compression?.textAlgo === "zstd" ? "zstd" : "brotli";
  let off = readHeader(raw);
  while (off + 19 <= raw.length) {
    const isText = raw.readUInt8(off) === 1;
    const pLen = raw.readUInt32LE(off + 1);
    const cLen = raw.readUInt32LE(off + 5);
    off += 9;
    const rel = raw.slice(off, off + pLen).toString("utf8");
    off += pLen;
    off += 10; // исходная длина (10 ASCII-символов) — нужна только для инфо
    const data = raw.slice(off, off + cLen);
    off += cLen;
    entries.set(rel, { buf: isText ? decompressText(data, algo) : data, text: isText });
  }
  return { manifest, entries };
}

// Проверка целостности (М4): стриминговое чтение — файл не грузится в память
// целиком, каждый entry хэшируется на лету и сразу освобождается.
function verify(file: string): { ok: number; bad: number; badPaths: string[]; total: number } {
  const raw = fs.readFileSync(file);
  let ok = 0,
    bad = 0;
  const badPaths: string[] = [];
  const manifest = readManifest(raw);
  const algo = manifest.compression?.textAlgo === "zstd" ? "zstd" : "brotli";
  let off = readHeader(raw);
  const known = new Map((manifest.files || []).map((f) => [f.path, f]));
  while (off + 19 <= raw.length) {
    const isText = raw.readUInt8(off) === 1;
    const pLen = raw.readUInt32LE(off + 1);
    const cLen = raw.readUInt32LE(off + 5);
    off += 9;
    const rel = raw.slice(off, off + pLen).toString("utf8");
    off += pLen;
    off += 10;
    const data = raw.slice(off, off + cLen);
    off += cLen;
    const f = known.get(rel);
    if (!f) continue;
    const buf = isText ? decompressText(data, algo) : data;
    if (crypto.createHash("sha256").update(buf).digest("hex") === f.sha256) ok++;
    else {
      bad++;
      badPaths.push(rel);
    }
  }
  return { ok, bad, badPaths, total: (manifest.files || []).length };
}

// Извлечение всех файлов в extracted/<id>/ (с защитой от path traversal).
function extractTo(file: string, id: string): string {
  const { entries } = readBak(file);
  const dest = path.join(DIRS.sitebakExtracted, id);
  for (const [rel, e] of entries) {
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const p = path.join(dest, safe);
    if (!p.startsWith(dest)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.buf);
  }
  return dest;
}

// Удаление архива: файл + запись в списке.
function deleteArchive(id: string): boolean {
  const list = loadArchiveList();
  const item = list.find((a) => a.id === id);
  if (item?.name) {
    try {
      fs.rmSync(path.join(DIRS.sitebak, item.name), { force: true });
    } catch {
      /* ignore */
    }
  }
  saveArchiveList(list.filter((a) => a.id !== id));
  return !!item;
}

export {
  startCrawl,
  getJob,
  cancelJob,
  jobs,
  MAGIC,
  readBak,
  verify,
  extractTo,
  loadArchiveList,
  deleteArchive,
};

// --- Диспетчер фоновых задач (server/ts/taskRegistry.ts) ---
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskRegistry = require("./taskRegistry") as typeof import("./taskRegistry");
taskRegistry.registerProvider({
  engine: "archive",
  list: () =>
    [...jobs.values()].map((j) => {
      // j.done остаётся false при stage "error" (не выставляется в catch) —
      // для Task Manager важно только "активна ли задача ещё".
      const finished = j.done || j.stage === "error";
      return {
        id: j.id,
        engine: "archive",
        label: j.name || j.url,
        stage: j.stage,
        progress: Math.round(j.progress || 0),
        createdAt: j.createdAt,
        done: finished,
        error: j.error || null,
        canCancel: !finished,
        canPause: false,
        paused: false,
      };
    }),
  cancel: (id) => cancelJob(id),
});
