/**
 * Скрейпер каталога comss.ru для страницы «Магазин»: рубрики → приложения →
 * прямые ссылки на установщики.
 *
 * Сайт отдаёт windows-1251, а внутри страниц есть и «зеркальные» ссылки на
 * один и тот же файл — обе тонкости зашиты здесь, потому что без них каталог
 * приходил бы кракозябрами, а ссылка вела бы не туда.
 *
 * TS-исходник, как server/ts/security.ts: компилируется в server/comss.js
 * командой `npm run compile:server`, поэтому `require("./comss")` из обычных
 * .js-модулей продолжает работать без изменений.
 */
import logger from "./logger";

const BASE = "https://www.comss.ru";

/** Рубрика каталога: код для list.php и подпись для UI. */
export interface ComssCategory {
  code: string;
  label: string;
}

/** Найденное приложение: имя, прямая ссылка и название рубрики. */
export interface ComssApp {
  name: string;
  url: string;
  category: string;
}

export const CATEGORIES: ComssCategory[] = [
  { code: "antivirus", label: "Антивирусы для Windows" },
  { code: "utils", label: "Утилиты" },
  { code: "browsers", label: "Браузеры и интернет" },
  { code: "messenger", label: "Мессенджеры" },
  { code: "video-audio", label: "Мультимедиа" },
  { code: "backup", label: "Резервное копирование" },
  { code: "recovery", label: "Восстановление данных" },
  { code: "system_tweak", label: "Оптимизация и настройка" },
  { code: "uninstall", label: "Удаление программ" },
  { code: "remote_access", label: "Удалённый доступ" },
  { code: "drivers", label: "Драйверы" },
  { code: "firewall", label: "Фаерволы" },
  { code: "security", label: "Программы безопасности" },
  { code: "aitools", label: "Искусственный интеллект" },
  { code: "virus_scanners", label: "Антивирусные сканеры" },
  { code: "bootcd", label: "Загрузочные диски" },
  { code: "antiransomware", label: "Защита от шифровальщиков" },
  { code: "online-antivirus", label: "Онлайн-антивирусы" },
  { code: "updates", label: "Обновления антивирусов" },
  { code: "securedns", label: "Безопасные DNS" },
  { code: "banking", label: "Интернет-банкинг" },
  { code: "bootmanager", label: "Загрузка и установка" },
  { code: "vm_apps", label: "Виртуальные машины" },
  { code: "mobilemanager", label: "Мобильные менеджеры" },
  { code: "diagnostics", label: "Диагностика" },
  { code: "storage", label: "Работа с дисками" },
  { code: "os", label: "Операционные системы" },
  { code: "2fa", label: "Двухфакторная аутентификация" },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,*/*", Referer: BASE + "/" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Сайт в windows-1251: если UTF-8 даёт кракозябры (символ замены), перекодируется в windows-1251.
  let text = buf.toString("utf8");
  if (text.includes("\uFFFD")) text = new TextDecoder("windows-1251").decode(buf);
  return text;
}

/** Рубрика: из html достаётся список {id, name}. */
export function parseList(html: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const re = /page\.php\?id=(\d+)[^>]*>([^<]{2,80})</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[2].trim();
    if (name && name.toLowerCase() !== "новое на сайте") out.push({ id: m[1], name });
  }
  return out;
}

/** Карточка: находится id страницы загрузки. */
function parseDownloadPageId(html: string): string | null {
  const m = html.match(/download\/page\.php\?id=(\d+)/);
  return m ? m[1] : null;
}

/** Страница загрузки: одна прямая ссылка (сначала зеркало dl.comss.org). */
export function parseDirectUrls(html: string): string | null {
  const urls: string[] = [];
  const re = /https?:\/\/[^"' ]+?\.(?:exe|msi|zip|7z)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = m[0];
    if (!urls.includes(u)) urls.push(u);
  }
  // Сначала беру зеркало dl.comss.org, потом dl.comss.ru
  return (
    urls.find((u) => u.includes("dl.comss.org")) ||
    urls.find((u) => u.includes("dl.comss.ru")) ||
    urls[0] ||
    null
  );
}

/**
 * Парсинг одной рубрики → [{name, url, category}].
 * limit ограничивает число карточек: «обновить каталог» не должно тянуть их сотни.
 */
export async function scrapeCategory(cat: ComssCategory, limit = 0): Promise<ComssApp[]> {
  const found: ComssApp[] = [];
  const cap = limit > 0 ? limit : Infinity; // 0/без лимита = парсим все карточки страницы
  let entries: { id: string; name: string }[];
  try {
    const listHtml = await fetchText(`${BASE}/list.php?c=${cat.code}`);
    entries = parseList(listHtml);
  } catch (e) {
    logger.warn("comss.list_error", { cat: cat.code, error: (e as Error).message });
    return found;
  }

  // Дубли по имени внутри категории отсеиваются
  const seen = new Set<string>();
  for (const entry of entries.slice(0, cap)) {
    if (seen.has(entry.name.toLowerCase())) continue;
    seen.add(entry.name.toLowerCase());
    try {
      const pageHtml = await fetchText(`${BASE}/page.php?id=${entry.id}`);
      const dlId = parseDownloadPageId(pageHtml);
      if (!dlId) continue;
      const dlHtml = await fetchText(`${BASE}/download/page.php?id=${dlId}`);
      const url = parseDirectUrls(dlHtml);
      if (url) found.push({ name: entry.name, url, category: cat.label });
    } catch (e) {
      logger.warn("comss.app_error", { id: entry.id, error: (e as Error).message });
    }
  }
  return found;
}

/** Парсинг сразу нескольких категорий. */
export async function scrape(categories: ComssCategory[], limit = 20): Promise<ComssApp[]> {
  const result: ComssApp[] = [];
  for (const cat of categories) {
    const items = await scrapeCategory(cat, limit);
    result.push(...items);
    logger.info("comss.category_done", { cat: cat.code, count: items.length });
  }
  logger.action("comss.scrape", {
    categories: categories.map((c) => c.code),
    total: result.length,
  });
  return result;
}

/** Прогресс скрейпа для UI: сколько рубрик пройдено и что уже найдено. */
export interface ComssProgress {
  done: number;
  total: number;
  current: string;
  items: ComssApp[];
}

/** То же, но с прогрессом onProgress после каждой рубрики. */
export async function scrapeWithProgress(
  categories: ComssCategory[],
  limit = 20,
  onProgress?: (p: ComssProgress) => void,
): Promise<ComssApp[]> {
  const result: ComssApp[] = [];
  let done = 0;
  for (const cat of categories) {
    onProgress?.({ done, total: categories.length, current: cat.label, items: result.slice() });
    const items = await scrapeCategory(cat, limit);
    result.push(...items);
    done++;
    onProgress?.({ done, total: categories.length, current: "", items: result.slice() });
  }
  logger.action("comss.scrape", {
    categories: categories.map((c) => c.code),
    total: result.length,
  });
  return result;
}
