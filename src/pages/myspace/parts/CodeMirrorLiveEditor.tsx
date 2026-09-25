import { useEffect, useRef } from "react";
import { EditorState, RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";
import { sanitizeHtml } from "@/lib/sanitize";

interface Props {
  content: string;
  onChange: (v: string) => void;
  spellCheck?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  onToggleCheckbox?: (lineIndex: number) => void;
  /** Ctrl+V со скриншотом/картинкой в буфере: грузит blob и отдаёт markdown
   * ("![alt](url)") для вставки прямо в позицию курсора. null — не картинка/ошибка. */
  onPasteImage?: (blob: Blob) => Promise<string | null>;
}

/* ─── Виджет чекбокса: заменяет "[ ] "/"[x] " кликабельной галочкой ─── */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly lineIndex: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.lineIndex === this.lineIndex;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-live-checkbox" + (this.checked ? " is-checked" : "");
    span.textContent = this.checked ? "✓" : "";
    span.setAttribute("data-line", String(this.lineIndex));
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/* ─── Виджет картинки: заменяет "![alt](src)" превью-изображением ─── */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-live-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.onerror = () => {
      img.classList.add("is-broken");
    };
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

/* ─── Виджет горизонтальной линии: заменяет "---"/"***"/"___" строкой-разделителем ─── */
class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-live-hr";
    return div;
  }
  ignoreEvent() {
    return false;
  }
}

/* ─── Виджет отрендеренной GFM-таблицы: показываем настоящую <table>, пока
   курсор не внутри блока таблицы (тогда видно сырой markdown для правки) ─── */
class TableWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.html === this.html;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-live-table";
    div.innerHTML = sanitizeHtml(this.html);
    return div;
  }
  ignoreEvent() {
    return false;
  }
}

function isTableSeparatorLine(s: string): boolean {
  const v = s.trim();
  if (!v.includes("-") || !v.includes("|")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(v);
}

interface TableBlock {
  from: number;
  to: number;
  /** Граница ЗАМЕНЯЮЩЕЙ block-декорации — CodeMirror требует, чтобы блочный
   * Decoration.replace начинался и заканчивался на границе строки (включая её
   * перевод строки), иначе разметка ниже виджета уезжает/схлопывается. Если
   * таблица — последние строки документа, естественной границы следующей
   * строки нет, тогда берём конец документа. */
  blockTo: number;
  fromLine: number;
  toLine: number;
  source: string;
}

function findTableBlocks(doc: Text): TableBlock[] {
  const blocks: TableBlock[] = [];
  let ln = 1;
  while (ln <= doc.lines) {
    const line = doc.line(ln);
    const next = ln + 1 <= doc.lines ? doc.line(ln + 1) : null;
    if (line.text.includes("|") && next && isTableSeparatorLine(next.text)) {
      const startLn = ln;
      let endLn = ln + 1;
      while (endLn + 1 <= doc.lines) {
        const peek = doc.line(endLn + 1);
        if (!peek.text.trim() || !peek.text.includes("|")) break;
        endLn++;
      }
      const fromLine = doc.line(startLn);
      const toLine = doc.line(endLn);
      const blockTo = endLn + 1 <= doc.lines ? doc.line(endLn + 1).from : doc.length;
      blocks.push({
        from: fromLine.from,
        to: toLine.to,
        blockTo,
        fromLine: startLn,
        toLine: endLn,
        source: doc.sliceString(fromLine.from, toLine.to),
      });
      ln = endLn + 1;
      continue;
    }
    ln++;
  }
  return blocks;
}

/* ─── Разметка подсветки code fence / markdown-токенов CodeMirror'а под палитру приложения ─── */
const liveHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600", color: "var(--text-primary)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600", color: "var(--text-primary)" },
  { tag: t.strong, fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", opacity: 0.7 },
  { tag: t.link, color: "var(--amber)", textDecoration: "underline" },
  { tag: t.url, color: "var(--amber)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--teal, var(--amber))" },
  { tag: t.quote, color: "var(--text-secondary)", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "var(--text-tertiary)" },
  { tag: t.processingInstruction, color: "var(--text-tertiary)" },
  { tag: t.meta, color: "var(--text-tertiary)" },
  { tag: t.keyword, color: "var(--violet, var(--amber))" },
  { tag: t.string, color: "var(--teal, var(--amber))" },
  { tag: t.comment, color: "var(--text-tertiary)", fontStyle: "italic" },
  { tag: t.number, color: "var(--amber)" },
]);

