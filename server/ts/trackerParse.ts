/**
 * Разбор страниц форума-трекера (rutracker.org и другие phpBB-совместимые).
 *
 * Модуль ЧИСТЫЙ: ни сети, ни БД, ни настроек — только HTML-строка и правила
 * разбора. Поэтому он полностью покрыт юнит-тестами (tests/trackerParse.test.ts),
 * а сетевую часть (сессия, куки, прокси) держит server/trackerScraper.ts.
 *
 * Почему regex, а не cheerio: в проекте нет HTML-парсера как зависимости
 * (server/flibusta.js разбирает OPDS тем же способом), а тянуть библиотеку ради
 * двух таблиц нерационально. Разбор терпим к разметке: сначала пробуем явные
 * признаки rutracker (`id="tor-tbl"`, `trs-tr-<id>`), затем — общий случай.
 *
 * TS-исходник, как server/ts/charset.ts: компилируется в server/trackerParse.js
 * командой `npm run compile:server`.
 */
import { decodeEntities, stripTags } from "./charset";
import { normEngine } from "./trackerProviders";

/** Метаданные, вытащенные из названия раздачи регулярками. */
export interface ReleaseMeta {
  resolution: string | null;
  codec: string | null;
  audio: string[];
  releaseGroup: string | null;
  source: string | null;
  hdr: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

/** Строка таблицы результатов «как есть» (до сборки TrackerRelease). */
export interface RawReleaseRow {
  id: string;
  title: string;
  sizeText: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  downloads: number;
  magnet: string | null;
  torrentId: string | null;
}

/** «1.37 GB», «750 МБ», «4,7 ГБ» → байты (0, если размера нет). */
export function sizeToBytes(text: unknown): number {
  const m = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B|ТБ|ГБ|МБ|КБ|Б)/i.exec(String(text || ""));
  if (!m) return 0;
  const value = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return 0;
  const unit = m[2].toUpperCase();
  const mult =
    unit === "TB" || unit === "ТБ"
      ? 1024 ** 4
      : unit === "GB" || unit === "ГБ"
        ? 1024 ** 3
        : unit === "MB" || unit === "МБ"
          ? 1024 ** 2
          : unit === "KB" || unit === "КБ"
            ? 1024
            : 1;
  return Math.round(value * mult);
}

/** Разрешение: 4K/2160p → "4K", остальное — как в названии (1080p, 720p…). */
function metaResolution(t: string): string | null {
  if (/\b(2160p|4k|uhd)\b/i.test(t)) return "4K";
  const m = /\b(1440p|1080p|1080i|720p|576p|480p|360p)\b/i.exec(t);
  return m ? m[1].toLowerCase() : null;
}

/** Кодек: x265/HEVC/H.265 → "x265 (HEVC)", x264/H.264/AVC → "x264". */
function metaCodec(t: string): string | null {
  if (/\b(x265|hevc|h\.?265)\b/i.test(t)) return "x265 (HEVC)";
  if (/\b(x264|avc|h\.?264)\b/i.test(t)) return "x264";
  if (/\bav1\b/i.test(t)) return "AV1";
  if (/\b(xvid|divx)\b/i.test(t)) return "XviD";
  if (/\bmpeg-?2\b/i.test(t)) return "MPEG-2";
  if (/\bvp9\b/i.test(t)) return "VP9";
  return null;
}

/** Канонический порядок вывода звуковых дорожек (для стабильных тестов). */
const AUDIO_ORDER = [
  "Дубляж",
  "Профессиональный",
  "MVO",
  "DVO",
  "Авторский",
  "Одноголосый",
  "Лицензия",
  "Оригинал",
];

/**
 * Аудио из названия: «Дубляж», «MVO», «DVO», «Авторский», «Оригинал» и т.п.
 * Возвращаем массив в каноническом порядке (в названии их может быть несколько).
 */
export function releaseAudio(t: string): string[] {
  const found = new Set<string>();
  if (/дубл(?:яж|ирован)|dub(?:bed)?\b/i.test(t)) found.add("Дубляж");
  if (/профессиональн|prof(?:essional)?\b/i.test(t)) found.add("Профессиональный");
  if (/\bmvo\b|многоголос/i.test(t)) found.add("MVO");
  if (/\bdvo\b|двухголос/i.test(t)) found.add("DVO");
  if (/авторск|\bavo\b/i.test(t)) found.add("Авторский");
  if (/одноголос|\bvo\b/i.test(t)) found.add("Одноголосый");
  if (/лиценз/i.test(t)) found.add("Лицензия");
  if (/\boriginal\b|оригинал/i.test(t)) found.add("Оригинал");
  return AUDIO_ORDER.filter((a) => found.has(a));
}

