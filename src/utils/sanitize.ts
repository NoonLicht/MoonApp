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

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, config);
}
