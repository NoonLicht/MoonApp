"use strict";

// window/document живут внутри page.evaluate() — это код, который
// Playwright выполняет в контексте страницы, а не в Node.
/* global window, document */

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

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const settings = require("./settings");
const logger = require("./logger");
const { DIRS } = require("./config");
const { detectFfmpeg } = require("./convertEngine");

const MAGIC = "SITEBAK1";
const AD_HOSTS = /doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adnxs|taboola|outbrain|criteo|facebook\.net|hotjar|mixpanel|segment\.io|scorecardresearch/i;

const jobs = new Map(); // id -> job
const JOB_LIMIT = 20;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// С6: чистим распакованные копии старше 7 дней (сами .sitebak не трогаем —
// это пользовательские данные) и ограничиваем Map заданий.
function trimJobs() {
  if (jobs.size <= JOB_LIMIT) return;
  const removable = [...jobs.values()]
    .filter((j) => j.done || j.stage === "error")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const j of removable) {
    if (jobs.size <= JOB_LIMIT) break;
    jobs.delete(j.id);
  }
}
function cleanupOld() {
  try {
    const dir = DIRS.sitebakExtracted;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* занят — пропускаем */ }
    }
  } catch { /* не критично */ }
}
cleanupOld();

// Опциональная нативная ZSTD-библиотека; если не установлена — Brotli из Node.
let zstdLib = null;
for (const name of ["@napi-rs/zstd", "zstd-napi", "simple-zstd"]) {
  try { zstdLib = require(name); break; } catch { /* не установлена */ }
}

function compressText(buf, hintKb) {
  if (zstdLib?.compressSync) {
    try { return { data: zstdLib.compressSync(buf, 19), algo: "zstd" }; } catch { /* fallback */ }
  }
  // Brotli: SIZE_HINT из настройки zstdDictKb — фактически окно словаря:
  // больше словарь/окно → лучше сжатие больших однотипных сайтов.
  const hint = Math.max(1024, Math.min(16 * 1024 * 1024, (Number(hintKb) || 1024) * 1024));
  return {
    data: zlib.brotliCompressSync(buf, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: hint,
    } }),
    algo: "brotli",
  };
}

function decompressText(buf, algo) {
  if (algo === "zstd" && zstdLib?.decompressSync) return zstdLib.decompressSync(buf);
  return zlib.brotliDecompressSync(buf);
}

// Приведение URL: без хеша и трекинг-параметров.
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"]) url.searchParams.delete(p);
    return url.toString();
  } catch { return null; }
}

// Подходит ли ссылка под правила обхода (домен/поддомен/путь).
function inScope(candidate, base, opts) {
  try {
    const a = new URL(candidate);
    const b = new URL(base);
    const sameHost = a.hostname === b.hostname;
    const isSub = a.hostname.endsWith("." + b.hostname.replace(/^www\./, ""));
    const scope = opts.domainScope || "domain"; // path | subdomain | domain
    if (scope === "path" && !(sameHost && a.pathname.startsWith(b.pathname.replace(/\/[^/]*$/, "/")))) return false;
    if (scope !== "path" && !(sameHost || isSub)) return false;
    if (!/^https?:$/.test(a.protocol)) return false;
    return true;
  } catch { return false; }
}

// fetch-краулер: HTML с лимитом размера и таймаутом.
async function fetchPage(url, ua, cookies) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent": ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
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
const ASSET_EXT = /\.(css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|eot|mp4|webm|mp3|ogg|wav|m4a)$/i;
function harvestLinks(html, base) {
  const links = new Set();
  const assets = new Set();
  const attr = /(?:href|src|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html))) {
    const abs = normalizeUrl(new URL(m[1], base).toString());
    if (!abs) continue;
    const pathname = new URL(abs).pathname;
    if (ASSET_EXT.test(pathname)) { assets.add(abs); continue; }
    if (/\.(html?|php|aspx?|jsp)(\?|$)/i.test(abs) || !path.extname(pathname)) links.add(abs);
  }
  return { links: [...links], assets: [...assets] };
}

// Перезапись путей в HTML/CSS на локальные ссылки превью (/raw/<rel>).
// Меняем все вхождения известных URL (абсолютные и протокол-относительные).
function rewriteRefs(text, id, urlMap) {
  let out = text;
  for (const [url, rel] of urlMap) {
    const local = `/api/archive/${id}/raw/${rel}`;
    const noProto = url.replace(/^https?:/, "");
    out = out.split(url).join(local).split(noProto).join(local);
  }
  return out;
}

