import { useEffect, useRef, useMemo } from "react";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { sanitizeHtml } from "@/lib/sanitize";

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {}
      }
      try {
        return hljs.highlightAuto(code).value;
      } catch {}
      return code;
    },
  }),
);

interface Props {
  content: string;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  onToggleCheckbox?: (lineIndex: number) => void;
}

// Применяет наши кастомные inline-замены (wikilinks, теги, math, highlight...)
// к одной строке. Вызывается только для строк вне code fence.
function processInline(l: string, lineIndex: number): string {
  const cb = l.match(/^(\s*(?:[-*+]\s+)?)\[([ xX])\]\s*(.*)/);
  if (cb) {
    const checked = cb[2].toLowerCase() === "x";
    return (
      `<span class="md-cb-row" data-line="${lineIndex}">` +
      `<span class="md-cb${checked ? " md-cb-checked" : ""}">${checked ? "✓" : ""}</span>` +
      `<span>${cb[3]}</span></span>`
    );
  }
  // Math block $$...$$ FIRST (before inline math)
  l = l.replace(/\$\$([^$]+)\$\$/g, '<code class="md-math-block">$1</code>');
  // Math inline $...$
  l = l.replace(/\$([^$]+)\$/g, '<code class="md-math">$1</code>');
  // Superscript ^text^
  l = l.replace(/\^([^^]+)\^/g, "<sup>$1</sup>");
  // Subscript ~text~
  l = l.replace(/(?<!~)~([^~\s][^~]*[^~\s])~(?!~)/g, "<sub>$1</sub>");
  // Highlight ==text== -> <mark>text</mark>
  l = l.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  // WikiLinks [[...]]
  l = l.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, title) => `<span class="md-wl" data-title="${title.replace(/"/g, "&quot;")}">${title}</span>`,
  );
  // #tags (не трогаем markdown-заголовки "# Title" в начале строки)
  l = l.replace(
    /(^|\s)(#[a-zA-Zа-яА-Я0-9_\-/]+)/g,
    (m, sp, tag, offset) => {
      if (offset === 0 && /^#{1,6}\s/.test(l)) return m;
      return `${sp}<span class="md-tg" data-tag="${tag}">${tag}</span>`;
    },
  );
  return l;
}

// Pre-process markdown content: convert interactive elements to HTML spans
// before marked parses them, skipping fenced code blocks and inline code so
// the code content itself is never mangled by our custom regexes.
// Строка похожа на разделитель GFM-таблицы: | --- | :--- | ---: |
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function preprocess(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMatch = raw.trimStart().match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
      }
      out.push(raw);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    // Строки таблиц пропускаем как есть: наши inline-регэкспы (sup/sub через
    // ^ и ~, math через $) ломают содержимое ячеек и marked перестаёт
    // распознавать GFM-таблицу, обрывая рендер остального документа.
    if (inTable) {
      if (raw.trim() === "" || !raw.includes("|")) {
        inTable = false;
      } else {
        out.push(raw);
        continue;
      }
    } else if (raw.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      inTable = true;
      out.push(raw);
      continue;
    }
    // Checkbox lines and headings are handled whole-line; everything else
    // gets inline processing that skips spans wrapped in inline `code`.
    if (/^(\s*(?:[-*+]\s+)?)\[([ xX])\]\s*(.*)/.test(raw) || /^\s{0,3}#{1,6}\s/.test(raw)) {
      out.push(processInline(raw, i));
      continue;
    }
    if (raw.includes("`")) {
      const segments = raw.split(/(`[^`]*`)/g);
      out.push(
        segments
          .map((seg) => (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? seg : processInline(seg, i)))
          .join(""),
      );
      continue;
    }
    out.push(processInline(raw, i));
  }
  return out.join("\n");
}

export default function MarkdownRenderer({
  content,
  onWikiLink,
  onTagClick,
  onToggleCheckbox,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    const preprocessed = preprocess(content);
    try {
      // marked.parseSync exists in v18+
      return marked.parse(preprocessed) as string;
    } catch {
      return `<p>${preprocessed}</p>`;
    }
  }, [content]);

  // Event delegation via useEffect
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (e: any) => {
      let target: any = e.target;
      // Walk up to find clickable span
      while (target && target !== el) {
        if (target.classList.contains("md-wl")) {
          e.preventDefault();
          const title = target.getAttribute("data-title");
          if (title && onWikiLink) onWikiLink(title);
          return;
        }
        if (target.classList.contains("md-tg")) {
          e.preventDefault();
          const tag = target.getAttribute("data-tag");
          if (tag && onTagClick) onTagClick(tag);
          return;
        }
        if (target.classList.contains("md-cb-row") || target.classList.contains("md-cb")) {
          e.preventDefault();
          const row = target.closest(".md-cb-row");
          if (row) {
            const line = row.getAttribute("data-line");
            if (line && onToggleCheckbox) onToggleCheckbox(parseInt(line, 10));
          }
          return;
        }
        target = target.parentElement;
      }
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [onWikiLink, onTagClick, onToggleCheckbox]);

  // К2: HTML прогоняется через DOMPurify —marked пропускает сырой HTML,
  // а свой регэксп-санитайзер не покрывал mXSS/style/srcdoc и т.п.
  return (
    <div
      ref={ref}
      className="md-renderer"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  );
}