/** Источник: BDRip/BDRemux/WEB-DL/HDRip/DVDRip/HDTV и т.п. */
function metaSource(t: string): string | null {
  const map: [RegExp, string][] = [
    [/bdremux|\bremux\b/i, "BDRemux"],
    [/\bbdrip\b/i, "BDRip"],
    [/\bblu-?ray\b|\bbd\b/i, "Blu-Ray"],
    [/web-?dl/i, "WEB-DL"],
    [/web-?rip|\bweb\b/i, "WEBRip"],
    [/\bhdtv\b/i, "HDTV"],
    [/\bdvd-?r(?:ip)?\b/i, "DVDRip"],
    [/\bhdrip\b/i, "HDRip"],
    [/\bsat-?rip\b/i, "SATRip"],
    [/ts-?rip|dvb/i, "TSRip"],
  ];
  for (const [re, label] of map) if (re.test(t)) return label;
  return null;
}

/** HDR: HDR10+/HDR/Dolby Vision/DV/SDR. */
function metaHdr(t: string): string | null {
  if (/hdr10\+/i.test(t)) return "HDR10+";
  if (/hdr10/i.test(t)) return "HDR10";
  if (/(?:dolby\s*vision|dovi)/i.test(t)) return "Dolby Vision";
  if (/\bhdr\b/i.test(t)) return "HDR";
  if (/\bsdr\b/i.test(t)) return "SDR";
  return null;
}

/** Английские/технические токены, которые не могут быть названием релиз-группы. */
const NOT_A_GROUP =
  /^(?:1080p|720p|2160p|4k|uhd|hdr|hdr10|sdr|x264|x265|hevc|avc|av1|web-?dl|web-?rip|bdrip|bdremux|hdtv|dvdrip|hdrip|mvo|dvo|avo|vo|multi|rus|eng|sub|лицензия|дубляж)$/i;

/**
 * Релиз-группа: последняя группа в [квадратных] скобках, иначе — хвост после
 * последнего дефиса/вертикальной черты («… - GROUP»). Технические токены,
 * разрешения и кодеки группой не считаются.
 */
export function releaseGroup(t: string): string | null {
  const brackets = [...t.matchAll(/\[([^[\]]{2,40})\]/g)].map((m) => m[1].trim());
  for (let i = brackets.length - 1; i >= 0; i--) {
    const cand = brackets[i];
    if (cand && !NOT_A_GROUP.test(cand)) return cand;
  }
  const tail = /[-|]\s*([A-Za-z0-9][A-Za-z0-9_.-]{1,29})\s*$/.exec(t);
  if (tail) {
    const cand = tail[1].trim();
    if (!NOT_A_GROUP.test(cand) && !/^\d+$/.test(cand)) return cand;
  }
  return null;
}