/* ─── Инлайн-декорации по строкам: активная (с курсором) строка остаётся
   сырым markdown, остальные — «живой» текст с маскировкой служебных
   символов (**, #, ` и т.п.), как в Obsidian. Простой построчный regex,
   а не полный AST — быстрее и достаточно для практики. ─── */
const INLINE_RE =
  /(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(`([^`\n]+)`)|(~~([^~\n]+)~~)|(==([^=\n]+)==)|(\[\[([^\]\n]+)\]\])|(!\[([^\]\n]*)\]\(([^)\n]+)\))|(\[([^\]\n]+)\]\(([^)\n]+)\))|(#[a-zA-Zа-яА-Я0-9_\-/]+)/g;

function buildLiveDecorations(
  view: EditorView,
  onToggleCheckbox?: (i: number) => void,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  let inFence = false;
  const tableBlocks = findTableBlocks(view.state.doc);

  for (let ln = 1; ln <= view.state.doc.lines; ln++) {
    const line = view.state.doc.line(ln);
    const text = line.text;

    const tb = tableBlocks.find((b) => b.fromLine === ln);
    if (tb && (activeLine < tb.fromLine || activeLine > tb.toLine)) {
      let html = "";
      try {
        html = marked.parse(tb.source) as string;
      } catch {
        // оставляем html пустым — ниже упадём обратно на сырой текст блока
      }
      if (html) {
        builder.add(tb.from, tb.blockTo, Decoration.replace({ widget: new TableWidget(html), block: true }));
        ln = tb.toLine;
        continue;
      }
    }

    const isFenceMark = /^\s*(```+|~~~+)/.test(text);
    if (isFenceMark) {
      const opening = !inFence;
      inFence = !inFence;
      builder.add(
        line.from,
        line.from,
        Decoration.line({ attributes: { class: opening ? "cm-live-fence-open" : "cm-live-fence-close" } }),
      );
      continue;
    }
    if (inFence) {
      builder.add(line.from, line.from, Decoration.line({ attributes: { class: "cm-live-fence-line" } }));
      continue;
    }

    // Горизонтальная линия "---"/"***"/"___"
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text) && text.trim().length >= 3) {
      if (ln !== activeLine) {
        builder.add(line.from, line.to, Decoration.replace({ widget: new HrWidget() }));
        continue;
      }
    }

    if (ln === activeLine) continue; // активная строка — сырой текст без маскировки

    let bodyFrom = line.from;

    // Заголовок: прячем "### " целиком (сама подсветка размера — через lang-markdown HighlightStyle)
    const h = text.match(/^(#{1,6})\s+/);
    if (h) {
      builder.add(line.from, line.from + h[0].length, Decoration.replace({}));
      bodyFrom = line.from + h[0].length;
    }

    // Чекбокс "- [ ] "/"- [x] " → виджет
    const cb = text.match(/^(\s*(?:[-*+]\s+)?)\[([ xX])\]\s?/);
    if (cb) {
      const cbEnd = line.from + cb[0].length;
      builder.add(
        line.from,
        cbEnd,
        Decoration.replace({
          widget: new CheckboxWidget(cb[2].toLowerCase() === "x", ln - 1),
        }),
      );
      bodyFrom = cbEnd;
    } else {
      // маркеры списков "- "/"* "/"1. " приглушаем цветом, не прячем (нужны для структуры)
      const listM = text.match(/^\s*([-*+]|\d+\.)\s+/);
      if (listM) {
        builder.add(
          line.from,
          line.from + listM[0].length,
          Decoration.mark({ class: "cm-live-list-marker" }),
        );
      }
      // цитата "> "
      const qm = text.match(/^\s*>+\s?/);
      if (qm) {
        builder.add(line.from, line.from + qm[0].length, Decoration.mark({ class: "cm-live-quote-marker" }));
      }
    }

    // Инлайн-разметка внутри остатка строки
    const bodyOffset = bodyFrom - line.from;
    const body = text.slice(bodyOffset);
    INLINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_RE.exec(body))) {
      const from = line.from + bodyOffset + m.index;
      const to = from + m[0].length;
      if (m[1]) {
        // **bold**
        builder.add(from, from + 2, Decoration.replace({}));
        builder.add(from + 2, to - 2, Decoration.mark({ class: "cm-live-bold" }));
        builder.add(to - 2, to, Decoration.replace({}));
      } else if (m[3]) {
        // __bold__
        builder.add(from, from + 2, Decoration.replace({}));
        builder.add(from + 2, to - 2, Decoration.mark({ class: "cm-live-bold" }));
        builder.add(to - 2, to, Decoration.replace({}));
      } else if (m[5]) {
        // *italic*
        builder.add(from, from + 1, Decoration.replace({}));
        builder.add(from + 1, to - 1, Decoration.mark({ class: "cm-live-italic" }));
        builder.add(to - 1, to, Decoration.replace({}));
      } else if (m[7]) {
        // `code`
        builder.add(from, from + 1, Decoration.replace({}));
        builder.add(from + 1, to - 1, Decoration.mark({ class: "cm-live-code" }));
        builder.add(to - 1, to, Decoration.replace({}));
      } else if (m[9]) {
        // ~~strike~~
        builder.add(from, from + 2, Decoration.replace({}));
        builder.add(from + 2, to - 2, Decoration.mark({ class: "cm-live-strike" }));
        builder.add(to - 2, to, Decoration.replace({}));
      } else if (m[11]) {
        // ==mark==
        builder.add(from, from + 2, Decoration.replace({}));
        builder.add(from + 2, to - 2, Decoration.mark({ class: "cm-live-mark" }));
        builder.add(to - 2, to, Decoration.replace({}));
      } else if (m[13]) {
        // [[wikilink]]
        builder.add(from, from + 2, Decoration.replace({}));
        builder.add(
          from + 2,
          to - 2,
          Decoration.mark({ class: "cm-live-wikilink", attributes: { "data-wikilink": m[14] } }),
        );
        builder.add(to - 2, to, Decoration.replace({}));
      } else if (m[15]) {
        // ![alt](src)
        builder.add(from, to, Decoration.replace({ widget: new ImageWidget(m[17], m[16] || "") }));
      } else if (m[18]) {
        // [text](url)
        builder.add(from, from + 1, Decoration.replace({}));
        builder.add(
          from + 1,
          from + 1 + m[19].length,
          Decoration.mark({ class: "cm-live-link", attributes: { "data-href": m[20] } }),
        );
        builder.add(from + 1 + m[19].length, to, Decoration.replace({}));
      } else if (m[21]) {
        // #tag
        builder.add(from, to, Decoration.mark({ class: "cm-live-tag", attributes: { "data-tag": m[21] } }));
      }
    }
  }

  void onToggleCheckbox;
  return builder.finish();
}