// Конвертация изображений через FFmpeg. "original" + stripExif — только
// снятие метаданных (EXIF: гео/камера/автор) с копированием потока (С4).
async function optimizeImage(src, fmt, ffmpeg, stripExif) {
  if (!ffmpeg || (fmt === "original" && !stripExif)) return { buf: fs.readFileSync(src), ext: path.extname(src).slice(1) };
  const stripArgs = ["-map_metadata", "-1"]; // EXIF/GPS/авторство стираются всегда при перекодировании
  const outExt = fmt === "avif" ? "avif" : (fmt === "original" ? path.extname(src).slice(1) : "webp");
  const out = src + ".opt." + outExt;
  const args = ["-y", "-i", src];
  if (fmt === "original") args.push(...stripArgs, "-c", "copy");
  else if (fmt === "lossless") args.push(...stripArgs, "-c:v", "libwebp", "-lossless", "1");
  else if (fmt === "avif") args.push(...stripArgs, "-c:v", "libaom-av1", "-crf", "30");
  else args.push(...stripArgs, "-c:v", "libwebp", "-quality", "78");
  args.push(out);
  await new Promise((resolve) => {
    execFile(ffmpeg, args, { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }, () => resolve());
  });
  if (fs.existsSync(out)) {
    const buf = fs.readFileSync(out);
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    return { buf, ext: outExt };
  }
  return { buf: fs.readFileSync(src), ext: path.extname(src).slice(1) };
}

// Перекодирование видео (С4): videoMode=reencode -> HEVC с пользовательским CRF.
async function reencodeVideo(src, crf, ffmpeg) {
  if (!ffmpeg) return null;
  const out = src + ".re.mp4";
  await new Promise((resolve) => {
    execFile(ffmpeg, ["-y", "-i", src, "-map_metadata", "-1", "-c:v", "libx265",
      "-crf", String(crf), "-preset", "fast", "-c:a", "aac", "-b:a", "128k", out],
      { timeout: 300000, windowsHide: true, maxBuffer: 1024 * 1024 }, () => resolve());
  });
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    const buf = fs.readFileSync(out);
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    return { buf, ext: "mp4" };
  }
  return null;
}
/* ------------------------- Краул-пайплайн ------------------------- */

