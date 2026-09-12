/**
 * Единый санитайзер HTML для всего чужого/пользовательского контента
 * (markdown чата, подсветка кода, заметки My Space).
 *
 * Как это работает: DOMPurify парсит строку в живой DOM и вырезает всё, что не
 * в белом списке: script/iframe/object/embed/style/srcdoc/base/form, inline
 * обработчики on*, javascript:-URL и т.д. (включая известные mXSS-трюки
 * против наивных регэксп-санитайзеров). data-* атрибуты остаются — на них
 * завязаны кликабельные WikiLinks/теги в рендерере заметок.
 */
import DOMPurify from "dompurify";

const config = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["srcdoc", "srcset"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

/* Кэш: санитайз вызывается на каждом рендере для одних и тех же строк
 * (markdown истории + подсветка кода), а DOMPurify парсит HTML в живой DOM —
 * это один из самых дорогих вызовов при стриминге. Ограниченный размер,
 * чтобы кэш не рос бесконечно. */
const CACHE_MAX = 600;
const cache = new Map<string, string>();

export function sanitizeHtml(html: string): string {
  const hit = cache.get(html);
  if (hit !== undefined) return hit;
  const out = DOMPurify.sanitize(html, config);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value; // Map хранит порядок вставки
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(html, out);
  return out;
}
