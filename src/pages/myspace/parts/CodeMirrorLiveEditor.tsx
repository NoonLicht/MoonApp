import { useEffect, useRef } from "react";
import { EditorState, StateField, RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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

/* ─── Разбор/сборка GFM-таблицы в/из markdown-исходника (простая построчная
   модель ячеек, без экранирования "|" внутри ячеек — как и обычный GFM). ─── */
function parseTableSource(source: string): { rows: string[][]; align: ("l" | "c" | "r")[] } {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  const splitRow = (l: string) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = lines[0] ? splitRow(lines[0]) : [""];
  const alignRow = lines[1] ? splitRow(lines[1]) : [];
  const align: ("l" | "c" | "r")[] = header.map((_, i) => {
    const a = (alignRow[i] || "").trim();
    if (/^:-+:$/.test(a)) return "c";
    if (/^-+:$/.test(a)) return "r";
    return "l";
  });
  const body = lines.slice(2).map((l) => splitRow(l));
  return { rows: [header, ...body], align };
}

function buildTableSource(rows: string[][], align: ("l" | "c" | "r")[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const fmtRow = (r: string[]) => `| ${r.map(esc).join(" | ")} |`;
  const sepCell = (a: "l" | "c" | "r") => (a === "c" ? ":---:" : a === "r" ? "---:" : "---");
  const header = rows[0] || [""];
  const sep = `| ${header.map((_, i) => sepCell(align[i] || "l")).join(" | ")} |`;
  const body = rows.slice(1).map(fmtRow);
  return [fmtRow(header), sep, ...body].join("\n");
}

/* ─── Виджет редактируемой GFM-таблицы: настоящая <table> с contenteditable
   ячейками и кнопками добавления/удаления строк и столбцов, показывается
   пока курсор не внутри блока таблицы (тогда виден сырой markdown для правки
   текстом). Правки в ячейках/структуре сразу переписывают markdown-источник
   этого блока через applyEdit. ─── */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly blockFrom: number,
    readonly blockTo: number,
    readonly applyEdit: (from: number, to: number, text: string) => void,
    /** Ширины столбцов в px, ключ — blockFrom (позиция начала блока таблицы
     * в документе) — переживает пересоздание DOM-виджета при любой правке
     * содержимого ячеек/структуры, поэтому ширина остаётся зафиксированной
     * после изменения, а не сбрасывается на авто. */
    readonly widthsMap: Map<number, number[]>,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.blockFrom === this.blockFrom && other.blockTo === this.blockTo;
  }
  toDOM() {
    const { rows, align } = parseTableSource(this.source);
    const cols = rows[0]?.length || 1;
    let widths = this.widthsMap.get(this.blockFrom);
    if (!widths || widths.length !== cols) {
      widths = Array.from({ length: cols }, () => 160);
      this.widthsMap.set(this.blockFrom, widths);
    }
    const wrap = document.createElement("div");
    wrap.className = "cm-live-table";

    const commit = (nextRows: string[][], nextAlign: ("l" | "c" | "r")[]) => {
      const md = buildTableSource(nextRows, nextAlign);
      this.applyEdit(this.blockFrom, this.blockTo, md + "\n");
    };

    const table = document.createElement("table");
    table.className = "cm-live-table-el";

    // table-layout: fixed + <col> с жёсткой шириной — без этого столбец
    // растягивался под печатаемый текст в ячейке, что и было проблемой.
    const colEls: HTMLTableColElement[] = [];
    const colgroup = document.createElement("colgroup");
    widths.forEach((w) => {
      const col = document.createElement("col");
      col.style.width = w + "px";
      colEls.push(col);
      colgroup.appendChild(col);
    });
    const actionsCol = document.createElement("col");
    actionsCol.style.width = "26px";
    colgroup.appendChild(actionsCol);
    table.appendChild(colgroup);

    const renderRow = (cells: string[], isHeader: boolean, rowIdx: number) => {
      const tr = document.createElement("tr");
      cells.forEach((cellText, colIdx) => {
        const cell = document.createElement(isHeader ? "th" : "td");
        cell.contentEditable = "true";
        cell.textContent = cellText;
        cell.style.textAlign = align[colIdx] === "c" ? "center" : align[colIdx] === "r" ? "right" : "left";
        cell.addEventListener("blur", () => {
          const next = rows.map((r) => r.slice());
          next[rowIdx][colIdx] = (cell.textContent || "").trim();
          commit(next, align);
        });
        cell.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            cell.blur();
          }
        });
        // Перетаскиваемый разделитель — только в шапке, тянет ширину своего
        // столбца; правки живут в widthsMap, никакого commit() в документ не
        // требуется (ширина — оформление, не часть GFM-синтаксиса).
        if (isHeader && colIdx < colEls.length) {
          const resizer = document.createElement("span");
          resizer.className = "cm-live-table-resizer";
          resizer.contentEditable = "false";
          resizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startWidth = widths![colIdx];
            const onMove = (ev: MouseEvent) => {
              const w = Math.max(50, startWidth + (ev.clientX - startX));
              widths![colIdx] = w;
              colEls[colIdx].style.width = w + "px";
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          });
          cell.appendChild(resizer);
        }
        tr.appendChild(cell);
      });
      const actions = document.createElement("td");
      actions.className = "cm-live-table-rowactions";
      actions.contentEditable = "false";
      if (!isHeader) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "cm-live-table-btn";
        del.textContent = "−";
        del.title = "Удалить строку";
        del.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const next = rows.filter((_, i) => i !== rowIdx);
          if (next.length < 2) return;
          commit(next, align);
        });
        actions.appendChild(del);
      }
      tr.appendChild(actions);
      return tr;
    };

    rows.forEach((r, i) => table.appendChild(renderRow(r, i === 0, i)));
    wrap.appendChild(table);

    const toolbar = document.createElement("div");
    toolbar.className = "cm-live-table-toolbar";

    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "cm-live-table-btn";
    addRow.textContent = "+ строка";
    addRow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const cols = rows[0]?.length || 1;
      commit([...rows, Array(cols).fill("")], align);
    });

    const addCol = document.createElement("button");
    addCol.type = "button";
    addCol.className = "cm-live-table-btn";
    addCol.textContent = "+ столбец";
    addCol.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commit(
        rows.map((r) => [...r, ""]),
        [...align, "l"],
      );
    });

    toolbar.appendChild(addRow);
    toolbar.appendChild(addCol);
    wrap.appendChild(toolbar);

    return wrap;
  }
  ignoreEvent() {
    // Таблица — полностью самостоятельный DOM-остров (contenteditable-ячейки
    // + свои кнопки): если пустить mousedown в CodeMirror, он переносит
    // курсор редактора внутрь строк таблицы, из-за чего activeLine попадает
    // в диапазон блока и виджет тут же подменяется сырым markdown вместо
    // того, чтобы дать просто кликнуть и печатать в ячейке.
    return true;
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
  state: EditorState,
  onToggleCheckbox: ((i: number) => void) | undefined,
  applyEdit: (from: number, to: number, text: string) => void,
  tableWidths: Map<number, number[]>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const activeLine = state.doc.lineAt(state.selection.main.head).number;
  let inFence = false;
  const tableBlocks = findTableBlocks(state.doc);

  for (let ln = 1; ln <= state.doc.lines; ln++) {
    const line = state.doc.line(ln);
    const text = line.text;

    const tb = tableBlocks.find((b) => b.fromLine === ln);
    if (tb && (activeLine < tb.fromLine || activeLine > tb.toLine)) {
      builder.add(
        tb.from,
        tb.blockTo,
        Decoration.replace({
          widget: new TableWidget(tb.source, tb.from, tb.blockTo, applyEdit, tableWidths),
          block: true,
        }),
      );
      ln = tb.toLine;
      continue;
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

/* ─── StateField вместо ViewPlugin: CodeMirror 6 требует, чтобы декорации,
   содержащие блочные (block: true) виджеты/замены — как TableWidget —
   предоставлялись именно полем состояния, а не плагином вида, иначе падает
   с "Block decorations may not be specified via plugins". ─── */
function livePreviewField(
  onToggleCheckbox: ((i: number) => void) | undefined,
  applyEdit: (from: number, to: number, text: string) => void,
  tableWidths: Map<number, number[]>,
) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildLiveDecorations(state, onToggleCheckbox, applyEdit, tableWidths);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection) {
        return buildLiveDecorations(tr.state, onToggleCheckbox, applyEdit, tableWidths);
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
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
  const tableWidthsRef = useRef<Map<number, number[]>>(new Map());
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
          overflowX: "auto",
        },
        ".cm-live-table table": {
          // table-layout: fixed — ширина столбцов задаётся только через
          // <col>, а не "плывёт" под набираемый в ячейке текст.
          tableLayout: "fixed",
          borderCollapse: "collapse",
          border: "1px solid var(--glass-border)",
          fontSize: "13px",
        },
        ".cm-live-table th, .cm-live-table td": {
          border: "1px solid var(--glass-border)",
          padding: "6px 10px",
          textAlign: "left",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          position: "relative",
        },
        ".cm-live-table th": {
          background: "var(--track, rgba(255,255,255,0.06))",
          fontWeight: "600",
        },
        ".cm-live-table-resizer": {
          position: "absolute",
          top: "0",
          right: "-3px",
          width: "6px",
          height: "100%",
          cursor: "col-resize",
          userSelect: "none",
          zIndex: "1",
        },
        ".cm-live-table-resizer:hover": {
          background: "var(--amber-soft)",
        },
        ".cm-live-table-rowactions": {
          border: "none !important",
          padding: "0 4px !important",
          width: "1%",
          whiteSpace: "nowrap",
        },
        ".cm-live-table-toolbar": {
          display: "flex",
          gap: "6px",
          marginTop: "6px",
        },
        ".cm-live-table-btn": {
          font: "inherit",
          fontSize: "12px",
          color: "var(--text-secondary)",
          background: "var(--track, rgba(255,255,255,0.06))",
          border: "1px solid var(--glass-border)",
          borderRadius: "6px",
          padding: "2px 8px",
          cursor: "pointer",
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

    const applyTableEdit = (from: number, to: number, text: string) => {
      viewRef.current?.dispatch({ changes: { from, to, insert: text } });
    };

    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ codeLanguages: languages, extensions: [GFM] }),
      syntaxHighlighting(liveHighlight),
      livePreviewField(onToggleCheckbox, applyTableEdit, tableWidthsRef.current),
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
