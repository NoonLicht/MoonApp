/**
 * Закладки: storage/bookmarks.json. Опционально при сохранении можно
 * "отложить на чтение" (read-later) — сервер сам скачивает страницу,
 * грубо вычищает HTML в читаемый markdown-текст и кладёт как заметку в
 * Vault (папка "Read Later"), переиспользуя server/ts/myspace-vault.ts —
 * тот же движок, что и обычные заметки MySpace.
 */
import crypto from "crypto";
import fs from "fs";
import config from "./config";
import logger from "./logger";
import { writeFile as vaultWriteFile } from "./myspace-vault";
import { cleanupArticleText } from "./notesAi";

const { FILES } = config;

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  notes: string;
  tags: string[];
  folder: string;
  createdAt: number;
  updatedAt: number;
  articleNotePath: string | null;
  /** id уже готового архива .sitebak для быстрого повторного "Режима чтения"
   * без повторного обхода страницы (см. server/ts/sitebak.ts). */
  readerArchiveId: string | null;
}

function readAll(): Bookmark[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.bookmarks, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(items: Bookmark[]): void {
  fs.writeFileSync(FILES.bookmarks, JSON.stringify(items, null, 2), "utf8");
}

export function list(): Bookmark[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
}

function stripInlineTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Читаемое извлечение текста статьи без jsdom/readability (нет в зависимостях):
 *  сперва выкидываем заведомо служебные блоки (nav/header/footer/меню/скрипты/стили),
 *  затем берём ТОЛЬКО содержимое смысловых текстовых тегов (h1-h6/p/li/blockquote) —
 *  это само по себе отсеивает вёрстку меню, баннеров и подвала сайта, которая
 *  обычно лежит вне этих тегов (в голых <div>/<a>/<span>). */
function htmlToPlainText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, "");

  // Приоритет: если есть <article>, берём только его — почти всегда это и есть
  // основной текст материала без сайдбаров/рекомендаций.
  const articleMatch = s.match(/<article\b[\s\S]*?<\/article>/i);
  if (articleMatch) s = articleMatch[0];

  const blocks: string[] = [];
  const re = /<(h[1-6]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tag = m[1].toLowerCase();
    const text = stripInlineTags(m[2]);
    if (!text || text.length < 2) continue;
    // Отсекаем однословные пункты меню/тегов-ссылок, которые случайно попали в <li>.
    if (tag === "li" && text.split(/\s+/).length === 1 && text.length < 20) continue;
    blocks.push(/^h[1-6]$/.test(tag) ? `## ${text}` : text);
  }

  if (blocks.length < 2) {
    // Фоллбэк на случай нетипичной вёрстки без p/li — старое грубое поведение.
    let plain = s.replace(/<\/(p|div|h[1-6]|li|br|section|article|tr)>/gi, "\n");
    plain = plain.replace(/<br\s*\/?>/gi, "\n");
    plain = decodeEntities(plain.replace(/<[^>]+>/g, ""));
    plain = plain.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
    return plain.trim();
  }

  return blocks.join("\n\n").trim();
}

function extractTitle(html: string, fallback: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() || fallback : fallback;
}

/** Экспортируется в основном ради тестируемости (см. tests/bookmarks.test.ts) —
 * прямого HTTP-эндпоинта у неё больше нет, читаемый текст добывается только
 * при saveForLater/saveArticleFor. */
export async function fetchArticle(url: string): Promise<{ title: string; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let title: string;
  let text: string;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonApp/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    title = extractTitle(html, url);
    text = htmlToPlainText(html);
  } finally {
    clearTimeout(timeout);
  }
  // Грубый HTML→текст парсер выше цепляет остатки меню/рекламы/cookie-баннеров
  // мимо тегов nav/header/footer. Прогоняем через тот же ИИ-провайдер, что и
  // оформление заметок (ключ уже настроен в приложении, myspace-ai/AI-чат) —
  // убирает мусор, сам текст статьи не трогает. Если ИИ не настроен или упал —
  // тихо остаёмся с сырым вырезом, сохранение статьи не должно из-за этого падать.
  try {
    text = await cleanupArticleText(text, title, null);
  } catch (e) {
    logger.warn("bookmarks.ai_cleanup_failed", { url, error: (e as Error).message });
  }
  return { title, text };
}

