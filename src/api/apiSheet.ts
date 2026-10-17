/**
 * API страницы «Таблицы» (server/ts/routes/sheet.ts): электронные таблицы на ядре GridCraft.
 * Все вызовы редактирования возвращают свежее состояние (листы, выделение, строка формул, форматирование).
 */
import { req, multipart, blobGet } from "@/api/apiHttp";

export interface SheetRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  a1: string;
}

export interface SheetCellPos {
  r: number;
  c: number;
  a1: string;
}

export interface SheetBorderSide {
  /** [толщина, цвет, стиль линии] или null. */
  0: number;
  1: string;
  2: string;
}

export interface SheetBorders {
  l: SheetBorderSide | null;
  r: SheetBorderSide | null;
  t: SheetBorderSide | null;
  b: SheetBorderSide | null;
  d: SheetBorderSide | null;
  u: SheetBorderSide | null;
}

export interface SheetFormat {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: string;
  strike: boolean;
  vert: string;
  color: string | null;
  fill: string | null;
  numFmt: string;
  h: string;
  v: string;
  wrap: boolean;
  shrink: boolean;
  indent: number;
  rotation: number;
  locked: boolean;
  hiddenFormula: boolean;
  borders: SheetBorders;
}

export interface SheetTab {
  i: number;
  name: string;
  color: string | null;
  visibility: string;
  protected: boolean;
}

export interface SheetValidation {
  kind: string;
  dropdown: boolean;
  items: string[];
  showInput: boolean;
  inputTitle: string;
  inputMessage: string;
}

export interface SheetTableCtx {
  name: string;
  range: SheetRange;
  style: string;
  header: boolean;
  totals: boolean;
  bandedRows: boolean;
  bandedCols: boolean;
  firstCol: boolean;
  lastCol: boolean;
  filterButton: boolean;
  column: string | null;
}

export interface SheetCtx {
  table: SheetTableCtx | null;
  pivot: { id: number; name: string } | null;
  validation: SheetValidation | null;
  comment: {
    author: string;
    text: string;
    threaded: boolean;
    replies: [string, string][];
    resolved: boolean;
  } | null;
  link: { target: string; tooltip: string | null; external: boolean } | null;
  autofilter: boolean;
  protected: boolean;
  merged: SheetRange | null;
  spill: { anchor: string; range: SheetRange } | null;
}

export interface SheetObjects {
  charts: { id: number; title: string | null; kind: string }[];
  images: { id: number; alt: string }[];
  shapes: { id: number; kind: string; text: string }[];
  slicers: { id: number; caption: string }[];
  comments: {
    cell: string;
    r: number;
    c: number;
    author: string;
    text: string;
    threaded: boolean;
    replies: [string, string][];
    resolved: boolean;
    visible: boolean;
  }[];
}

export type SheetRequest =
  | { kind: "dialog"; name: string; params: Record<string, unknown> }
  | { kind: "message"; text: string }
  | { kind: "edit"; text: string | null }
  | { kind: "url"; url: string };

export interface SheetState {
  open: boolean;
  doc: { title: string; path: string | null; dirty: boolean; uid: number; revision: number };
  sheets: SheetTab[];
  active: number;
  sel: {
    active: SheetCellPos;
    anchor: SheetCellPos;
    ranges: SheetRange[];
    a1: string;
    wholeRows: boolean;
    wholeCols: boolean;
  };
  bar: { text: string; formula: boolean; kind: string };
  nameBox: string;
  names: { name: string; formula: string }[];
  undo: string[];
  redo: string[];
  canUndo: boolean;
  canRedo: boolean;
  view: {
    zoom: number;
    gridlines: boolean;
    headings: boolean;
    formulas: boolean;
    zeros: boolean;
    rtl: boolean;
    freeze: [number, number] | null;
    mode: string;
    formulaBar: boolean;
    ruler: boolean;
    tabColor: string | null;
    printGridlines: boolean;
    printHeadings: boolean;
  };
  used: SheetRange | null;
  maxRows: number;
  maxCols: number;
  format: SheetFormat;
  stats: {
    count: number;
    nums: number;
    sum: number;
    min: number | null;
    max: number | null;
    avg: number | null;
  };
  ctx: SheetCtx;
  objects: SheetObjects;
  mode: string;
  painter: boolean;
  draw: { tool: string; color: string; width: number };
  recording: boolean;
  clipboard: { range: SheetRange; sheet: number; cut: boolean; areas: SheetRange[] } | null;
  theme: { colors: string[]; name: string; major: string; minor: string };
  calc: { mode: string; iterative: boolean };
  prefs: {
    autocomplete: boolean;
    defaultFont: string;
    defaultFontSize: number;
    enterDirection: string;
    formulaBar: boolean;
    r1c1: boolean;
    userName: string;
  };
  protectedStructure: boolean;
  docs: { title: string; dirty: boolean }[];
  requests: SheetRequest[];
}

