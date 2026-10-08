/**
 * Chandra OCR 2 → Markdown. Модель отвечает HTML-блоками `<div data-bbox="x0 y0 x1 y1" data-label="…">`
 * (координаты 0–1000). Текст, списки, таблицы и формулы превращаются в Markdown, а блоки-рисунки
 * (Image / Figure / Diagram) вырезаются из исходной картинки и подставляются как `![…](url)`.
 * Разбор повторяет логику chandra/output.py (Apache-2.0), но без Python-зависимостей.
 */

export type Bbox = [number, number, number, number];

/** Вырезать область картинки (координаты 0–1000) и вернуть ссылку на сохранённый файл. */
export type CropFn = (bbox: Bbox) => Promise<string | null>;

const IMAGE_LABELS = new Set(["Image", "Figure", "Diagram"]);
const SKIP_LABELS = new Set(["Blank-Page", "Page-Header", "Page-Footer"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "ul",
  "ol",
  "table",
  "pre",
  "hr",
]);

const squash = (s: string): string => s.replace(/\s+/g, " ");

/** Пробелы по краям выносим наружу разметки: `** жирный **` в Markdown не работает. */
function wrap(inner: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m || !m[2]) return inner;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function inlineNode(n: Node, cell: boolean): string {
  if (n.nodeType === Node.TEXT_NODE) return squash(n.textContent ?? "");
  if (n.nodeType !== Node.ELEMENT_NODE) return "";
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  const inner = (): string => inlineChildren(el, cell);
  switch (tag) {
    case "br":
      return cell ? "<br>" : "  \n";
    case "b":
    case "strong":
      return wrap(inner(), "**");
    case "i":
    case "em":
      return wrap(inner(), "*");
    case "u":
      return wrap(inner(), "<u>", "</u>");
    case "del":
      return wrap(inner(), "~~");
    case "sup":
      return wrap(inner(), "<sup>", "</sup>");
    case "sub":
      return wrap(inner(), "<sub>", "</sub>");
    case "code":
      return wrap(el.textContent ?? "", "`");
    case "chem":
      return wrap(el.textContent ?? "", "`");
    case "math": {
      const tex = (el.textContent ?? "").trim();
      if (!tex) return "";
      return el.getAttribute("display") === "block" && !cell
        ? `\n\n$$\n${tex}\n$$\n\n`
        : `$${tex}$`;
    }
    case "a": {
      const href = el.getAttribute("href");
      const text = inner().trim();
      return href && text ? `[${text}](${href})` : text;
    }
    case "input": {
      const type = el.getAttribute("type");
      return type === "checkbox" || type === "radio"
        ? el.hasAttribute("checked")
          ? "[x] "
          : "[ ] "
        : "";
    }
    case "img":
      return "";
    case "li":
      return `• ${inner().trim()} `;
    case "p":
    case "div":
      return `${inner()} `;
    default:
      return inner();
  }
}

function inlineChildren(el: Node, cell: boolean): string {
  let out = "";
  el.childNodes.forEach((c) => {
    out += inlineNode(c, cell);
  });
  return out;
}

// ─────────────────────────────── таблицы ───────────────────────────────

function tableMd(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const grid: string[][] = [];
  rows.forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    Array.from(tr.children).forEach((cellEl) => {
      if (!/^t[dh]$/i.test(cellEl.tagName)) return;
      while (grid[r][c] !== undefined) c++;
      const text = inlineChildren(cellEl, true)
        .replace(/\s+/g, " ")
        .replace(/(<br>\s*)+$/g, "")
        .replace(/\|/g, "\\|")
        .trim();
      const cs = Math.max(1, parseInt(cellEl.getAttribute("colspan") || "1", 10) || 1);
      const rs = Math.max(1, parseInt(cellEl.getAttribute("rowspan") || "1", 10) || 1);
      for (let dr = 0; dr < rs; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = dr === 0 && dc === 0 ? text : "";
      }
      c += cs;
    });
  });
  const width = Math.max(...grid.map((r) => r.length));
  if (!width) return "";
  const line = (r: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const body = grid.filter((r) => r).map(line);
  const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  const cap = table.querySelector("caption");
  const caption = cap ? `${inlineChildren(cap, false).trim()}\n\n` : "";
  return `${caption}${[body[0], sep, ...body.slice(1)].join("\n")}`;
}

