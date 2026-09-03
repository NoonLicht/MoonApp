import React, { useEffect, useRef, useState } from "react";
import {
  EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType,
  placeholder, keymap,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import {
  Bold as IconBold, Italic as IconItalic, Code as IconCode, Heading1 as IconH1,
  Heading2 as IconH2, Heading3 as IconH3, List as IconList, ListOrdered as IconListOl,
  Quote as IconQuote, CheckSquare as IconTask, Link as IconLink, Table2 as IconTable,
  Minus as IconHr, Strikethrough as IconStrike,
} from "lucide-react";

// Types
interface Props {
  content: string;
  onChange: (content: string) => void;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  placeholder?: string;
}
type WikiMatch = { from: number; to: number; kind: "wiki" | "tag"; value: string };
function isChecked(m: string) { return /^[xX+]$/.test(m); }

// Widgets
class CheckboxWidget extends WidgetType {
  checked: boolean;
  constructor(checked: boolean) { super(); this.checked = checked; }
  eq(o: WidgetType) { return o instanceof CheckboxWidget && o.checked === this.checked; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "lp-box" + (this.checked ? " is-checked" : "");
    s.textContent = this.checked ? "☑" : "☐";
    s.setAttribute("aria-hidden", "true");
    return s;
  }
}
class HrWidget extends WidgetType {
  eq(o: WidgetType) { return o instanceof HrWidget; }
  toDOM() { const s = document.createElement("div"); s.className = "lp-hr"; return s; }
}

// Table detection helpers
function isSepCell(cell: string): boolean {
  return /^:?-+:?\s*$/.test(cell.trim());
}
function splitPipe(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function detectTable(
  lines: { text: string }[], idx: number,
): { end: number; rows: string[][]; headerSep: number } | null {
  const first = lines[idx];
  if (!first || !first.text.includes("|")) return null;
  const rows: string[][] = [];
  let i = idx;
  let sepRow = -1;
  while (i < lines.length) {
    const t = lines[i].text;
    if (!t.includes("|")) break;
    const cells = splitPipe(t);
    rows.push(cells);
    if (sepRow < 0 && cells.length >= 2 && cells.every(isSepCell)) sepRow = rows.length - 1;
    i += 1;
  }
  // Must have header + separator + at least one data row
  if (rows.length < 3 || sepRow < 1 || sepRow >= rows.length - 1) return null;
  return { end: i - 1, rows, headerSep: sepRow };
}
// TableWidget – renders <table>. Non-block replace on the first table line.
// Click dispatches caret inside the region so decorations switch to raw GFM.
class TableWidget extends WidgetType {
  constructor(
    private rows: string[][],
    private headerSep: number,
    private from: number,
    private to: number,
  ) { super(); }
  eq(o: WidgetType): boolean {
    return o instanceof TableWidget && o.from === this.from && o.to === this.to;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    wrap.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      const target = this.from + 1;
      if (target >= this.to) return;
      view.dispatch({ selection: { anchor: target, head: target }, scrollIntoView: true });
      view.focus();
    });
    const table = document.createElement("table");
    table.className = "cm-table";
    const nCols = Math.max(...this.rows.map((r) => r.length), 1);
    let outRow = 0;
    for (let s = 0; s < this.rows.length; s += 1) {
      if (s === this.headerSep) continue;
      const tr = document.createElement("tr");
      for (let c = 0; c < nCols; c += 1) {
        const cell = document.createElement(outRow === 0 ? "th" : "td");
        cell.textContent = this.rows[s][c] ?? "";
        tr.appendChild(cell);
      }
      table.appendChild(tr);
      outRow += 1;
    }
    wrap.appendChild(table);
    return wrap;
  }
}

// Empty widget for non-first table lines
class EmptyWidget extends WidgetType {
  eq(o: WidgetType) { return o instanceof EmptyWidget; }
  toDOM() { const d = document.createElement("span"); d.style.display = "none"; return d; }
}