function slugifyForFilename(s: string): string {
  return (
    s
      .replace(/[/\\?%*:|"<>]/g, "_")
      .trim()
      .slice(0, 80) || "article"
  );
}

export async function create(input: {
  title?: string;
  url: string;
  notes?: string;
  tags?: string[];
  folder?: string;
  saveForLater?: boolean;
}): Promise<Bookmark> {
  const now = Date.now();
  let title = String(input.title || "").trim();
  let articleNotePath: string | null = null;

  if (input.saveForLater) {
    try {
      const article = await fetchArticle(input.url);
      if (!title) title = article.title;
      const fileName = `Read Later/${slugifyForFilename(title)}.md`;
      const body = `# ${title}\n\nИсточник: ${input.url}\nСохранено: ${new Date(now).toLocaleString("ru-RU")}\n\n---\n\n${article.text}`;
      vaultWriteFile(fileName, body, { source: input.url, savedAt: now });
      articleNotePath = fileName;
    } catch (e) {
      logger.error("bookmarks.save_article_failed", { url: input.url, error: (e as Error).message });
      // Не роняем создание закладки целиком — просто без сохранённой статьи.
    }
  }

  if (!title) title = input.url;

  const entry: Bookmark = {
    id: crypto.randomUUID(),
    title,
    url: input.url,
    notes: String(input.notes || ""),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    folder: String(input.folder || ""),
    createdAt: now,
    updatedAt: now,
    articleNotePath,
    readerArchiveId: null,
  };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  logger.info("bookmarks.create", { id: entry.id, saveForLater: !!input.saveForLater });
  return entry;
}

export function update(
  id: string,
  input: Partial<{ title: string; notes: string; tags: string[]; folder: string }>,
): Bookmark | null {
  const all = readAll();
  const idx = all.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const cur = all[idx];
  const next: Bookmark = {
    ...cur,
    title: input.title !== undefined ? String(input.title) : cur.title,
    notes: input.notes !== undefined ? String(input.notes) : cur.notes,
    tags: input.tags !== undefined ? input.tags.map(String) : cur.tags,
    folder: input.folder !== undefined ? String(input.folder) : cur.folder,
    updatedAt: Date.now(),
  };
  all[idx] = next;
  writeAll(all);
  return next;
}

/** Запоминает id готового .sitebak-архива для этой закладки — при повторном
 * открытии "Режима чтения" не гонять обход страницы заново. */
export function setReaderArchive(id: string, archiveId: string): Bookmark | null {
  const all = readAll();
  const idx = all.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const next: Bookmark = { ...all[idx], readerArchiveId: archiveId };
  all[idx] = next;
  writeAll(all);
  return next;
}

/** Сохранить статью существующей закладки постфактум (кнопка "Скачать без
 * рекламы" на уже созданной закладке, которую сохранили без saveForLater). */
export async function saveArticleFor(id: string): Promise<Bookmark | null> {
  const all = readAll();
  const idx = all.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const b = all[idx];
  const article = await fetchArticle(b.url);
  const title = b.title || article.title;
  const fileName = `Read Later/${slugifyForFilename(title)}.md`;
  const body = `# ${title}\n\nИсточник: ${b.url}\nСохранено: ${new Date().toLocaleString("ru-RU")}\n\n---\n\n${article.text}`;
  vaultWriteFile(fileName, body, { source: b.url, savedAt: Date.now() });
  const next: Bookmark = { ...b, articleNotePath: fileName, updatedAt: Date.now() };
  all[idx] = next;
  writeAll(all);
  logger.info("bookmarks.save_article_later", { id });
  return next;
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  logger.info("bookmarks.remove", { id });
  return true;
}