// ─────────────────────────────── блоки ───────────────────────────────

function listMd(list: Element, depth: number): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const pad = "  ".repeat(depth);
  let n = parseInt(list.getAttribute("start") || "1", 10) || 1;
  const lines: string[] = [];
  Array.from(list.children).forEach((li) => {
    if (li.tagName.toLowerCase() !== "li") return;
    let text = "";
    const nested: string[] = [];
    li.childNodes.forEach((c) => {
      if (c.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/i.test((c as Element).tagName))
        nested.push(listMd(c as Element, depth + 1));
      else text += inlineNode(c, false);
    });
    text = text.replace(/\s+/g, " ").trim();
    const task = /^\[( |x)\]\s*/.exec(text);
    const marker = ordered ? `${n++}. ` : "- ";
    lines.push(`${pad}${marker}${task ? `[${task[1]}] ${text.slice(task[0].length)}` : text}`);
    lines.push(...nested);
  });
  return lines.join("\n");
}

function blockNode(n: Node, depth = 0): string {
  if (n.nodeType !== Node.ELEMENT_NODE) return "";
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  if (/^h[1-5]$/.test(tag)) {
    const t = inlineChildren(el, false).replace(/\s+/g, " ").trim();
    return t ? `${"#".repeat(Number(tag[1]))} ${t}` : "";
  }
  switch (tag) {
    case "p":
      return inlineChildren(el, false)
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    case "ul":
    case "ol":
      return listMd(el, depth);
    case "table":
      return tableMd(el);
    case "pre":
      return `\`\`\`\n${(el.textContent ?? "").replace(/\n+$/, "")}\n\`\`\``;
    case "hr":
      return "---";
    case "div":
      return childrenMd(el, depth);
    default:
      return inlineNode(el, false).trim();
  }
}

/** Дети в виде блоков: подряд идущие «строчные» узлы собираются в один абзац. */
function childrenMd(el: Element, depth: number): string {
  const parts: string[] = [];
  let run = "";
  const flush = (): void => {
    const t = run.replace(/[ \t]+\n/g, "\n").trim();
    if (t) parts.push(t);
    run = "";
  };
  el.childNodes.forEach((c) => {
    if (c.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((c as Element).tagName.toLowerCase())) {
      flush();
      const md = blockNode(c, depth);
      if (md) parts.push(md);
    } else run += inlineNode(c, false);
  });
  flush();
  return parts.join("\n\n");
}

const parseBbox = (v: string | null): Bbox | null => {
  const a = (v ?? "").trim().split(/\s+/).map(Number);
  return a.length === 4 && a.every(Number.isFinite) ? (a as Bbox) : null;
};

const cleanAlt = (s: string): string =>
  s
    .replace(/[[\]\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** HTML ответа модели → Markdown. */
export async function chandraToMarkdown(html: string, crop: CropFn): Promise<string> {
  // Модель иногда оборачивает ответ в ```html … ```.
  const clean = html.replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "");
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const tops = Array.from(doc.body.children);
  const out: string[] = [];
  for (const el of tops) {
    const label = el.getAttribute("data-label") ?? "";
    if (SKIP_LABELS.has(label)) continue;
    if (IMAGE_LABELS.has(label)) {
      const img = el.querySelector("img");
      const alt = cleanAlt(img?.getAttribute("alt") || el.textContent || "");
      const bbox = parseBbox(el.getAttribute("data-bbox"));
      const url = bbox ? await crop(bbox) : null;
      out.push(url ? `![${alt}](${url})` : alt ? `*${alt}*` : "");
      // Данные графика или таблица внутри рисунка остаются текстом под ним.
      el.querySelectorAll("table").forEach((t) => out.push(tableMd(t)));
      continue;
    }
    const md = blockNode(el);
    if (md) out.push(md);
  }
  const md = out
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Ответ без блоков (чистый текст) или блок-рисунок без подписи не должен давать пустоту.
  return md || (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
