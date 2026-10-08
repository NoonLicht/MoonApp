import { useEffect, useRef } from "react";
import {
  EditorState,
  StateEffect,
  StateField,
  RangeSetBuilder,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { findInlineMath, findMathBlock, renderMath } from "@/lib/math";

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
  /** Кнопка «распознать» на картинке. `replace` подменяет её markdown в документе. */
  onOcrImage?: (req: OcrImageRequest) => void;
  /** Шестерёнка на картинке: настройки распознавания. */
  onOcrSettings?: () => void;
  /** PDF, брошенный на редактор: распознавание страниц и подстановка текста. */
  onDropPdf?: (req: PdfDropRequest) => void;
  /** src картинок, которые распознаются прямо сейчас (на них показывается индикатор). */
  ocrBusy?: string[];
  ocrLabels?: { ocr: string; settings: string; busy: string };
}

/** Брошенный в заметку PDF: на его месте стоит `marker`, который потом заменяют текстом. */
export interface PdfDropRequest {
  file: File;
  marker: string;
  /** Заменить точный фрагмент `from` на `to`; false — фрагмента в документе уже нет. */
  replace: (from: string, to: string) => boolean;
}

export interface OcrImageRequest {
  src: string;
  alt: string;
  /** Заменить `![alt](src)` на текст; false — картинки в документе уже нет. */
  replace: (text: string) => boolean;
}

interface OcrState {
  busy: Set<string>;
  labels: { ocr: string; settings: string; busy: string } | null;
}

const refreshDecorations = StateEffect.define<null>();

/** Заменить точный фрагмент документа (ближайший к `near`); false — не найден или редактор закрыт. */
function replaceExact(view: EditorView, from: string, to: string, near: number): boolean {
  if (!view.dom.isConnected) return false;
  const doc = view.state.doc.toString();
  let best = -1;
  for (let i = doc.indexOf(from); i >= 0; i = doc.indexOf(from, i + 1))
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  if (best < 0) return false;
  view.dispatch({ changes: { from: best, to: best + from.length, insert: to } });
  return true;
}

const IMAGE_URL = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?\S*)?$/i;

const IMAGE_MD = /^!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/;

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

/** `![alt|300](src)` — ширина картинки в alt, как в Obsidian. */
function splitAlt(raw: string): { alt: string; width: number | null } {
  const m = /^(.*?)\|(\d{2,4})$/.exec(raw);
  return m ? { alt: m[1], width: Number(m[2]) } : { alt: raw, width: null };
}

/** Записать ширину картинки в её разметку (null — вернуть исходный размер). */
function setImageWidth(view: EditorView, pos: number, width: number | null) {
  const head = view.state.doc.sliceString(pos, Math.min(view.state.doc.length, pos + 4000));
  const m = /^!\[([^\]]*)\]\(/.exec(head);
  if (!m) return;
  const next = splitAlt(m[1]).alt + (width ? `|${Math.round(width)}` : "");
  if (next === m[1]) return;
  view.dispatch({ changes: { from: pos + 2, to: pos + 2 + m[1].length, insert: next } });
}

/** Просмотр картинки во весь экран: колесо — масштаб, перетаскивание — сдвиг, клик по фону / Esc — закрыть. */
function openLightbox(src: string, alt: string) {
  const bg = document.createElement("div");
  bg.style.cssText =
    "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.86);display:grid;place-items:center;overflow:hidden;cursor:zoom-out";
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  img.style.cssText =
    "max-width:92vw;max-height:92vh;transition:transform .08s;cursor:grab;user-select:none";
  bg.appendChild(img);
  let k = 1;
  let x = 0;
  let y = 0;
  const apply = () => (img.style.transform = `translate(${x}px,${y}px) scale(${k})`);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  function close() {
    window.removeEventListener("keydown", key, true);
    bg.remove();
  }
  bg.addEventListener("wheel", (e) => {
    e.preventDefault();
    k = Math.min(12, Math.max(0.2, k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    apply();
  });
  let drag: { px: number; py: number; x: number; y: number } | null = null;
  img.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    img.setPointerCapture(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x, y };
  });
  img.addEventListener("pointermove", (e) => {
    if (!drag) return;
    x = drag.x + e.clientX - drag.px;
    y = drag.y + e.clientY - drag.py;
    apply();
  });
  img.addEventListener("pointerup", () => {
    drag = null;
  });
  img.addEventListener("dblclick", () => {
    k = k === 1 ? 2.5 : 1;
    x = 0;
    y = 0;
    apply();
  });
  bg.addEventListener("click", (e) => {
    if (e.target === bg) close();
  });
  window.addEventListener("keydown", key, true);
  document.body.appendChild(bg);
}

