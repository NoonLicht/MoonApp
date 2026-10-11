/**
 * «Умная вставка» для редактора заметок: чужой текст приводится к виду документа.
 *  - HTML из браузера/Word/Google Docs → чистый Markdown (без шрифтов, размеров и цветов);
 *  - уровень заголовков подстраивается под ближайший заголовок выше курсора;
 *  - списки получают отступ текущего пункта, пустой пункт под курсором не дублируется;
 *  - обычный текст: маркеры «•», «1)», табы, лишние пустые строки приводятся к Markdown.
 * Нумерацию дальше выравнивает autoRenumberLists.
 */

export interface PasteContext {
  /** Отступ списка у строки с курсором ("" вне списка). */
  indent: string;
  /** Курсор стоит в пустом пункте списка («- » или «1. »): его маркер заменяем вставкой. */
  emptyItem: boolean;
  /** Уровень ближайшего заголовка выше курсора (0 — заголовков нет). */
  headingLevel: number;
  /** Курсор в начале (или на пустой строке) — вставка идёт отдельным блоком. */
  atLineStart: boolean;
}

const NBSP = new RegExp(String.fromCharCode(160), "g");
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "FIGURE", "FIGCAPTION"]);

function inline(node: Node): string {
  if (node.nodeType === 3) {
    return (node.nodeValue || "").replace(/\s+/g, " ").replace(NBSP, " ");
  }
  if (node.nodeType !== 1) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "META" || tag === "TITLE") return "";
  const kids = (): string => Array.from(el.childNodes).map(inline).join("");
  const wrap = (m: string): string => {
    const t = kids();
    const trimmed = t.trim();
    if (!trimmed) return t;
    const lead = t.slice(0, t.length - t.trimStart().length);
    const tail = t.slice(t.trimEnd().length);
    return `${lead}${m}${trimmed}${m}${tail}`;
  };
  switch (tag) {
    case "BR":
      return "\n";
    case "B":
    case "STRONG":
      return wrap("**");
    case "I":
    case "EM":
      return wrap("*");
    case "S":
    case "STRIKE":
    case "DEL":
      return wrap("~~");
    case "CODE":
      return el.closest("pre") ? kids() : wrap("`");
    case "A": {
      const href = el.getAttribute("href") || "";
      const t = kids().trim();
      if (!t) return "";
      return /^(https?:|mailto:|moon:)/i.test(href) ? `[${t}](${href})` : t;
    }
    case "IMG": {
      const src = el.getAttribute("src") || "";
      return /^https?:/i.test(src) ? `![${el.getAttribute("alt") || ""}](${src})` : "";
    }
    case "SPAN": {
      // Word/Docs обозначают жирный/курсив стилями на span
      const st = (el.getAttribute("style") || "").toLowerCase();
      const bold = /font-weight:\s*(bold|[6-9]00)/.test(st);
      const ital = /font-style:\s*italic/.test(st);
      let t = kids();
      if (t.trim() && bold) t = t.replace(/^(\s*)(.*?)(\s*)$/s, "$1**$2**$3");
      if (t.trim() && ital) t = t.replace(/^(\s*)(.*?)(\s*)$/s, "$1*$2*$3");
      return t;
    }
    default:
      return kids();
  }
}

function listToMd(list: HTMLElement, depth: number): string[] {
  const ordered = list.tagName === "OL";
  let n = Number(list.getAttribute("start")) || 1;
  const out: string[] = [];
  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") continue;
    const pad = "   ".repeat(depth);
    let text = "";
    const nested: string[] = [];
    for (const ch of Array.from(li.childNodes)) {
      if (ch.nodeType === 1 && (ch as HTMLElement).tagName.match(/^[OU]L$/)) {
        nested.push(...listToMd(ch as HTMLElement, depth + 1));
      } else if (ch.nodeType === 1 && BLOCK_TAGS.has((ch as HTMLElement).tagName)) {
        text += " " + inline(ch);
      } else text += inline(ch);
    }
    text = text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    const task = li.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null;
    const marker = ordered ? `${n++}.` : "-";
    out.push(`${pad}${marker} ${task ? (task.checked ? "[x] " : "[ ] ") : ""}${text}`.trimEnd());
    out.push(...nested);
  }
  return out;
}

function tableToMd(table: HTMLElement): string[] {
  const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TH" || c.tagName === "TD")
      .map((c) => inline(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()),
  );
  if (!rows.length || !rows[0].length) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const fmt = (r: string[]): string => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [fmt(rows[0]), `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`, ...rows.slice(1).map(fmt)];
}