/** Полный разбор названия темы. */
export function parseReleaseMeta(title: unknown): ReleaseMeta {
  const raw = String(title || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Год: приоритет скобкам «(2010)», иначе первое похожее четырёхзначное число.
  const yearInParens = /\(((?:19|20)\d{2})\)/.exec(raw);
  const yearAny = /\b((?:19|20)\d{2})\b/.exec(raw);
  const year = Number((yearInParens || yearAny)?.[1]) || null;

  // Сезон/серия: S01E02, «1 сезон», «Серия 5», «E05».
  const se = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(raw);
  const seasonOnly = /\bS(\d{1,2})\b/i.exec(raw) || /(\d{1,2})\s*сезон/i.exec(raw);
  const epOnly = /\bE(\d{1,3})\b/i.exec(raw) || /(?:серия|выпуск)\s*(\d{1,3})/i.exec(raw);

  return {
    resolution: metaResolution(raw),
    codec: metaCodec(raw),
    audio: releaseAudio(raw),
    releaseGroup: releaseGroup(raw),
    source: metaSource(raw),
    hdr: metaHdr(raw),
    year,
    season: Number(se?.[1] || seasonOnly?.[1]) || null,
    episode: Number(se?.[2] || epOnly?.[1]) || null,
  };
}

/** Текст HTML-фрагмента без тегов (реэкспорт для роутов/тестов). */
export { stripTags, decodeEntities };

/** Первое число в тексте («1 234» → 1234, «—» → 0). */
function firstNumber(text: unknown): number {
  const m = /(\d[\d\s\u00A0.,]*)/.exec(String(text || ""));
  if (!m) return 0;
  const digits = m[1].replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

/** Ячейки строки таблицы (без вложенных таблиц — они не используются). */
function cellsOf(inner: string): string[] {
  return [...inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
}

/** Разбор одной строки результатов. null — строка не является раздачей. */
function parseRow(rowHtml: string, inner: string): RawReleaseRow | null {
  const links = [...inner.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: decodeEntities(m[1]),
    text: stripTags(m[2]),
  }));

  // Тема: сначала ссылка на viewtopic, затем — любая ссылка с t=<id>
  // (у части движков ссылка идёт прямо на download.php?t=<id>).
  const topic = links.find((l) => /viewtopic\.php/i.test(l.href) && /[?&]t=\d+/i.test(l.href));
  const anyTopic = topic || links.find((l) => /[?&]t=\d+/i.test(l.href));
  if (!anyTopic) return null;

  const idAttr = /id="trs-tr-(\d+)"/i.exec(rowHtml);
  const idHref = /[?&]t=(\d+)/i.exec(anyTopic.href);
  const id = (idAttr?.[1] || idHref?.[1] || "").trim();

  // Название — самая длинная ссылка темы (в строке есть и ссылки на раздел/автора).
  const titles = links
    .filter((l) => /viewtopic\.php/i.test(l.href))
    .map((l) => l.text)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const title = (titles[0] || anyTopic.text || "").replace(/\s+/g, " ").trim();
  if (!id || title.length < 3) return null;

  const rowText = stripTags(inner);
  const sizeMatch = /(\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB|B|ТБ|ГБ|МБ|КБ|Б))/i.exec(rowText);
  const sizeText = sizeMatch ? sizeMatch[1].replace(/\s+/g, " ") : "";

  // Сиды/личи: у rutracker это ячейки с классом seedmed/leechmed — берём их точно.
  const seedCell = /<td\b[^>]*class="[^"]*(?:seed|seeds)[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(inner);
  const leechCell = /<td\b[^>]*class="[^"]*(?:leech|leecher)[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(
    inner,
  );
  let seeders = seedCell ? firstNumber(stripTags(seedCell[1])) : 0;
  let leechers = leechCell ? firstNumber(stripTags(leechCell[1])) : 0;
  let downloads = 0;

  if (!seedCell || !leechCell) {
    // Общий случай: числовые ячейки сразу после колонки размера — это
    // [сиды, личи, скачали]. Порядок именно такой у phpBB-трекеров.
    const cells = cellsOf(inner).map((c) => stripTags(c));
    const sizeIdx = cells.findIndex(
      (c) => /(?:TB|GB|MB|KB|B|ТБ|ГБ|МБ|КБ|Б)/i.test(c) && /\d/.test(c),
    );
    const nums = cells
      .slice(sizeIdx >= 0 ? sizeIdx + 1 : 0)
      .filter((c) => /^\d[\d\s\u00A0]*$/.test(c.trim()))
      .map((c) => firstNumber(c));
    if (!seedCell) seeders = nums[0] ?? seeders;
    if (!leechCell) leechers = nums[1] ?? leechers;
    downloads = nums[2] ?? 0;
  }

  const magnetMatch = /(magnet:\?xt=urn:btih:[A-Za-z0-9]+[^"'\s<]*)/i.exec(decodeEntities(inner));
  const torrentMatch = /(?:dl|download|attach)\.php[^"']*?[?&](?:t|id)=(\d+)/i.exec(inner);

  return {
    id,
    title: decodeEntities(title),
    sizeText,
    sizeBytes: sizeToBytes(sizeText),
    seeders,
    leechers,
    downloads,
    magnet: magnetMatch ? magnetMatch[1].replace(/&amp;/g, "&") : null,
    torrentId: torrentMatch ? torrentMatch[1] : null,
  };
}

/**
 * Все строки-раздачи из HTML страницы результатов.
 * Заголовочные/служебные строки отбрасываются (нет id или названия темы).
 */
export function parseReleasesTable(html: unknown): RawReleaseRow[] {
  const src = String(html || "");
  if (!src) return [];
  const out: RawReleaseRow[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = parseRow(m[0], m[1]);
    if (!row) continue;
    if (seen.has(row.id)) continue; // одна строка на раздачу
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/* ======================= rutor.info (движок «rutor») ======================= */

/**
 * Разбор одной строки выдачи rutor.info.
 *
 * Разметка строки (проверено на живой странице /search/0/0/000/0/…):
 *
 *   <tr class="gai"><td>06&nbsp;Сен&nbsp;26</td>
 *     <td colspan = "2">
 *       <a class="downgif" href="//d.rutor.info/download/1105259">…</a>
 *       <a href="magnet:?xt=urn:btih:0655…&amp;dn=rutor.info&amp;tr=…">…</a>
 *       <a href="/torrent/1105259/bad-matrix-…">Название</a></td>
 *     <td align="right">82.73&nbsp;MB</td>
 *     <td align="center"><span class="green">…&nbsp;3</span>…<span class="red">&nbsp;0</span></td>
 *   </tr>
 *
 * Отличия от rutracker, которые важно учесть:
 *  - идентификатор раздачи — последний сегмент ссылки `/torrent/<id>/<slug>`;
 *  - .torrent отдаёт ДРУГОЙ хост (d.rutor.info), поэтому ссылку в строке
 *    достаточно распознать, а URL собирает скрапер по шаблону torrentPath;
 *  - «скачали» rutor не показывает (comments вместо него — не то же самое),
 *    поэтому downloads = 0;
 *  - у строки с комментариями появляется лишняя ячейка `<td>5<img …com.gif></td>`
 *    перед размером: размер ищем отдельной ячейкой с единицами измерения, а не
 *    «третью по счёту», иначе разбор сдвинется.
 */
function parseRutorRow(inner: string): RawReleaseRow | null {
  const text = decodeEntities(inner);

  // Тема: /torrent/<id>/<slug> (или /torrent/<id> без слага).
  const topic = /<a\b[^>]*href="\/torrent\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(text);
  if (!topic) return null;
  const id = topic[1];
  const title = stripTags(topic[2]).replace(/\s+/g, " ").trim();
  if (!id || title.length < 3) return null;

  // Размер: ячейка, содержимое которой — только число с единицей измерения
  // (6 Сен 26, счётчики и «5 комментариев» под это не подходят).
  const sizeCell = /<td\b[^>]*>\s*(\d+(?:[.,]\d+)?\s*(?:TB|GB|MB|KB|B|ТБ|ГБ|МБ|КБ|Б))\s*<\/td>/i.exec(
    text,
  );
  const sizeText = sizeCell ? sizeCell[1].replace(/\s+/g, " ") : "";

  // Сиды/личи: значения лежат в span.green (сиды) и span.red (личи).
  const seedCell = /<span\b[^>]*class="[^"]*\bgreen\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(text);
  const leechCell = /<span\b[^>]*class="[^"]*\bred\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(text);

  const magnet = /(magnet:\?xt=urn:btih:[A-Za-z0-9]+[^"'\s<]*)/i.exec(text);
  // .torrent: //d.rutor.info/download/<id> (протокол-относительная ссылка).
  const download = /\/download\/(\d+)/i.exec(text);

  return {
    id,
    title: decodeEntities(title),
    sizeText,
    sizeBytes: sizeToBytes(sizeText),
    seeders: seedCell ? firstNumber(stripTags(seedCell[1])) : 0,
    leechers: leechCell ? firstNumber(stripTags(leechCell[1])) : 0,
    downloads: 0,
    magnet: magnet ? magnet[1].replace(/&amp;/g, "&") : null,
    torrentId: download ? download[1] : null,
  };
}

/**
 * Все раздачи со страницы выдачи rutor.info. Строки-раздачи отмечены классами
 * gai/tum; строка заголовка таблицы — классом backgr, она отбрасывается.
 */
export function parseRutorRows(html: unknown): RawReleaseRow[] {
  const src = String(html || "");
  if (!src) return [];
  const out: RawReleaseRow[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/<tr\b[^>]*class="[^"]*\b(?:gai|tum)\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = parseRutorRow(m[1]);
    if (!row) continue;
    if (seen.has(row.id)) continue; // одна строка на раздачу
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Разбор выдачи по движку трекера: одна точка входа для скрапера.
 * Неизвестный движок = rutracker (поведение до появления пресетов).
 */
export function parseReleasesByEngine(html: unknown, engine: unknown): RawReleaseRow[] {
  return normEngine(engine) === "rutor" ? parseRutorRows(html) : parseReleasesTable(html);
}


/**
 * Скрытые поля формы входа (phpBB: creation_time, form_token, sid, redirect).
 * Их нужно вернуть обратно при POST — иначе форум не примет логин.
 */
export function parseHiddenInputs(html: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of String(html || "").matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    if (!name) continue;
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? "";
    out[decodeEntities(name)] = decodeEntities(value);
  }
  return out;
}

/** Идентификатор сессии phpBB: `?sid=<hex>` или скрытое поле `sid`. */
export function findSid(html: unknown): string | null {
  const src = String(html || "");
  const inUrl = /\bsid=([a-fA-F0-9]{6,40})/.exec(src);
  if (inUrl) return inUrl[1];
  const hidden = parseHiddenInputs(src).sid;
  return hidden || null;
}

/**
 * Страница-заглушка Cloudflare («Just a moment...», 403/503).
 *
 * Почему это отдельная проверка: rutracker.org закрыт Cloudflare Bot Management —
 * `tracker.php` и `login.php` с нештатного IP отдают челлендж вместо контента.
 * Раньше такая страница выглядела как «на странице нет формы входа» → считалась
 * «залогинены», и поиск падал с невнятным «изменилась разметка». Теперь это
 * отдельный код cf_challenge с понятной подсказкой.
 */
export function isCloudflareChallenge(html: unknown, status?: number): boolean {
  const s = String(html || "");
  if (!s) return false;
  if (/cf-mitigated\s*:\s*challenge/i.test(s)) return true;
  const marker = /(just a moment|attention required|__cf_chl|cf-chl-|checking your browser)/i.test(s);
  if (!marker) return false;
  // Любой ответ с маркерами CF, но без разметки форума (нет таблиц) — челлендж.
  const statusOk = status === undefined || [401, 403, 429, 503].includes(Number(status));
  return statusOk || !/<table|<form/i.test(s);
}

/**
 * Признаки живой авторизации (ссылка «Выход» и профиль). Используется как
 * дополнительная информация в диагностике: rutracker показывает «Выход [ник]»
 * со ссылкой login.php?logout=1.
 */
export function looksAuthorized(html: unknown): boolean {
  const s = String(html || "");
  return (
    /login\.php\?logout=1/i.test(s) ||
    /id="logged-in-username"/i.test(s) ||
    /profile\.php\?mode=viewprofile/i.test(s)
  );
}

/**
 * «Ничего не найдено» — чтобы отличить пустую выдачу (норма) от поломки
 * разбора (нужно сообщить parse_failed и показать диагностику).
 * Формулировки: rutracker («По вашему запросу ничего не найдено»), phpBB
 * («Не найдено», «Результатов поиска: 0»).
 */
export function looksLikeNoResults(html: unknown): boolean {
  return /(ничего не найдено|не найдено|нет подходящих|не дал результатов|результатов\s*поиска\s*[:—-]?\s*0\b|найдено\s*0\s|search\s+found\s+0|no\s+topics\s+found)/i.test(
    String(html || ""),
  );
}

/**
 * Короткая «выжимка» страницы для диагностики: видимый текст без тегов,
 * обрезанный до 300 символов (уходит в лог и в ответ API).
 */
export function pageSnippet(html: unknown, limit = 300): string {
  const text = stripTags(html).replace(/\s+/g, " ").trim();
  return text.slice(0, Math.max(0, limit));
}

/** Признак формы входа на странице: значит, сессия не авторизована. */
export function hasLoginForm(html: unknown): boolean {
  const src = String(html || "");
  // Поле login_username есть только в форме входа; action="login.php" — её же
  // признак. Ссылку «Выход» (login.php?logout=1) за форму не считаем.
  return /name="login_username"/i.test(src) || /<form[^>]*action="[^"]*login\.php"/i.test(src);
}