/** Оформление ячейки в окне сетки (общее для многих ячеек, ячейка ссылается по номеру). */
export interface SheetCellStyle {
  f: { n: string; z: number; b: boolean; i: boolean; u: string; s: boolean; v: string };
  a: { h: string; v: string; w: boolean; sh: boolean; in: number; r: number };
  b: SheetBorders;
}

export interface SheetCell {
  r: number;
  c: number;
  /** Номер стиля в `styles`. */
  s: number;
  /** Показанный текст. */
  t?: string;
  /** Символ повтор-заполнения (формат `*x`; в тексте на его месте символ \u0000). */
  fc?: string;
  /** Вид значения: n число, s текст, b логическое, e ошибка. */
  k?: "n" | "s" | "b" | "e";
  n?: 1;
  /** Цвет текста (формат числа или стиль). */
  tc?: string;
  /** Заливка. */
  fl?: string;
  /** Гистограмма: [доля, цвет, градиент]. */
  bar?: [number, string, boolean];
  /** Значок: [набор, номер, сколько значков в наборе]. */
  ic?: [string, number, number];
  /** Флажок: 0/1. */
  ck?: 0 | 1;
  pic?: boolean;
  /** Размер объединения [строк, столбцов]. */
  m?: [number, number];
  /** Кнопка фильтра: 1 — есть, 2 — фильтр включён. */
  flt?: 1 | 2;
  /** Спарклайн: SVG. */
  sp?: string;
  cm?: 1;
  lk?: 1;
}

export interface SheetObjectRect {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: string;
}

export interface SheetGrid {
  sheet: number;
  /** [индекс, левый край, ширина] в пикселях при масштабе 100%. */
  cols: [number, number, number][];
  rows: [number, number, number][];
  styles: SheetCellStyle[];
  cells: SheetCell[];
  merges: SheetRange[];
  charts: (SheetObjectRect & { svg: string; kind: string; title: string | null })[];
  images: (SheetObjectRect & { mime: string; alt: string; size: number })[];
  shapes: (SheetObjectRect & {
    kind: string;
    fill: string | null;
    line: string | null;
    text: string;
    textColor?: string;
    fmt: Record<string, unknown>;
  })[];
  slicers: (SheetObjectRect & {
    caption: string;
    table: string;
    column: string;
    columns: number;
    selected: string[] | null;
  })[];
  freeze: [number, number];
  frozenX: number;
  frozenY: number;
  revision: number;
}

export interface SheetStatus {
  available: boolean;
  bin: string | null;
  searched: string[];
  sessions: number;
}

export interface SheetOpened {
  id: string;
  state: SheetState;
  name?: string;
}

export interface SheetCommand {
  id: string;
  label: string;
  menu: string[];
  shortcut: string | null;
  params: string;
  enabled: boolean;
  disabled_reason?: string;
}

export const sheetApi = {
  sheetStatus: () => req<SheetStatus>("GET", "/sheet/status"),
  sheetNew: (sample = "blank") => req<SheetOpened>("POST", "/sheet/sessions", { sample }),
  sheetUpload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<{ path: string; name: string }>("/sheet/upload", fd);
  },
  sheetOpen: (file: File, password?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (password) fd.append("password", password);
    return multipart<SheetOpened>("/sheet/open", fd);
  },
  sheetClose: (id: string) => req<{ ok: boolean }>("DELETE", `/sheet/sessions/${id}`),
  sheetState: (id: string) => req<SheetState>("GET", `/sheet/${id}/state`),
  sheetGrid: (id: string, body: { x: number; y: number; w: number; h: number }) =>
    req<SheetGrid>("POST", `/sheet/${id}/grid`, body),
  sheetRun: (id: string, command: string, params: Record<string, unknown> = {}) =>
    req<{ result: unknown; state: SheetState }>("POST", `/sheet/${id}/run`, { command, params }),
  sheetCommands: (id: string) => req<SheetCommand[]>("GET", `/sheet/${id}/commands`),
  /** Любой метод ядра без обёртки состояния (данные для панелей и диалогов). */
  sheetQuery: (id: string, method: string, params: unknown = {}) =>
    req<unknown>("POST", `/sheet/${id}/call`, { method, params }),
  sheetExport: (id: string, format: string, name: string, sheets?: "active" | "all") =>
    blobGet(
      `/sheet/${id}/export?format=${format}&name=${encodeURIComponent(name)}${sheets ? `&sheets=${sheets}` : ""}`,
    ),
};