function livePreviewPlugin(onToggleCheckbox?: (i: number) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLiveDecorations(view, onToggleCheckbox);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildLiveDecorations(u.view, onToggleCheckbox);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Живой построчный редактор markdown (Obsidian-style live preview) на
 * CodeMirror 6: строка под курсором — сырой markdown, остальные строки —
 * отрендеренное форматирование прямо внутри редактора (не отдельная панель
 * превью). Тема — через CSS-переменные приложения, поэтому визуально не
 * отличается от остального интерфейса.
 */
export default function CodeMirrorLiveEditor({
  content,
  onChange,
  spellCheck,
  readOnly,
  onWikiLink,
  onTagClick,
  onToggleCheckbox,
  onPasteImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastEmitted = useRef(content);
  const callbacksRef = useRef({ onWikiLink, onTagClick, onToggleCheckbox, onPasteImage });

  useEffect(() => {
    callbacksRef.current = { onWikiLink, onTagClick, onToggleCheckbox, onPasteImage };
  }, [onWikiLink, onTagClick, onToggleCheckbox, onPasteImage]);

  useEffect(() => {
    if (!hostRef.current) return;

    const theme = EditorView.theme(
      {
        "&": {
          color: "var(--text-primary)",
          backgroundColor: "transparent",
          height: "100%",
          fontSize: "14px",
        },
        ".cm-content": {
          fontFamily: "var(--font-mono)",
          lineHeight: "1.6",
          padding: "20px 24px",
          caretColor: "var(--amber)",
        },
        ".cm-scroller": { overflow: "auto" },
        "&.cm-focused": { outline: "none" },
        ".cm-gutters": { display: "none" },
        ".cm-live-bold": { fontWeight: "700", color: "var(--text-primary)" },
        ".cm-live-italic": { fontStyle: "italic" },
        ".cm-live-code": {
          fontFamily: "var(--font-mono)",
          background: "var(--track, rgba(255,255,255,0.06))",
          borderRadius: "4px",
          padding: "0 4px",
        },
        ".cm-live-strike": { textDecoration: "line-through", opacity: "0.65" },
        ".cm-live-mark": { background: "var(--amber-soft)", borderRadius: "2px" },
        ".cm-live-wikilink": {
          color: "var(--amber)",
          cursor: "pointer",
          textDecoration: "underline",
          textDecorationStyle: "dotted",
        },
        ".cm-live-tag": {
          color: "var(--amber)",
          cursor: "pointer",
        },
        ".cm-live-link": {
          color: "var(--amber)",
          cursor: "pointer",
          textDecoration: "underline",
        },
        ".cm-live-image": {
          display: "block",
          maxWidth: "100%",
          maxHeight: "420px",
          borderRadius: "8px",
          border: "1px solid var(--glass-border)",
          margin: "4px 0",
        },
        ".cm-live-image.is-broken": {
          display: "inline-block",
          minWidth: "120px",
          minHeight: "28px",
          background: "var(--track, rgba(255,255,255,0.06))",
        },
        ".cm-live-hr": {
          height: "1px",
          background: "var(--glass-border)",
          margin: "14px 0",
        },
        ".cm-live-fence-open": {
          background: "var(--track, rgba(255,255,255,0.05))",
          borderTop: "1px solid var(--glass-border)",
          borderLeft: "1px solid var(--glass-border)",
          borderRight: "1px solid var(--glass-border)",
          borderTopLeftRadius: "8px",
          borderTopRightRadius: "8px",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          paddingTop: "4px",
        },
        ".cm-live-fence-close": {
          background: "var(--track, rgba(255,255,255,0.05))",
          borderBottom: "1px solid var(--glass-border)",
          borderLeft: "1px solid var(--glass-border)",
          borderRight: "1px solid var(--glass-border)",
          borderBottomLeftRadius: "8px",
          borderBottomRightRadius: "8px",
          paddingBottom: "4px",
        },
        ".cm-live-fence-line": {
          background: "var(--track, rgba(255,255,255,0.05))",
          borderLeft: "1px solid var(--glass-border)",
          borderRight: "1px solid var(--glass-border)",
          fontFamily: "var(--font-mono)",
        },
        ".cm-live-table": {
          margin: "8px 0",
        },
        ".cm-live-table table": {
          width: "100%",
          borderCollapse: "collapse",
          border: "1px solid var(--glass-border)",
          fontSize: "13px",
        },
        ".cm-live-table th, .cm-live-table td": {
          border: "1px solid var(--glass-border)",
          padding: "6px 10px",
          textAlign: "left",
        },
        ".cm-live-table th": {
          background: "var(--track, rgba(255,255,255,0.06))",
          fontWeight: "600",
        },
        ".cm-live-list-marker": { color: "var(--text-tertiary)" },
        ".cm-live-quote-marker": { color: "var(--text-tertiary)" },
        ".cm-live-checkbox": {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "15px",
          height: "15px",
          marginRight: "6px",
          borderRadius: "4px",
          border: "1px solid var(--glass-border)",
          fontSize: "11px",
          lineHeight: "1",
          cursor: "pointer",
          verticalAlign: "middle",
          color: "var(--bg-base, #12121a)",
        },
        ".cm-live-checkbox.is-checked": {
          background: "var(--amber)",
          borderColor: "var(--amber)",
        },
      },
      { dark: true },
    );

    const clickHandler = EditorView.domEventHandlers({
      mousedown(e) {
        const target = e.target as HTMLElement;
        const wiki = target.closest(".cm-live-wikilink") as HTMLElement | null;
        if (wiki) {
          const title = wiki.getAttribute("data-wikilink");
          if (title && callbacksRef.current.onWikiLink) {
            e.preventDefault();
            callbacksRef.current.onWikiLink(title);
            return true;
          }
        }
        const tag = target.closest(".cm-live-tag") as HTMLElement | null;
        if (tag) {
          const val = tag.getAttribute("data-tag");
          if (val && callbacksRef.current.onTagClick) {
            e.preventDefault();
            callbacksRef.current.onTagClick(val);
            return true;
          }
        }
        const cbEl = target.closest(".cm-live-checkbox") as HTMLElement | null;
        if (cbEl) {
          const li = cbEl.getAttribute("data-line");
          if (li != null && callbacksRef.current.onToggleCheckbox) {
            e.preventDefault();
            callbacksRef.current.onToggleCheckbox(parseInt(li, 10));
            return true;
          }
        }
        const link = target.closest(".cm-live-link") as HTMLElement | null;
        if (link) {
          const href = link.getAttribute("data-href");
          if (href) {
            e.preventDefault();
            if (/^https?:\/\//i.test(href) && window.appBridge?.openExternal) {
              void window.appBridge.openExternal(href);
            } else if (/^https?:\/\//i.test(href)) {
              window.open(href, "_blank", "noopener");
            }
            return true;
          }
        }
        return false;
      },
      paste(e, view) {
        if (!callbacksRef.current.onPasteImage) return false;
        const items = e.clipboardData?.items;
        if (!items) return false;
        let imageItem: DataTransferItem | null = null;
        for (const it of items) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            imageItem = it;
            break;
          }
        }
        if (!imageItem) return false;
        e.preventDefault();
        const blob = imageItem.getAsFile();
        if (!blob) return true;
        const insertAt = view.state.selection.main.from;
        const insertTo = view.state.selection.main.to;
        callbacksRef.current
          .onPasteImage(blob)
          .then((md) => {
            if (!md) return;
            view.dispatch({
              changes: { from: insertAt, to: insertTo, insert: md },
              selection: { anchor: insertAt + md.length },
            });
          })
          .catch(() => {});
        return true;
      },
    });

    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ codeLanguages: languages, extensions: [GFM] }),
      syntaxHighlighting(liveHighlight),
      livePreviewPlugin(onToggleCheckbox),
      clickHandler,
      theme,
      EditorView.lineWrapping,
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ spellcheck: spellCheck ? "true" : "false" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const v = u.state.doc.toString();
          lastEmitted.current = v;
          onChange(v);
        }
      }),
    ];

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    lastEmitted.current = content;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Пересоздаём редактор только при смене файла/readOnly — остальное (колбэки)
    // читается из callbacksRef, чтобы не пересобирать CodeMirror на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Внешнее изменение контента (например, ИИ переписал заметку, или галочка
  // была переключена кликом по виджету) — применяем как замену документа,
  // если оно отличается от последнего значения, которое сами же отправили
  // через onChange (иначе будет эхо/скачки курсора). Патчим только реально
  // изменившийся кусок (общий префикс/суффикс не трогаем) — иначе полная
  // замена документа сбрасывает scrollTop и курсор к началу редактора.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === lastEmitted.current) return;
    const prev = view.state.doc.toString();
    lastEmitted.current = content;
    if (content === prev) return;

    let start = 0;
    const maxStart = Math.min(prev.length, content.length);
    while (start < maxStart && prev[start] === content[start]) start++;
    let endPrev = prev.length;
    let endNext = content.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === content[endNext - 1]) {
      endPrev--;
      endNext--;
    }

    const scrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: start, to: endPrev, insert: content.slice(start, endNext) },
    });
    view.scrollDOM.scrollTop = scrollTop;
  }, [content]);

  return <div ref={hostRef} className="ms-live-editor-cm" style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />;
}