function blocks(parent: Node, out: string[]): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      const t = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (t) out.push(t, "");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (["SCRIPT", "STYLE", "META", "TITLE", "HEAD"].includes(tag)) continue;
    if (/^H[1-6]$/.test(tag)) {
      const t = inline(el).replace(/\s+/g, " ").trim();
      if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t}`, "");
    } else if (tag === "UL" || tag === "OL") {
      out.push(...listToMd(el, 0), "");
    } else if (tag === "PRE") {
      out.push("```", (el.textContent || "").replace(/\n+$/, ""), "```", "");
    } else if (tag === "BLOCKQUOTE") {
      const inner: string[] = [];
      blocks(el, inner);
      const q = inner.join("\n").trim();
      if (q) out.push(q.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"), "");
    } else if (tag === "TABLE") {
      const t = tableToMd(el);
      if (t.length) out.push(...t, "");
    } else if (tag === "HR") {
      out.push("---", "");
    } else if (tag === "P" || (BLOCK_TAGS.has(tag) && !el.querySelector("p,ul,ol,table,pre,h1,h2,h3,h4,h5,h6,blockquote,div"))) {
      const t = inline(el).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("  \n");
      if (t) out.push(t, "");
    } else if (BLOCK_TAGS.has(tag) || tag === "BODY" || tag === "HTML" || tag === "TBODY" || tag === "FORM") {
      blocks(el, out);
    } else {
      const t = inline(el).replace(/\s+/g, " ").trim();
      if (t) out.push(t, "");
    }
  }
}

/** Есть ли в HTML-буфере реальная разметка (а не просто обёртка вокруг простого текста). */
export function looksRich(html: string): boolean {
  return /<(h[1-6]|ul|ol|li|table|strong|b|em|i|a|pre|blockquote|img|br)\b/i.test(html);
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Фрагмент из буфера обмена Windows оборачивается в <!--StartFragment-->…
  const out: string[] = [];
  blocks(doc.body, out);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Обычный текст → Markdown-совместимый вид: маркеры, табы, пустые строки. */
export function adaptPlainText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\s+$/g, "");
    // табы в начале → отступ из пробелов (по 3 на уровень — хватает для «1. »)
    line = line.replace(/^(\t+)/, (m) => "   ".repeat(m.length));
    // типографские маркеры → «-»
    line = line.replace(/^(\s*)[•·●▪■◦–—]\s+/, "$1- ");
    // «1)» и «1 .» → «1.»
    line = line.replace(/^(\s*)(\d{1,3})\s?[)\]]\s+/, "$1$2. ");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

const HEADING = /^(#{1,6})\s+/;

/** Сдвигает уровни заголовков так, чтобы самый верхний вставленный стал на уровень ниже заголовка выше курсора. */
function fitHeadings(md: string, base: number): string {
  if (!base) return md;
  const lines = md.split("\n");
  let inFence = false;
  let min = 7;
  for (const l of lines) {
    if (/^```/.test(l)) inFence = !inFence;
    const m = !inFence && HEADING.exec(l);
    if (m) min = Math.min(min, m[1].length);
  }
  if (min === 7) return md;
  const target = Math.min(6, base + 1);
  const shift = target - min;
  if (shift === 0) return md;
  inFence = false;
  return lines
    .map((l) => {
      if (/^```/.test(l)) inFence = !inFence;
      const m = !inFence && HEADING.exec(l);
      if (!m) return l;
      return "#".repeat(Math.min(6, Math.max(1, m[1].length + shift))) + l.slice(m[1].length);
    })
    .join("\n");
}

/** Приводит готовый Markdown к месту вставки: заголовки, отступ списка, пустой пункт. */
export function fitToContext(md: string, ctx: PasteContext): string {
  let t = fitHeadings(md, ctx.headingLevel);
  const lines = t.split("\n");
  const first = lines[0] ?? "";
  const startsList = /^\s*([-*+]|\d+[.)])\s/.test(first);
  if (ctx.indent && lines.length > 1) {
    // Всё, кроме первой строки (она встаёт сразу после курсора), сдвигаем на отступ текущего пункта.
    t = [lines[0], ...lines.slice(1).map((l) => (l.trim() ? ctx.indent + l : l))].join("\n");
  }
  if (ctx.emptyItem && startsList) {
    // Курсор в пустом пункте, а вставляется список: маркер вставки заменяет пустой маркер.
    t = t.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
  }
  return t;
}