// Block-level Live Preview decorations (Obsidian-style)
function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const head = Math.min(view.state.selection.main.head, doc.length);
  const activeLine = doc.lineAt(head).number;
  const lines: { text: string }[] = [];
  for (let i = 1; i <= doc.lines; i += 1) lines.push({ text: doc.line(i).text });

  // Find inactive table regions (caret OUTSIDE → render, inside → raw GFM)
  const regions: { startLine: number; endLine: number; from: number; to: number; rows: string[][]; headerSep: number }[] = [];
  let li = 0;
  while (li < lines.length) {
    const det = detectTable(lines, li);
    if (!det) { li += 1; continue; }
    const sLine = li + 1;
    const eLine = det.end + 1;
    if (!(activeLine >= sLine && activeLine <= eLine)) {
      regions.push({
        startLine: sLine, endLine: eLine,
        from: doc.line(sLine).from, to: doc.line(eLine).to,
        rows: det.rows, headerSep: det.headerSep,
      });
    }
    li = det.end + 1;
  }

  const regLines = new Set<number>();
  for (const r of regions) for (let n = r.startLine; n <= r.endLine; n += 1) regLines.add(n);

  for (let i = 1; i <= doc.lines; i += 1) {
    const region = regions.find((r) => r.startLine === i);
    if (region) {
      // Replace each line individually (no block:true — it conflicts with markdown highlighting).
      // First line gets the <table> widget; others get empty widget.
      // All get a line-level class that hides raw text via CSS visibility trick.
      for (let n = region.startLine; n <= region.endLine; n += 1) {
        const l = doc.line(n);
        builder.add(l.from, l.to, Decoration.line({ class: "lp-tbl-inactive" }));
        if (n === region.startLine) {
          builder.add(l.from, l.to, Decoration.replace({ widget: new TableWidget(region.rows, region.headerSep, region.from, region.to) }));
        } else {
          builder.add(l.from, l.to, Decoration.replace({ widget: new EmptyWidget() }));
        }
      }
      i = region.endLine;
      continue;
    }

    const line = doc.line(i);
    const text = line.text;
    if (i === activeLine || regLines.has(i)) continue;

    // Checkbox task
    const t = text.match(/^(\s*)[-*+]\s+\[( |x|X|\+)\]\s+(.+)$/);
    if (t) {
      const checked = isChecked(t[2]);
      builder.add(line.from, line.from + t[0].length, Decoration.replace({ widget: new CheckboxWidget(checked) }));
      builder.add(line.from + t[0].length, line.to, Decoration.mark({ class: "lp-task" + (checked ? " lp-checked" : "") }));
      continue;
    }

    // Heading
    const h = text.match(/^(#{1,6})(\s*)\S/);
    if (h) {
      const ml = h[1].length + h[2].length;
      builder.add(line.from, line.from + ml, Decoration.replace({}));
      builder.add(line.from + ml, line.to, Decoration.mark({ class: `lp-h lp-h${h[1].length}` }));
      continue;
    }

    // HR
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      builder.add(line.from, line.to, Decoration.replace({ widget: new HrWidget() }));
      continue;
    }

    // Quote
    const q = text.match(/^(\s*)>\s?/);
    if (q) {
      builder.add(line.from, line.from + q[0].length, Decoration.replace({}));
      builder.add(line.from + q[0].length, line.to, Decoration.mark({ class: "lp-quote" }));
      continue;
    }

    // Unordered list
    const u = text.match(/^(\s*)[-*+]\s+/);
    if (u) {
      builder.add(line.from, line.from + u[0].length, Decoration.replace({}));
      builder.add(line.from + u[0].length, line.to, Decoration.mark({ class: "lp-list" }));
      continue;
    }

    // Ordered list
    const o = text.match(/^(\s*)\d+\.\s+/);
    if (o) {
      builder.add(line.from, line.from + o[0].length, Decoration.replace({}));
      builder.add(line.from + o[0].length, line.to, Decoration.mark({ class: "lp-olist" }));
    }
  }

  return builder.finish();
}

const markdownLivePreviewPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) { this.deco = buildMarkdownDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.deco = buildMarkdownDecorations(u.view);
    }
  },
  { decorations: (v) => v.deco },
);

/* WIKI_LINKS */
// Wiki links and tags (clickable inline decorations)
function buildLinkDecorations(view: EditorView): { set: DecorationSet; matches: WikiMatch[] } {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const matches: WikiMatch[] = [];
  const re = /\[\[([^[\]|]+)(?:\|[^\]]*)?\]\]|#[\p{L}\p{N}_/\\-]+/gu;
  for (let i = 1; i <= doc.lines; i += 1) {
    const line = doc.line(i);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (m[0].startsWith("[[")) {
        builder.add(from, to, Decoration.mark({ class: "lp-wikilink" }));
        matches.push({ from, to, kind: "wiki", value: m[0].slice(2, -2).split("|")[0] });
      } else {
        builder.add(from, to, Decoration.mark({ class: "lp-tag" }));
        matches.push({ from, to, kind: "tag", value: m[0].slice(1) });
      }
    }
  }
  return { set: builder.finish(), matches };
}