/* ─── Виджет картинки: заменяет "![alt](src)" превью-изображением. Кнопки (масштаб, на весь экран,
   «распознать» Chandra OCR, настройки) появляются при наведении; ширину можно тянуть за угол, она
   сохраняется в разметке как `![alt|300](src)`. События OCR уходят в редактор как cm-image-ocr. ─── */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly busy: boolean,
    readonly labels: OcrState["labels"],
    readonly width: number | null = null,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.busy === this.busy &&
      other.labels === this.labels &&
      other.width === this.width
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-live-imgwrap" + (this.busy ? " is-busy" : "");
    const img = document.createElement("img");
    img.className = "cm-live-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    if (this.width) {
      img.style.width = `${this.width}px`;
      img.style.maxHeight = "none";
      img.style.height = "auto";
    }
    img.onerror = () => {
      img.classList.add("is-broken");
    };
    wrap.appendChild(img);
    const labels = this.labels;
    const act = document.createElement("span");
    act.className = "cm-live-imgact";
    const cur = () => img.getBoundingClientRect().width || this.width || 300;
    if (labels) {
      const mk = (cls: string, text: string, title: string, kind: "ocr" | "settings") => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = text;
        b.title = title;
        b.disabled = this.busy && kind === "ocr";
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          view.dom.dispatchEvent(
            new CustomEvent("cm-image-ocr", {
              detail: { kind, pos: view.posAtDOM(wrap), src: this.src, alt: this.alt },
            }),
          );
        });
        return b;
      };
      act.appendChild(mk("cm-live-imgbtn", "OCR", labels.ocr, "ocr"));
    }
    wrap.appendChild(act);
    if (labels && this.busy) {
      const o = document.createElement("span");
      o.className = "cm-live-imgbusy";
      o.textContent = labels.busy;
      wrap.appendChild(o);
    }
    // ручка в нижнем правом углу: тянем — ширина меняется, отпускаем — записывается в текст
    const grip = document.createElement("span");
    grip.className = "cm-live-imgresize";
    grip.addEventListener("mousedown", (e) => e.preventDefault());
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = cur();
      const max = wrap.parentElement?.clientWidth || 4000;
      let w = startW;
      const move = (ev: PointerEvent) => {
        w = Math.min(max, Math.max(60, startW + ev.clientX - startX));
        img.style.width = `${w}px`;
        img.style.height = "auto";
        img.style.maxHeight = "none";
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        setImageWidth(view, view.posAtDOM(wrap), w);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    wrap.appendChild(grip);
    img.addEventListener("dblclick", (e) => {
      e.preventDefault();
      openLightbox(this.src, this.alt);
    });
    return wrap;
  }
  ignoreEvent(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t?.closest?.(".cm-live-imgact, .cm-live-imgresize") || e.type === "dblclick";
  }
}

