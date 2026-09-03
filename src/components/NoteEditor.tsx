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

// ----------------------------------------------------------------------------
// Shared types
// ----------------------------------------------------------------------------
interface Props {
  content: string;
  onChange: (content: string) => void;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  placeholder?: string;
}

type WikiMatch = { from: number; to: number; kind: "wiki" | "tag"; value: string };

function isChecked(m: string) { const c = m.toLowerCase(); return c === "x" || c === "+"; }

// ----------------------------------------------------------------------------
// Widgets
// ----------------------------------------------------------------------------
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
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

// GFM table detection ---------------------------------------------------------

function isSeparator(cell: string) {
  return /^:?-+:?\s*$/.test(cell.trim());
}
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((c) => c.trim());
}
function detectTableRegion(lines: { text: string }[], lineIndex: number): { end: number; rows: string[][]; headerIndex: number } | null {
  // requires: at least one separator row and header + data rows
  const first = lines[lineIndex];
  if (!first || !first.text.includes("|")) return null;
  const rows: string[][] = [];
  let i = lineIndex;
  let sepIdx = -1;
  while (i < lines.length) {
    const t = lines[i].text;
    if (!t.includes("|")) break;
    const cells = splitRow(t);
    rows.push(cells);
    if (sepIdx < 0 && cells.length >= 2 && cells.every(isSeparator)) sepIdx = rows.length - 1;
    i += 1;
  }
  if (rows.length < 2 || sepIdx < 0 || sepIdx >= rows.length - 1) return null;
  return { end: i - 1, rows, headerIndex: sepIdx };
}

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][], readonly headerIndex: number) { super(); }
  eq(o: WidgetType) { return o instanceof TableWidget; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const ncols = Math.max(...this.rows.map((r) => r.length), 1);
    const hasHeader = this.headerIndex >= 0;
    let r = 0;
    for (let srcIdx = 0; srcIdx < this.rows.length; srcIdx += 1) {
      if (srcIdx === this.headerIndex) continue; // skip separator row
      const tr = document.createElement("tr");
      const src = this.rows[srcIdx];
      const isHead = hasHeader && r === 0;
      for (let c = 0; c < ncols; c += 1) {
        const cell = document.createElement(isHead ? "th" : "td");
        cell.textContent = src[c] ?? "";
        tr.appendChild(cell);
      }
      table.appendChild(tr);
      r += 1;
    }
    wrap.appendChild(table);
    return wrap;
  }
}
// ----------------------------------------------------------------------------
// Block-level live preview: hide markers (##, -, >, [x], |) when the caret is
// NOT on that line, and restyle the content (big heading, list, quote, table).
// Non-destructive: the markdown text in the document is NEVER changed.
// ----------------------------------------------------------------------------
function buildMarkdownDecorations(view: EditorView, boxes: { from: number; to: number; checked: boolean }[]) {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const activeLine = doc.lineAt(head).number;
  const lines: { text: string }[] = [];
  for (let i = 1; i <= doc.lines; i += 1) lines.push({ text: doc.line(i).text });

  // Detect inactive table regions (caret outside) so we can render them.
  const regions: { startLine: number; endLine: number; from: number; to: number; rows: string[][]; headerIndex: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const det = detectTableRegion(lines, i);
    if (!det) continue;
    const containsCaret = activeLine >= i + 1 && activeLine <= det.end + 1;
    if (!containsCaret) {
      regions.push({
        startLine: i + 1, endLine: det.end + 1,
        from: doc.line(i + 1).from, to: doc.line(det.end + 1).to,
        rows: det.rows, headerIndex: det.headerIndex,
      });
    }
    i = det.end;
  }
  const inRegion = new Set<number>();
  for (const r of regions) for (let n = r.startLine; n <= r.endLine; n += 1) inRegion.add(n);

  for (let i = 1; i <= doc.lines; i += 1) {
    const region = regions.find((r) => r.startLine === i);
    if (region) {
      builder.add(region.from, region.to, Decoration.replace({ block: true, widget: new TableWidget(region.rows, region.headerIndex) }));
      i = region.endLine;
      continue;
    }
    const line = doc.line(i);
    const text = line.text;
    if (inRegion.has(i) || i === activeLine) continue; // caret line = raw source

    const task = text.match(/^(\s*)[-*+]\s+\[( |x|X|\+)\]\s+(.+)$/);
    if (task) {
      const checked = isChecked(task[2]);
      builder.add(line.from, line.from + task[0].length, Decoration.replace({ widget: new CheckboxWidget(checked) }));
      builder.add(line.from + task[0].length, line.to, Decoration.mark({ class: "lp-task" + (checked ? " lp-checked" : "") }));
      boxes.push({ from: line.from, to: line.from + task[0].length - 1, checked });
      continue;
    }
    const hm = text.match(/^(#{1,6})(\s*)\S/);
    if (hm) {
      const level = hm[1].length;
      const markerLen = hm[1].length + hm[2].length;
      builder.add(line.from, line.from + markerLen, Decoration.replace({}));
      builder.add(line.from + markerLen, line.to, Decoration.mark({ class: `lp-h lp-h${level}` }));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      builder.add(line.from, line.to, Decoration.replace({ widget: new HrWidget() }));
      continue;
    }
    const qm = text.match(/^(\s*)>\s?/);
    if (qm) {
      builder.add(line.from, line.from + qm[0].length, Decoration.replace({}));
      builder.add(line.from + qm[0].length, line.to, Decoration.mark({ class: "lp-quote" }));
      continue;
    }
    const bm = text.match(/^(\s*)[-*+]\s+/);
    if (bm) {
      builder.add(line.from, line.from + bm[0].length, Decoration.replace({}));
      builder.add(line.from + bm[0].length, line.to, Decoration.mark({ class: "lp-list" }));
      continue;
    }
    const nm = text.match(/^(\s*)\d+\.\s+/);
    if (nm) {
      builder.add(line.from, line.from + nm[0].length, Decoration.replace({}));
      builder.add(line.from + nm[0].length, line.to, Decoration.mark({ class: "lp-olist" }));
    }
  }
  return builder.finish();
}
// ----------------------------------------------------------------------------
// Wiki links [[...]] and tags #tag: styled as clickable, still editable text.
// ----------------------------------------------------------------------------
function buildLinkDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const matches: WikiMatch[] = [];
  const re = /\[\[([^[\]|]+)(?:\|[^\]]*)?\]\]|#[\p{L}\p{N}_/\\-]+/gu;
  for (let i = 1; i <= doc.lines; i += 1) {
    const line = doc.line(i);
    const base = line.from;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line.text))) {
      const from = base + m.index;
      const to = base + m.index + m[0].length;
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
      deco: DecorationSet; matches: WikiMatch[] = [];
      private boundClick: (e: MouseEvent) => void;
      constructor(view: EditorView) {
        this.deco = Decoration.none;
        this.measure(view);
        this.boundClick = (e) => this.onClick(e, view);
        view.dom.addEventListener("click", this.boundClick);
      }
      measure(view: EditorView) {
        const r = buildLinkDecorations(view);
        this.deco = r.set;
        this.matches = r.matches;
      }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.measure(u.view); }
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

