/**
 * Мини-сайт из заметок: набор статических HTML-страниц (без скриптов и
 * внешних зависимостей) с оглавлением и перекрёстными ссылками.
 *
 *  - приватные блоки вырезаются (stripPrivate), frontmatter скрывается;
 *  - сырой HTML из заметок не пропускается (экранируется);
 *  - [[Заметка]] / [[Заметка|подпись]] становятся ссылками, если заметка
 *    входит в сайт, иначе остаются текстом.
 */
// marked — ESM-пакет; из CommonJS-сборки он подключается обычным require с локальным типом.
const { marked } = require("marked") as {
  marked: {
    Renderer: new () => object;
    parse(src: string, opts: Record<string, unknown>): string;
  };
};
import { stripPrivate } from "./noteTools";

export interface SiteNote {
  path: string;
  title: string;
  content: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Имя файла страницы: безопасное, уникальное в рамках сайта. */
export function pageNames(notes: SiteNote[]): Map<string, string> {
  const used = new Set<string>(["index"]);
  const out = new Map<string, string>();
  for (const n of notes) {
    const base =
      n.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "note";
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    out.set(n.path, `${name}.html`);
  }
  return out;
}

const STYLE =
  "body{max-width:760px;margin:2rem auto;padding:0 1rem;font:17px/1.6 system-ui,sans-serif;color:#1c1f26;background:#fff}" +
  "a{color:#3563e9}pre,code{background:#f1f3f8;border-radius:4px}pre{padding:.8em;overflow:auto}code{padding:.05em .3em}" +
  "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #cfd4e0;padding:.3em .6em}" +
  "blockquote{margin:0;padding-left:1em;border-left:3px solid #cfd4e0;color:#4a5160}nav{margin-bottom:1.5rem;font-size:.9em}" +
  "@media(prefers-color-scheme:dark){body{background:#0f1117;color:#eceef5}pre,code{background:#1d2130}a{color:#8fb0ff}}";

function page(title: string, siteTitle: string, body: string, isIndex: boolean): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
${isIndex ? "" : `<nav><a href="index.html">← ${esc(siteTitle)}</a></nav>`}
${body}
</body></html>
`;
}

function renderMarkdown(md: string, links: Map<string, string>): string {
  const clean = stripPrivate(md).replace(/^---\n[\s\S]*?\n---\n/, "");
  const withLinks = clean.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const file = links.get(target.trim().toLowerCase());
    const text = (label ?? target).trim();
    return file ? `[${text}](${file})` : text;
  });
  return marked.parse(withLinks, {
    async: false,
    renderer: Object.assign(new marked.Renderer(), {
      // сырой HTML из заметки не пропускаем — только экранированный текст
      html: ({ text }: { text: string }) => esc(text),
    }),
  });
}

/** Файлы сайта: «index.html» и по странице на заметку. */
export function buildSite(notes: SiteNote[], siteTitle = "Заметки"): Record<string, string> {
  const names = pageNames(notes);
  const byTitle = new Map<string, string>();
  for (const n of notes) byTitle.set(n.title.toLowerCase(), names.get(n.path) as string);
  const files: Record<string, string> = {};
  for (const n of notes) {
    files[names.get(n.path) as string] = page(
      n.title,
      siteTitle,
      `<h1>${esc(n.title)}</h1>\n${renderMarkdown(n.content, byTitle)}`,
      false,
    );
  }
  const list = notes
    .map((n) => `<li><a href="${esc(names.get(n.path) as string)}">${esc(n.title)}</a></li>`)
    .join("\n");
  files["index.html"] = page(siteTitle, siteTitle, `<h1>${esc(siteTitle)}</h1>\n<ul>\n${list}\n</ul>`, true);
  return files;
}