/* ─── Формулы как в Obsidian: "$…$" в строке и "$$…$$" блоком рисуются KaTeX, пока курсор не
   на этой строке (под курсором — исходный LaTeX для правки). ─── */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-live-math-block" : "cm-live-math";
    el.innerHTML = renderMath(this.tex, this.display);
    return el;
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
    return (
      other.source === this.source &&
      other.blockFrom === this.blockFrom &&
      other.blockTo === this.blockTo
    );
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
        cell.style.textAlign =
          align[colIdx] === "c" ? "center" : align[colIdx] === "r" ? "right" : "left";
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
  ocr: OcrState,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const activeLine = state.doc.lineAt(state.selection.main.head).number;
  let inFence = false;
  const tableBlocks = findTableBlocks(state.doc);
  const allLines = state.doc.toString().split("\n");

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
        Decoration.line({
          attributes: { class: opening ? "cm-live-fence-open" : "cm-live-fence-close" },
        }),
      );
      continue;
    }
    if (inFence) {
      builder.add(
        line.from,
        line.from,
        Decoration.line({ attributes: { class: "cm-live-fence-line" } }),
      );
      continue;
    }

    // Формула-блок "$$ … $$": рисуем KaTeX, а под курсором оставляем исходник.
    if (text.trimStart().startsWith("$$")) {
      const mb = findMathBlock(allLines, ln - 1);
      if (mb) {
        const startLn = mb.start + 1;
        const endLn = mb.end + 1;
        if (activeLine >= startLn && activeLine <= endLn) {
          for (let k = startLn; k <= endLn; k++) {
            const lk = state.doc.line(k);
            builder.add(
              lk.from,
              lk.from,
              Decoration.line({ attributes: { class: "cm-live-math-src" } }),
            );
          }
        } else {
          const blockTo =
            endLn + 1 <= state.doc.lines ? state.doc.line(endLn + 1).from : state.doc.length;
          builder.add(
            state.doc.line(startLn).from,
            blockTo,
            Decoration.replace({ widget: new MathWidget(mb.tex, true), block: true }),
          );
        }
        ln = endLn;
        continue;
      }
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
        builder.add(
          line.from,
          line.from + qm[0].length,
          Decoration.mark({ class: "cm-live-quote-marker" }),
        );
      }
    }

    // Инлайн-разметка внутри остатка строки
    const bodyOffset = bodyFrom - line.from;
    const body = text.slice(bodyOffset);
    // Формулы "$…$": внутри них "_" и "*" — не курсив, поэтому прячем их от INLINE_RE.
    const maths = findInlineMath(body);
    let masked = body;
    for (const r of maths)
      masked = masked.slice(0, r.from) + "\u2060".repeat(r.to - r.from) + masked.slice(r.to);
    let mi = 0;
    const flushMath = (upTo: number): void => {
      while (mi < maths.length && maths[mi].from < upTo) {
        const r = maths[mi++];
        builder.add(
          line.from + bodyOffset + r.from,
          line.from + bodyOffset + r.to,
          Decoration.replace({ widget: new MathWidget(r.tex, false) }),
        );
      }
    };
    INLINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_RE.exec(masked))) {
      flushMath(m.index);
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
        builder.add(
          from,
          to,
          Decoration.replace({
            widget: (() => {
              const { alt, width } = splitAlt(m[16] || "");
              return new ImageWidget(m[17], alt, ocr.busy.has(m[17]), ocr.labels, width);
            })(),
          }),
        );
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
        builder.add(
          from,
          to,
          Decoration.mark({ class: "cm-live-tag", attributes: { "data-tag": m[21] } }),
        );
      }
    }
    flushMath(Infinity);
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
  ocr: OcrState,
) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildLiveDecorations(state, onToggleCheckbox, applyEdit, tableWidths, ocr);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshDecorations))) {
        return buildLiveDecorations(tr.state, onToggleCheckbox, applyEdit, tableWidths, ocr);
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
  onOcrImage,
  onOcrSettings,
  onDropPdf,
  ocrBusy,
  ocrLabels,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastEmitted = useRef(content);
  const tableWidthsRef = useRef<Map<number, number[]>>(new Map());
  const ocrStateRef = useRef<OcrState>({ busy: new Set(), labels: null });
  const callbacksRef = useRef({
    onWikiLink,
    onTagClick,
    onToggleCheckbox,
    onPasteImage,
    onOcrImage,
    onOcrSettings,
    onDropPdf,
  });

  useEffect(() => {
    callbacksRef.current = {
      onWikiLink,
      onTagClick,
      onToggleCheckbox,
      onPasteImage,
      onOcrImage,
      onOcrSettings,
      onDropPdf,
    };
  }, [
    onWikiLink,
    onTagClick,
    onToggleCheckbox,
    onPasteImage,
    onOcrImage,
    onOcrSettings,
    onDropPdf,
  ]);

  // Кнопки OCR на картинках и индикатор «идёт распознавание»: состояние читает поле декораций.
  const busyKey = (ocrBusy ?? []).join("\n");
  const hasOcr = !!onOcrImage && !!ocrLabels;
  useEffect(() => {
    const st = ocrStateRef.current;
    st.busy = new Set(ocrBusy ?? []);
    if (hasOcr && ocrLabels) {
      const l = st.labels;
      if (
        !l ||
        l.ocr !== ocrLabels.ocr ||
        l.settings !== ocrLabels.settings ||
        l.busy !== ocrLabels.busy
      )
        st.labels = ocrLabels;
    } else st.labels = null;
    viewRef.current?.dispatch({ effects: refreshDecorations.of(null) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey, hasOcr, ocrLabels?.ocr, ocrLabels?.settings, ocrLabels?.busy]);

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
          /* колонка по центру: на широком окне не растекается от края до края,
             на узком боковые поля сжимаются вместе с контейнером */
          padding: "20px clamp(10px, 4cqw, 48px)",
          caretColor: "var(--amber)",
          flex: "1 1 0",
          maxWidth: "980px",
          margin: "0 auto",
          boxSizing: "border-box",
          minWidth: "0",
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
        ".cm-live-imgwrap": {
          display: "block",
          position: "relative",
          width: "fit-content",
          maxWidth: "100%",
        },
        ".cm-live-imgact": {
          position: "absolute",
          top: "8px",
          right: "8px",
          display: "flex",
          gap: "6px",
          opacity: "0",
          pointerEvents: "none",
          transition: "opacity 0.15s",
        },
        ".cm-live-imgwrap:hover .cm-live-imgact, .cm-live-imgwrap:focus-within .cm-live-imgact": {
          opacity: "1",
          pointerEvents: "auto",
        },
        ".cm-live-imgresize": {
          position: "absolute",
          right: "4px",
          bottom: "8px",
          width: "14px",
          height: "14px",
          borderRadius: "4px",
          background: "var(--amber)",
          border: "2px solid var(--surface-solid, #fff)",
          cursor: "nwse-resize",
          opacity: "0",
          transition: "opacity 0.15s",
          touchAction: "none",
        },
        ".cm-live-imgwrap:hover .cm-live-imgresize": { opacity: "0.95" },
        ".cm-live-imgbtn": {
          font: "inherit",
          fontSize: "12px",
          fontWeight: "600",
          lineHeight: "1",
          padding: "6px 10px",
          borderRadius: "8px",
          border: "1px solid var(--glass-border)",
          background: "var(--surface-solid, rgba(20,20,24,0.85))",
          color: "var(--text-primary)",
          cursor: "pointer",
          opacity: "0.85",
          backdropFilter: "blur(6px)",
        },
        ".cm-live-imgbtn:hover": {
          opacity: "1",
          borderColor: "var(--amber)",
          color: "var(--amber)",
        },
        ".cm-live-imgbtn:disabled": { cursor: "progress", opacity: "0.5" },
        ".cm-live-imgbusy": {
          position: "absolute",
          inset: "0",
          display: "grid",
          placeItems: "center",
          borderRadius: "8px",
          background: "rgba(0,0,0,0.45)",
          color: "#fff",
          fontSize: "13px",
          fontWeight: "600",
          pointerEvents: "none",
        },
        ".cm-live-image.is-broken": {
          display: "inline-block",
          minWidth: "120px",
          minHeight: "28px",
          background: "var(--track, rgba(255,255,255,0.06))",
        },
        ".cm-live-math": { color: "var(--text-primary)", padding: "0 1px" },
        ".cm-live-math-block": {
          textAlign: "center",
          padding: "6px 0",
          overflowX: "auto",
          overflowY: "hidden",
          color: "var(--text-primary)",
        },
        ".cm-live-math-block .katex-display": { margin: "0" },
        ".cm-live-math-src": {
          background: "var(--track, rgba(255,255,255,0.05))",
          fontFamily: "var(--font-mono)",
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
        const pasted = e.clipboardData?.getData("text/plain")?.trim() ?? "";
        if (IMAGE_URL.test(pasted) && !e.clipboardData?.files?.length) {
          e.preventDefault();
          const { from, to } = view.state.selection.main;
          const md = `![](${pasted})`;
          view.dispatch({
            changes: { from, to, insert: md },
            selection: { anchor: from + md.length },
          });
          return true;
        }
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
      dragover(e) {
        if (!callbacksRef.current.onPasteImage && !callbacksRef.current.onDropPdf) return false;
        if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return false;
        e.preventDefault();
        return true;
      },
      drop(e, view) {
        const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
        const dropped = Array.from(e.dataTransfer?.files ?? []);
        const upload = callbacksRef.current.onPasteImage;
        const onPdf = callbacksRef.current.onDropPdf;
        const files = dropped.filter(
          (f) => (upload && f.type.startsWith("image/")) || (onPdf && isPdf(f)),
        );
        if (!files.length) return false;
        e.preventDefault();
        let at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        void (async () => {
          for (const f of files) {
            const line = view.state.doc.lineAt(at);
            // Картинка и PDF — отдельным абзацем, чтобы рядом с ней работали кнопки.
            const lead = at > line.from ? "\n" : "";
            if (isPdf(f)) {
              const marker = `⏳ PDF «${f.name}» [${Math.random().toString(36).slice(2, 8)}]`;
              const text = `${lead}${marker}\n`;
              view.dispatch({
                changes: { from: at, insert: text },
                selection: { anchor: at + text.length },
              });
              at += text.length;
              onPdf?.({ file: f, marker, replace: (a, b) => replaceExact(view, a, b, at) });
              continue;
            }
            const md = await upload?.(f).catch(() => null);
            if (!md) continue;
            const text = `${lead}${md}\n`;
            view.dispatch({
              changes: { from: at, insert: text },
              selection: { anchor: at + text.length },
            });
            at += text.length;
          }
        })();
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
      livePreviewField(
        onToggleCheckbox,
        applyTableEdit,
        tableWidthsRef.current,
        ocrStateRef.current,
      ),
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

    const onImageAction = (ev: Event) => {
      const d = (
        ev as CustomEvent<{ kind: "ocr" | "settings"; pos: number; src: string; alt: string }>
      ).detail;
      if (d.kind === "settings") return callbacksRef.current.onOcrSettings?.();
      const req: OcrImageRequest = {
        src: d.src,
        alt: d.alt,
        replace: (text) => {
          const doc = view.state.doc.toString();
          const needle = `![${d.alt}](${d.src}`;
          // Картинка могла сместиться за время распознавания: берём ближайшую к исходной позиции.
          let best = -1;
          for (let i = doc.indexOf(needle); i >= 0; i = doc.indexOf(needle, i + 1))
            if (best < 0 || Math.abs(i - d.pos) < Math.abs(best - d.pos)) best = i;
          if (best < 0) return false;
          const m = IMAGE_MD.exec(doc.slice(best, best + needle.length + 400));
          if (!m) return false;
          view.dispatch({ changes: { from: best, to: best + m[0].length, insert: text } });
          return true;
        },
      };
      callbacksRef.current.onOcrImage?.(req);
    };
    view.dom.addEventListener("cm-image-ocr", onImageAction);

    return () => {
      view.dom.removeEventListener("cm-image-ocr", onImageAction);
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

  return (
    <div
      ref={hostRef}
      className="ms-live-editor-cm"
      style={{ flex: 1, minHeight: 0, overflow: "hidden", containerType: "inline-size" }}
    />
  );
}