function inlineLinksPlugin(getHandlers: () => { onWikiLink?: (t: string) => void; onTagClick?: (t: string) => void }) {
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      matches: WikiMatch[] = [];
      private bound: (e: MouseEvent) => void;
      constructor(view: EditorView) {
        this.deco = Decoration.none;
        this.bound = (e) => this.onClick(e, view);
        view.dom.addEventListener("click", this.bound);
        this.measure(view);
      }
      measure(view: EditorView) {
        const r = buildLinkDecorations(view);
        this.deco = r.set;
        this.matches = r.matches;
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.measure(u.view);
      }
      onClick(ev: MouseEvent, view: EditorView) {
        if (ev.defaultPrevented || ev.button !== 0) return;
        const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
        if (pos == null) return;
        const m = this.matches.find((x) => x.from <= pos && pos <= x.to);
        if (!m) return;
        const h = getHandlers();
        if (m.kind === "wiki" && h.onWikiLink) { ev.preventDefault(); h.onWikiLink(m.value); }
        else if (m.kind === "tag" && h.onTagClick) { ev.preventDefault(); h.onTagClick(m.value); }
      }
    },
    { decorations: (v) => v.deco },
  );
}

/* TOOLBAR */
// Toolbar commands
function wrapSel(view: EditorView, before: string, after: string, hint: string) {
  const { from, to } = view.state.selection.main;
  const txt = view.state.sliceDoc(from, to) || hint;
  view.dispatch({
    changes: { from, to, insert: before + txt + after },
    selection: { anchor: from + before.length, head: from + before.length + txt.length },
    scrollIntoView: true,
  });
}
function prependLine(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({ changes: { from: line.from, insert: prefix }, scrollIntoView: true });
}
function insertBlock(view: EditorView, text: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const nl = line.text.length > 0 ? "\n" : "";
  view.dispatch({
    changes: { from: line.to, insert: nl + text },
    selection: { anchor: line.to + nl.length + text.length },
    scrollIntoView: true,
  });
}
function cmdTable(view: EditorView) {
  insertBlock(view, "| Col 1 | Col 2 |\n| --- | --- |\n|  |  |");
}

function CMToolbar({ view }: { view: EditorView }) {
  const btn = (label: string, icon: React.ReactNode, cb: (v: EditorView) => void) => (
    <button type="button" className="fmt-btn" title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { view.focus(); cb(view); }}>{icon}</button>
  );
  return (
    <div className="fmt-toolbar">
      {btn("Bold", <IconBold size={14} />, (v) => wrapSel(v, "**", "**", "bold"))}
      {btn("Italic", <IconItalic size={14} />, (v) => wrapSel(v, "*", "*", "italic"))}
      {btn("Strikethrough", <IconStrike size={14} />, (v) => wrapSel(v, "~~", "~~", "text"))}
      {btn("Inline code", <IconCode size={14} />, (v) => wrapSel(v, "`", "`", "code"))}
      <span className="fmt-sep" />
      {btn("Heading 1", <IconH1 size={14} />, (v) => prependLine(v, "# "))}
      {btn("Heading 2", <IconH2 size={14} />, (v) => prependLine(v, "## "))}
      {btn("Heading 3", <IconH3 size={14} />, (v) => prependLine(v, "### "))}
      {btn("Quote", <IconQuote size={14} />, (v) => prependLine(v, "> "))}
      <span className="fmt-sep" />
      {btn("Bullet list", <IconList size={14} />, (v) => prependLine(v, "- "))}
      {btn("Numbered list", <IconListOl size={14} />, (v) => prependLine(v, "1. "))}
      {btn("Task", <IconTask size={14} />, (v) => prependLine(v, "- [ ] "))}
      {btn("Table", <IconTable size={14} />, cmdTable)}
      {btn("Horizontal rule", <IconHr size={14} />, (v) => prependLine(v, "---\n"))}
      <span className="fmt-sep" />
      {btn("Wiki link", <IconLink size={14} />, (v) => wrapSel(v, "[[", "]]", "note"))}
    </div>
  );
}

// Main component
export default function NoteEditor({
  content, onChange, onWikiLink, onTagClick,
  placeholder: ph = "Start writing...",
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const handlersRef = useRef({ onWikiLink, onTagClick });
  handlersRef.current = { onWikiLink, onTagClick };
  const [viewReady, setViewReady] = useState<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    let destroyed = false;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup, markdown(), keymap.of(markdownKeymap), placeholder(ph),
          markdownLivePreviewPlugin,
          inlineLinksPlugin(() => handlersRef.current),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if ((view as any).__suppressChange) return;
            onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.editorAttributes.of({ class: "cm-note" }),
        ],
      }),
    });
    viewRef.current = view;
    (view as any).__suppressChange = false;
    view.focus();
    requestAnimationFrame(() => { if (!destroyed) setViewReady(view); });
    return () => { destroyed = true; view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content → editor (note switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === content) return;
    (view as any).__suppressChange = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: 0 },
    });
    (view as any).__suppressChange = false;
  }, [content]);

  return (
    <div className="note-editor">
      {viewReady && <CMToolbar view={viewReady} />}
      <div ref={hostRef} className="note-cm-host" />
    </div>
  );
}