const markdownLivePreview = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) { this.deco = buildMarkdownDecorations(view, []); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.deco = buildMarkdownDecorations(u.view, []); }
  },
  { decorations: (v) => v.deco },
);
// ----------------------------------------------------------------------------
// Markdown commands for the toolbar
// ----------------------------------------------------------------------------
function viewCmd(fn: (view: EditorView) => void) {
  return () => {
    const view = viewRefGlobal.current;
    if (view) { view.focus(); fn(view); }
  };
}
const viewRefGlobal: { current: EditorView | null } = { current: null };

function wrapSelection(view: EditorView, before: string, after: string, ph: string) {
  const { from, to } = view.state.selection.main;
  const txt = view.state.sliceDoc(from, to) || ph;
  const insert = before + txt + after;
  view.dispatch({
    changes: { from, to, insert },
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
  const atEnd = line.to;
  const insert = (atEnd === view.state.doc.length || line.text.length ? "\n" : "") + text;
  view.dispatch({ changes: { from: atEnd, insert }, selection: { anchor: atEnd + insert.length }, scrollIntoView: true });
}

function cmdTable() {
  viewCmd((view) => {
    const table = "| Col 1 | Col 2 |\n| --- | --- |\n|  |  |\n";
    insertBlock(view, table);
  })();
}

function CMToolbar() {
  const t = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button type="button" className="fmt-btn" title={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</button>
  );
  if (!viewRefGlobal.current) return null;
  return (
    <div className="fmt-toolbar">
      {t("Bold", <IconBold size={14} />, viewCmd((v) => wrapSelection(v, "**", "**", "bold")))}
      {t("Italic", <IconItalic size={14} />, viewCmd((v) => wrapSelection(v, "*", "*", "italic")))}
      {t("Strikethrough", <IconStrike size={14} />, viewCmd((v) => wrapSelection(v, "~~", "~~", "text")))}
      {t("Inline code", <IconCode size={14} />, viewCmd((v) => wrapSelection(v, "`", "`", "code")))}
      <span className="fmt-sep" />
      {t("Heading 1", <IconH1 size={14} />, viewCmd((v) => prependLine(v, "# ")))}
      {t("Heading 2", <IconH2 size={14} />, viewCmd((v) => prependLine(v, "## ")))}
      {t("Heading 3", <IconH3 size={14} />, viewCmd((v) => prependLine(v, "### ")))}
      {t("Quote", <IconQuote size={14} />, viewCmd((v) => prependLine(v, "> ")))}
      <span className="fmt-sep" />
      {t("Bullet list", <IconList size={14} />, viewCmd((v) => prependLine(v, "- ")))}
      {t("Numbered list", <IconListOl size={14} />, viewCmd((v) => prependLine(v, "1. ")))}
      {t("Task", <IconTask size={14} />, viewCmd((v) => prependLine(v, "- [ ] ")))}
      {t("Table", <IconTable size={14} />, cmdTable)}
      {t("Horizontal rule", <IconHr size={14} />, viewCmd((v) => prependLine(v, "---\n")))}
      <span className="fmt-sep" />
      {t("Wiki link", <IconLink size={14} />, viewCmd((v) => wrapSelection(v, "[[", "]]", "note")))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main component (controlled: content <-> markdown)
// ----------------------------------------------------------------------------
export default function NoteEditor({ content, onChange, onWikiLink, onTagClick, placeholder: ph = "Start writing..." }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const handlersRef = useRef({ onWikiLink, onTagClick });
  handlersRef.current = { onWikiLink, onTagClick };
  const suppressRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    viewRefGlobal.current = null;
    const host = hostRef.current!;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown(),
          keymap.of(markdownKeymap),
          placeholder(ph),
          markdownLivePreview,
          inlineLinksPlugin(() => handlersRef.current),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (suppressRef.current) return;
            onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.editorAttributes.of({ class: "cm-note" }),
        ],
      }),
    });
    viewRef.current = view;
    viewRefGlobal.current = view;
    setReady(true);
    return () => { view.destroy(); viewRef.current = null; viewRefGlobal.current = null; };
    // mount once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content changes (e.g. switching notes) into the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === content) return;
    suppressRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0 } });
    setTimeout(() => { suppressRef.current = false; }, 0);
  }, [content]);

  return (
    <div className="note-editor">
      {ready && <CMToolbar />}
      <div ref={hostRef} className="note-cm-host" />
    </div>
  );
}