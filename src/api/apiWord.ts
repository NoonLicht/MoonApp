/**
 * API страницы «Документы» (server/ts/routes/word.ts): редактор на ядре WordCraft.
 * Все вызовы редактирования возвращают свежее состояние (страницы, каретка, выделение, форматирование).
 */
import { req, multipart, blobGet } from "@/api/apiHttp";

export interface WordPageInfo {
  w: number;
  h: number;
  number: number;
  body: { x: number; y: number; w: number; h: number };
}

export interface WordRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Свойства символа под кареткой (поля CharProps ядра; пустое поле — наследуется). */
export interface WordCharProps {
  font?: string | null;
  size?: number | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: string | null;
  strike?: boolean | null;
  color?: unknown;
  highlight?: string | null;
  vertAlign?: string | null;
  style?: string | null;
  [key: string]: unknown;
}

export interface WordParaProps {
  align?: string | null;
  style?: string | null;
  list?: unknown;
  [key: string]: unknown;
}

/** Выбранный объект (рисунок, фигура, рамка, диаграмма, SmartArt). */
export interface WordObjectCtx {
  kind: "picture" | "chart" | "smartArt" | "graphic" | "textBox" | "shape" | "group" | "object";
  w: number;
  h: number;
  deg: number;
  rect: {
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    floating: boolean;
    behind: boolean;
  } | null;
  float: { wrap?: string; wrapText?: string; flipH?: boolean; flipV?: boolean } | null;
  alt: string;
  crop: number[] | null;
  canvas: boolean;
  chart: {
    type: string;
    title: string | null;
    legend: string | null;
    dataLabels: boolean;
    categories: string[];
    series: { name: string; values: (number | null)[] }[];
  } | null;
  smartArt: {
    layout: string;
    colors: string;
    items: { text: string; level?: number }[];
  } | null;
  textBox: { vert?: string; anchor?: string; next?: number | null } | null;
}

export interface WordTableCtx {
  rows: number;
  cols: number;
  row: number;
  col: number;
  look: {
    headerRow: boolean;
    totalRow: boolean;
    bandedRows: boolean;
    firstColumn: boolean;
    lastColumn: boolean;
    bandedColumns: boolean;
  };
  style: string | null;
  height: number;
  width: number;
  heightExact: boolean;
  /** Границы таблицы на страницах (пункты): по ним интерфейс ставит зоны перетаскивания. */
  borders: {
    page: number;
    cols: number[];
    rows: number[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }[];
}

/** Свойства раздела под кареткой (SectionProps ядра). */
export interface WordSection {
  pageW: number;
  pageH: number;
  landscape: boolean;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  gutter: number;
  header: number;
  footer: number;
  columns: { count: number; separator: boolean; space: number; widths: unknown[] };
  titlePage: boolean;
  valign: string;
  pageNumFormat: string;
  lineNumbers: unknown;
  [key: string]: unknown;
}

export interface WordCtx {
  section: WordSection;
  marginsPreset: string | null;
  columnsPreset: string | null;
  textDirection: string | null;
  part: "body" | "header" | "footer" | "footnote" | "endnote" | "comment" | "textBox";
  object: WordObjectCtx | null;
  table: WordTableCtx | null;
  equation: boolean;
  painter: boolean;
  recording: boolean;
}

/** Настройки вида сеанса (поля ViewState ядра). */
export interface WordView {
  zoom: number;
  mode: "print" | "web" | "draft" | "outline" | "read";
  readMode: boolean;
  focusMode: boolean;
  marks: boolean;
  ruler: boolean;
  gridlines: boolean;
  tableGridlines: boolean;
  navPane: boolean;
  stylesPane: boolean;
  styleInspector: boolean;
  commentsPane: boolean;
  clipboardPane: boolean;
  smartArtPane: boolean;
  accessibilityPane: boolean;
  altTextPane: boolean;
  trackChangesPane: boolean;
  multiPage: boolean;
  singleColumn: boolean;
  fit: string;
  darkMode: boolean;
  showMarkup: boolean;
  proofing: boolean;
  hideInk: boolean;
  fieldCodes: boolean;
  hideWhiteSpace: boolean;
  designMode: boolean;
  fullScreen: boolean;
  draw: {
    mode: string;
    pens: { kind: string; color: number[]; width: number }[];
    pen: { color: number[]; width: number };
    pencil: { color: number[]; width: number };
    highlighter: { color: number[]; width: number };
    inkToShape: boolean;
    replay?: boolean;
  };
  outline: {
    collapsed: number[];
    firstLineOnly: boolean;
    hideFormatting: boolean;
    showLevel: number;
  };
  [key: string]: unknown;
}

export interface WordSettings {
  trackChanges: boolean;
  evenOdd: boolean;
  mirrorMargins: boolean;
  autoHyphenation: boolean;
  themeName: string;
  themeColors: string[];
  majorFont: string;
  minorFont: string;
  protection: string | null;
  defaultTab: number;
  watermark: boolean;
  pageColor: string | null;
  language: string | null;
  author: string;
  bibStyle: string;
  mergeKind: string;
  autosave: boolean;
}

/** Форматирование под кареткой (результат format.state). */
export interface WordFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean | string;
  strike: boolean;
  subscript: boolean;
  superscript: boolean;
  border: boolean;
  caps: boolean;
  smallCaps: boolean;
  hidden: boolean;
  font: string;
  size: number;
  color: string;
  highlight: string | null;
  style: string;
  styleName: string;
  lang: string;
  [key: string]: unknown;
}