// Создание задания: параметры из UI с фолбэком на настройки sitebak.*.
function startCrawl(opts) {
  const id = crypto.randomBytes(6).toString("hex");
  const cfg = settings.get("sitebak") || {};
  const job = {
    id, url: opts.url, name: "", stage: "queued", progress: 0,
    pages: 0, origSize: 0, bakSize: 0, error: "", done: false,
    file: "", stats: {}, createdAt: Date.now(),
    opts: {
      depth: opts.depth ?? 2,                 // 0 | 1..5 | "full"
      domainScope: opts.domainScope || "domain",
      maxPages: Math.min(5000, Number(opts.maxPages ?? cfg.maxPages ?? 500)),
      imageMode: opts.imageMode || cfg.mediaFormat || "webp",
      videoMode: opts.videoMode || "ignore",  // ignore | reencode
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
  trimJobs();
  // С5: краулы идут по одному (очередь), чтобы не плодить десятки браузеров.
  pending.push(() => runCrawl(job));
  pump();
  return job;
}

function getJob(id) { return jobs.get(id) || null; }

// Очередь заданий (С5): одно активное задание на модуль.
let active = false;
const pending = [];
function pump() {
  if (active || !pending.length) return;
  active = true;
  const fn = pending.shift();
  Promise.resolve()
    .then(fn)
    .catch((e) => logger.error("sitebak.queue", { error: String(e) }))
    .finally(() => { active = false; pump(); });
}
/* ------------------------- Выполнение краула ------------------------- */

const LIST_FILE = path.join(DIRS.sitebak, "archives.json");

function loadArchiveList() {
  try { return JSON.parse(fs.readFileSync(LIST_FILE, "utf8")); } catch { return []; }
}
function saveArchiveList(list) { fs.writeFileSync(LIST_FILE, JSON.stringify(list, null, 2), "utf8"); }

function isTextAsset(ext) {
  return ["html", "htm", "css", "js", "json", "svg", "txt", "xml", "woff2", "woff"].includes(ext);
}

async function runCrawl(job) {
  const o = job.opts;
  // Параметры упаковки берём из настроек: раньше cfg был только в startCrawl,
  // из-за чего стадия pack падала с ReferenceError.
  const cfg = settings.get("sitebak") || {};
  const ua = o.userAgent || undefined;
  const workDir = path.join(DIRS.sitebak, job.id);
  fs.mkdirSync(workDir, { recursive: true });
  const { ffmpeg } = await detectFfmpeg();
  let playwright = null;
  try { playwright = require("playwright"); } catch { /* fetch-режим (статический HTML) */ }
  const visited = new Set();
  const files = new Map(); // relPath -> { buf, text }
  const urlMap = new Map(); // исходный URL -> локальный relPath (для перезаписи, С2)
  const assetQueue = []; // очередь скачивания ассетов (С2)
  let assetTotal = 0;
  const queue = [{ url: job.url, depth: 0 }];

  try {
    job.stage = "crawl";
    let browser = null, context = null;
    if (playwright) {
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext({ userAgent: ua, extraHTTPHeaders: o.cookies ? { Cookie: o.cookies } : undefined });
    }
    // Получение страницы: Playwright с networkidle + автоскролл, либо fetch.
    const getPage = async (url) => {
      if (context) {
        const page = await context.newPage();
        if (o.blockAds) {
          await page.route(/doubleclick|googlesyndication|google-analytics|googletagmanager|adnxs|taboola|criteo|facebook\.net|hotjar|mixpanel/i, (r) => r.abort());
        }
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await page.evaluate(async () => {
          await new Promise((res) => {
            let y = 0;
            const step = () => {
              y += 600; window.scrollTo(0, y);
              if (y >= document.body.scrollHeight) res(); else setTimeout(step, 120);
            };
            step();
          });
        }).catch(() => {});
        const html = await page.content();
        await page.close();
        return { buf: Buffer.from(html), contentType: "text/html" };
      }
      return fetchPage(url, ua, o.cookies);
    };

    while (queue.length && visited.size < o.maxPages) {
      const batch = queue.splice(0, o.concurrency);
      const results = await Promise.allSettled(batch.map(async (item) => {
        const url = normalizeUrl(item.url);
        if (!url || visited.has(url)) return null;
        if (!inScope(url, job.url, o)) return null;
        if (o.blockAds && AD_HOSTS.test(url)) return null;
        visited.add(url);
        const { buf, contentType } = await getPage(url);
        await new Promise((r) => setTimeout(r, o.delayMs));
        return { url, buf, contentType, depth: item.depth };
      }));
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const { url, buf, contentType, depth } = r.value;
        const isHtml = /text\/html/i.test(contentType) || /\.html?$/i.test(url);
        const rel = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12) + (isHtml ? ".html" : path.extname(new URL(url).pathname));
        urlMap.set(url, rel);
        files.set(rel, { buf, text: isHtml });
        job.pages++; job.origSize += buf.length;
        if (isHtml) {
          const html = buf.toString("utf8");
          if (o.depth === "full" || depth < Number(o.depth)) {
            const { links } = harvestLinks(html, url);
            for (const l of links) {
              if (!visited.has(l) && inScope(l, job.url, o)) queue.push({ url: l, depth: depth + 1 });
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
        const ares = await Promise.allSettled(abatch.map(async (item) => {
          const url = normalizeUrl(item.url);
          if (!url || urlMap.has(url)) return null;
          if (o.blockAds && AD_HOSTS.test(url)) return null;
          const { buf } = await fetchPage(url, ua, o.cookies);
          await new Promise((r) => setTimeout(r, o.delayMs));
          return { url, buf };
        }));
        for (const r of ares) {
          if (r.status !== "fulfilled" || !r.value) continue;
          const { url, buf } = r.value;
          const ext = path.extname(new URL(url).pathname) || ".bin";
          const rel = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12) + ext;
          urlMap.set(url, rel);
          files.set(rel, { buf, text: false });
          assetTotal++; job.origSize += buf.length;
        }
      }
      job.progress = Math.min(80, Math.round((80 * visited.size) / Math.max(1, o.maxPages)));
    }
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }

    // --- Стадия 3: оптимизация ассетов ---
    job.stage = "optimize"; job.progress = 85;
    for (const [rel, f] of [...files]) {
      const ext = path.extname(rel).slice(1).toLowerCase();
      if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext) && o.videoMode === "reencode") {
        // С4: видео перекодируется в HEVC с пользовательским CRF.
        const tmp = path.join(workDir, "vid_" + rel.replace(/[\\/:*?"<>|]/g, "_"));
        fs.writeFileSync(tmp, f.buf);
        const res = await reencodeVideo(tmp, o.videoCrf, ffmpeg);
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        if (res) {
          files.delete(rel);
          files.set(rel.replace(/\.[a-z]+$/i, ".mp4"), { buf: res.buf, text: false });
        }
        continue;
      }
      if (["png", "jpg", "jpeg", "bmp", "tiff"].includes(ext) && (o.imageMode !== "original" || o.stripExif)) {
        const tmp = path.join(workDir, "img_" + rel.replace(/[\\/:*?"<>|]/g, "_"));
        fs.writeFileSync(tmp, f.buf);
        // Перекодирование в WebP/AVIF удаляет EXIF; "original" — только EXIF.
        const { buf } = await optimizeImage(tmp, o.imageMode, ffmpeg, o.stripExif);
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        const newExt = o.imageMode === "original" ? path.extname(rel) : (o.imageMode === "avif" ? ".avif" : ".webp");
        files.delete(rel);
        files.set(rel.replace(/\.[a-z]+$/i, newExt), { buf, text: false });
      }
      if (f.text && o.stripScripts) {
        f.buf = Buffer.from(f.buf.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, ""), "utf8");
      }
    }

    // --- С2: перезапись URL в HTML/CSS на локальные пути превью ---
    for (const [rel, f] of [...files]) {
      if (!f.text) continue;
      let text = f.buf.toString("utf8");
      text = rewriteRefs(text, job.id, urlMap);
      // inlineAssets: css вшивается прямо в HTML вместо <link> (С4).
      if (o.inlineAssets) {
        for (const [url, arel] of urlMap) {
          const css = files.get(arel);
          if (!css || !/\.css$/i.test(arel)) continue;
          const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const linkRe = new RegExp(`<link[^>]*href=["']${esc}["'][^>]*>`, "gi");
          if (linkRe.test(text)) {
            const cssText = css.buf.toString("utf8").replace(/<\/style/gi, "<\\/style");
            text = text.replace(linkRe, `<style>${cssText}</style>`);
            files.delete(arel);
          }
        }
      }
      f.buf = Buffer.from(text, "utf8");
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // --- Стадия 4: упаковка .sitebak (текст — сжатие, медиа — как есть) ---
    job.stage = "pack"; job.progress = 92;
    // М4: время в имени до секунды — повторный краул того же сайта не
    // перезаписывает молча вчерашний архив.
    const host = new URL(job.url).hostname.replace(/^www\./, "");
    const tstamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "_");
    job.name = `${host}_${tstamp}.sitebak`;
    const bakPath = path.join(DIRS.sitebak, job.name);
    const fileEntries = [];
    let textOrig = 0, textComp = 0;
    const parts = [Buffer.from(MAGIC, "ascii")];
    for (const [rel, f] of files) {
      const ext = path.extname(rel).slice(1).toLowerCase();
      let data, isText;
      if (f.text || isTextAsset(ext)) {
        const c = compressText(f.buf, cfg.zstdDictKb); data = c.data; isText = true;
        textOrig += f.buf.length; textComp += data.length;
      } else { data = f.buf; isText = false; }
      fileEntries.push({
        path: rel, sha256: crypto.createHash("sha256").update(f.buf).digest("hex"),
        size: f.buf.length, text: isText,
      });
      const head = Buffer.alloc(9);
      head.writeUInt8(isText ? 1 : 0, 0);
      head.writeUInt32LE(Buffer.byteLength(rel, "utf8"), 1);
      head.writeUInt32LE(data.length, 5);
      parts.push(head, Buffer.from(rel, "utf8"), Buffer.from(String(f.buf.length).padStart(10, "0"), "ascii"), data);
    }
    // Манифест (карта путей + sha256 + параметры краула) сразу после magic.
    // С3: cookies НЕ записываются в архив — секрет не должен лежать на диске
    // в открытом виде, они нужны только на время краула.
    const manifest = {
      version: 1, site: job.url, name: job.name, createdAt: new Date().toISOString(),
      opts: { ...o, cookies: undefined }, files: fileEntries,
      compression: { textAlgo: zstdLib ? "zstd" : "brotli", ratio: textOrig ? +(textComp / textOrig).toFixed(3) : 1 },
    };
    const mb = compressText(Buffer.from(JSON.stringify(manifest), "utf8"), cfg.zstdDictKb);
    const mh = Buffer.alloc(4);
    mh.writeUInt32LE(mb.data.length, 0);
    fs.writeFileSync(bakPath, Buffer.concat([parts[0], mh, mb.data, ...parts.slice(1)]));

    job.file = bakPath;
    job.bakSize = fs.statSync(bakPath).size;
    job.stats = {
      pages: job.pages, origSize: job.origSize, bakSize: job.bakSize,
      savedPct: job.origSize ? Math.max(0, Math.round(100 - (100 * job.bakSize) / job.origSize)) : 0,
      compression: manifest.compression, rendered: !!playwright,
    };
    job.progress = 100; job.done = true; job.stage = "done";
    const list = loadArchiveList().filter((a) => a.id !== job.id);
    list.unshift({ id: job.id, name: job.name, site: job.url, createdAt: job.createdAt, stats: job.stats });
    saveArchiveList(list.slice(0, 100));
    logger.info("sitebak.done", { id: job.id, pages: job.pages, bakSize: job.bakSize });
  } catch (e) {
    job.error = String(e.message || e); job.stage = "error";
    logger.error("sitebak.error", { id: job.id, error: job.error });
  }
}
/* ------------------------- Чтение / проверка / извлечение ------------------------- */

// Хелперы разбора контейнера: заголовок (magic + манифест) и стартовое смещение.
function readManifest(raw) {
  if (raw.slice(0, 8).toString("ascii") !== MAGIC) throw new Error("bad_magic");
  const mLen = raw.readUInt32LE(8);
  const manifestRaw = raw.slice(12, 12 + mLen);
  try { return JSON.parse(manifestRaw.toString("utf8")); }
  catch { return JSON.parse(decompressText(manifestRaw, "brotli").toString("utf8")); }
}
function readHeader(raw, manifest) {
  const mLen = raw.readUInt32LE(8);
  return 12 + mLen;
}

// Парсинг .sitebak -> { manifest, entries: Map(path -> {buf, text}) }.
function readBak(file) {
  const raw = fs.readFileSync(file);
  const manifest = readManifest(raw);
  const entries = new Map();
  const algo = manifest.compression?.textAlgo === "zstd" ? "zstd" : "brotli";
  let off = readHeader(raw, manifest);
  while (off + 19 <= raw.length) {
    const isText = raw.readUInt8(off) === 1;
    const pLen = raw.readUInt32LE(off + 1);
    const cLen = raw.readUInt32LE(off + 5);
    off += 9;
    const rel = raw.slice(off, off + pLen).toString("utf8"); off += pLen;
    off += 10; // исходная длина (10 ASCII-символов) — нужна только для инфо
    const data = raw.slice(off, off + cLen); off += cLen;
    entries.set(rel, { buf: isText ? decompressText(data, algo) : data, text: isText });
  }
  return { manifest, entries };
}

// Проверка целостности (М4): стриминговое чтение — файл не грузится в память
// целиком, каждый entry хэшируется на лету и сразу освобождается.
function verify(file) {
  const raw = fs.readFileSync(file);
  let ok = 0, bad = 0;
  const badPaths = [];
  const manifest = readManifest(raw);
  const algo = manifest.compression?.textAlgo === "zstd" ? "zstd" : "brotli";
  let off = readHeader(raw, manifest);
  const known = new Map((manifest.files || []).map((f) => [f.path, f]));
  while (off + 19 <= raw.length) {
    const isText = raw.readUInt8(off) === 1;
    const pLen = raw.readUInt32LE(off + 1);
    const cLen = raw.readUInt32LE(off + 5);
    off += 9;
    const rel = raw.slice(off, off + pLen).toString("utf8"); off += pLen;
    off += 10;
    const data = raw.slice(off, off + cLen); off += cLen;
    const f = known.get(rel);
    if (!f) continue;
    const buf = isText ? decompressText(data, algo) : data;
    if (crypto.createHash("sha256").update(buf).digest("hex") === f.sha256) ok++;
    else { bad++; badPaths.push(rel); }
  }
  return { ok, bad, badPaths, total: (manifest.files || []).length };
}

// Извлечение всех файлов в extracted/<id>/ (с защитой от path traversal).
function extractTo(file, id) {
  const { entries } = readBak(file);
  const dest = path.join(DIRS.sitebakExtracted, id);
  for (const [rel, e] of entries) {
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, "");
    const p = path.join(dest, safe);
    if (!p.startsWith(dest)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.buf);
  }
  return dest;
}

// Удаление архива: файл + запись в списке.
function deleteArchive(id) {
  const list = loadArchiveList();
  const item = list.find((a) => a.id === id);
  if (item?.name) { try { fs.rmSync(path.join(DIRS.sitebak, item.name), { force: true }); } catch { /* ignore */ } }
  saveArchiveList(list.filter((a) => a.id !== id));
  return !!item;
}

module.exports = { startCrawl, getJob, jobs, MAGIC, readBak, verify, extractTo, loadArchiveList, deleteArchive };