/** Абзац под кареткой с учётом стиля (ResolvedPara ядра + то, что нужно ленте). */
export interface WordParaResolved {
  style: string;
  visualAlign: string;
  align: string;
  indentLeft: number;
  indentRight: number;
  indentFirst: number;
  spaceBefore: number;
  spaceAfter: number;
  lineSpacing: unknown;
  keepNext: boolean;
  keepLines: boolean;
  pageBreakBefore: boolean;
  widowControl: boolean;
  bidi: boolean;
  shading: unknown;
  tabs: { pos: number; kind?: string; align?: string; leader?: string }[];
  lists: { bullets: boolean; numbering: boolean; multilevel: boolean };
  [key: string]: unknown;
}

/** Запрос команды к интерфейсу: открыть диалог, прокрутить, сфокусировать поиск… */
export type WordRequest = {
  open?: string;
  pane?: string;
  focus?: string;
  scrollTo?: string;
  close?: boolean;
  toggle?: string;
  [k: string]: unknown;
};

export interface WordState {
  pages: WordPageInfo[];
  caret: { page: number; x: number; top: number; height: number } | null;
  selection: {
    collapsed: boolean;
    rects: WordRect[];
    text: string;
    anchor: { story: string | { part: number }; path: number[]; off: number };
    focus: { story: string | { part: number }; path: number[]; off: number };
  };
  typing: WordCharProps;
  para: WordParaProps | null;
  paraResolved: WordParaResolved | null;
  ctx: WordCtx;
  view: WordView;
  settings: WordSettings;
  format: WordFormat;
  requests: WordRequest[];
  status: string;
  fileName: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  dirty: boolean;
  words: number;
  rev: number;
}

export interface WordStatus {
  available: boolean;
  bin: string | null;
  searched: string[];
  sessions: number;
}

export interface WordOpened {
  id: string;
  state: WordState;
  name?: string;
}

export interface WordCommand {
  id: string;
  label: string;
  location: string;
  shortcut: string;
  params: string;
  mutates: boolean;
}

export const wordApi = {
  wordStatus: () => req<WordStatus>("GET", "/word/status"),
  wordNew: (template = "blank", locale?: { region?: string; lang?: string }) =>
    req<WordOpened>("POST", "/word/sessions", { template, ...locale }),
  /** Файл → путь на сервере для команд ядра с параметром path. */
  wordUpload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<{ path: string; name: string }>("/word/upload", fd);
  },
  wordOpen: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<WordOpened>("/word/open", fd);
  },
  wordClose: (id: string) => req<{ ok: boolean }>("DELETE", `/word/sessions/${id}`),
  wordState: (id: string) => req<WordState>("GET", `/word/${id}/state`),
  wordClick: (
    id: string,
    body: { page: number; x: number; y: number; extend?: boolean; count?: number },
  ) => req<WordState>("POST", `/word/${id}/click`, body),
  wordKey: (id: string, body: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean }) =>
    req<WordState>("POST", `/word/${id}/key`, body),
  wordType: (id: string, text: string) => req<WordState>("POST", `/word/${id}/type`, { text }),
  wordRun: (id: string, command: string, params: Record<string, unknown> = {}) =>
    req<{ result: unknown; state: WordState }>("POST", `/word/${id}/run`, { command, params }),
  wordCommands: (id: string) => req<WordCommand[]>("GET", `/word/${id}/commands`),
  /** Страница как PNG (токен в заголовке — <img src> его передать не может). */
  /** Буфер обмена ядра после Копировать/Вырезать: текст и HTML для системного буфера. */
  wordClip: (id: string) => req<{ text: string; html: string }>("GET", `/word/${id}/clip`),
  /** Любой метод ядра без обёртки состояния (запросы данных: структура, комментарии, стили…). */
  wordQuery: (id: string, method: string, params: unknown = {}) =>
    req<unknown>("POST", `/word/${id}/call`, { method, params }),
  wordPage: (id: string, n: number, scale: number) =>
    blobGet(`/word/${id}/page/${n}?scale=${scale.toFixed(2)}`),
  wordExport: (id: string, format: string, name: string) =>
    blobGet(`/word/${id}/export?format=${format}&name=${encodeURIComponent(name)}`),
};
