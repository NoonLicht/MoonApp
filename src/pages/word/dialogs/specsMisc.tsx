import type { FormSpec, Vals } from "@/pages/word/dialogs/form";
import { lenUnit, ptToUnit, unitToPt } from "@/pages/word/lib";
import type { Cx } from "@/pages/word/ribbon/types";

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : d;
};

const sel = (cx: Cx): string => cx.s.selection.text.slice(0, 200);

/* ---------------- Вставка ---------------- */

export const insertTable = (): FormSpec => ({
  title: "Insert Table…",
  init: () => ({ cols: 5, rows: 2 }),
  fields: [
    { k: "num", key: "cols", label: "Number of columns:", min: 1, max: 63 },
    { k: "num", key: "rows", label: "Number of rows:", min: 1, max: 200 },
  ],
  submit: (v, c) => c.run("insert.table", { rows: num(v.rows, 2), cols: num(v.cols, 5) }),
});

export const newComment = (): FormSpec => ({
  title: "New Comment",
  init: () => ({ text: "" }),
  fields: [{ k: "area", key: "text", label: "Comments", rows: 5 }],
  submit: (v, c) => {
    if (String(v.text).trim()) c.run("review.newComment", { text: String(v.text) });
  },
});

export const field = (): FormSpec => ({
  title: "Field",
  init: () => ({ instr: 'DATE \\@ "dd.MM.yyyy"' }),
  fields: [
    { k: "text", key: "instr", label: "Field codes:" },
    { k: "note", text: "Examples: PAGE, NUMPAGES, DATE, TIME, AUTHOR, TITLE", raw: true },
  ],
  submit: (v, c) => c.run("insert.field", { instr: v.instr }),
});

export const docProperty = (): FormSpec => ({
  title: "Document Property",
  init: () => ({ name: "Title" }),
  fields: [
    {
      k: "select",
      key: "name",
      label: "Property:",
      options: ["Title", "Author", "Subject", "Keywords", "Comments", "Category"].map((n) => [
        n,
        n,
      ]),
    },
  ],
  submit: (v, c) => c.run("insert.docProperty", { name: v.name }),
});

const pad = (n: number): string => String(n).padStart(2, "0");

function sampleDate(fmt: string, d: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const h12 = d.getHours() % 12 || 12;
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g, String(d.getFullYear()).slice(2))
    .replace(/MMMM/g, months[d.getMonth()])
    .replace(/MMM/g, months[d.getMonth()].slice(0, 3))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/M/g, String(d.getMonth() + 1))
    .replace(/dddd/g, days[d.getDay()])
    .replace(/dd/g, pad(d.getDate()))
    .replace(/d/g, String(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/hh/g, pad(h12))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
    .replace(/tt/g, d.getHours() < 12 ? "AM" : "PM");
}

const DATE_FORMATS = [
  "M/d/yyyy",
  "dd.MM.yyyy",
  "yyyy-MM-dd",
  "d MMMM yyyy",
  "MMMM d, yyyy",
  "dddd, d MMMM yyyy",
  "HH:mm",
  "hh:mm tt",
  "HH:mm:ss",
  "dd.MM.yyyy HH:mm",
];

export const dateTime = (): FormSpec => ({
  title: "Date & Time",
  init: () => ({ format: "dd.MM.yyyy", update: false }),
  fields: [
    {
      k: "select",
      key: "format",
      label: "Available formats:",
      raw: true,
      options: DATE_FORMATS.map((f) => [f, sampleDate(f, new Date())]),
    },
    { k: "check", key: "update", label: "Update automatically" },
  ],
  submit: (v, c) => c.run("insert.dateTime", { format: v.format, update: !!v.update }),
});

export const signatureLine = (): FormSpec => ({
  title: "Signature Line",
  init: () => ({ signer: "", title: "" }),
  fields: [
    { k: "text", key: "signer", label: "Suggested signer:" },
    { k: "text", key: "title", label: "Suggested signer's title:" },
  ],
  submit: (v, c) => c.run("insert.signatureLine", { signer: v.signer, title: v.title }),
});

export const equationText = (): FormSpec => ({
  title: "Equation",
  size: "wide",
  init: () => ({ kind: "linear", text: "" }),
  fields: [
    {
      k: "radio",
      key: "kind",
      label: "Format:",
      options: [
        ["linear", "Linear"],
        ["latex", "LaTeX"],
      ],
    },
    { k: "area", key: "text", label: "Equation", rows: 4, placeholder: "a^2+b^2=c^2" },
    { k: "check", key: "display", label: "Display" },
  ],
  submit: (v, c) => c.run("insert.equation", { [String(v.kind)]: v.text, display: !!v.display }),
});

export const signatureStub = signatureLine;

/* ---------------- Ссылки ---------------- */

export const toc = (cx: Cx): FormSpec => ({
  title: "Custom Table of Contents…",
  init: () => ({
    levels: 3,
    title: cx.tw("Table of Contents"),
    pageNumbers: true,
    rightAlign: true,
    tabLeader: "dot",
    hyperlinks: true,
  }),
  fields: [
    { k: "text", key: "title", label: "Title" },
    { k: "check", key: "pageNumbers", label: "Show page numbers" },
    {
      k: "check",
      key: "rightAlign",
      label: "Right align page numbers",
      show: (v) => !!v.pageNumbers,
    },
    {
      k: "select",
      key: "tabLeader",
      label: "Tab leader:",
      show: (v) => !!v.pageNumbers,
      options: [
        ["dot", "(dots)"],
        ["hyphen", "(dashes)"],
        ["underscore", "(line)"],
        ["none", "(none)"],
      ],
    },
    { k: "check", key: "hyperlinks", label: "Use hyperlinks instead of page numbers" },
    { k: "num", key: "levels", label: "Show levels:", min: 1, max: 9 },
  ],
  submit: (v, c) =>
    c.run("references.toc", {
      levels: num(v.levels, 3),
      title: v.title,
      pageNumbers: !!v.pageNumbers,
      rightAlign: !!v.rightAlign,
      tabLeader: v.tabLeader,
      hyperlinks: !!v.hyperlinks,
    }),
});

const NUM_FORMATS: [string, string][] = [
  ["decimal", "1, 2, 3, …"],
  ["lowerRoman", "i, ii, iii, …"],
  ["upperRoman", "I, II, III, …"],
  ["lowerLetter", "a, b, c, …"],
  ["upperLetter", "A, B, C, …"],
];

export const noteOptions = (): FormSpec => ({
  title: "Footnote and Endnote",
  init: () => ({
    kind: "footnote",
    pos: "pageBottom",
    numFmt: "decimal",
    numStart: 1,
    numRestart: "continuous",
    scope: "document",
  }),
  fields: [
    {
      k: "radio",
      key: "kind",
      label: "Location",
      options: [
        ["footnote", "Footnotes"],
        ["endnote", "Endnotes"],
      ],
    },
    {
      k: "select",
      key: "pos",
      label: "Position:",
      options: [
        ["pageBottom", "Bottom of page"],
        ["beneathText", "Below text"],
      ],
      show: (v) => v.kind === "footnote",
    },
    {
      k: "select",
      key: "pos",
      label: "Position:",
      options: [
        ["sectEnd", "End of section"],
        ["docEnd", "End of document"],
      ],
      show: (v) => v.kind === "endnote",
    },
    { k: "select", key: "numFmt", label: "Number format:", options: NUM_FORMATS },
    { k: "num", key: "numStart", label: "Start at:", min: 1 },
    {
      k: "select",
      key: "numRestart",
      label: "Numbering:",
      options: [
        ["continuous", "Continuous"],
        ["eachSect", "Restart Each Section"],
        ["eachPage", "Restart Each Page"],
      ],
    },
    {
      k: "select",
      key: "scope",
      label: "Apply changes to:",
      options: [
        ["document", "Whole document"],
        ["section", "This section"],
      ],
    },
  ],
  submit: (v, c) =>
    c.run("references.noteOptions", {
      kind: v.kind,
      pos: v.pos,
      numFmt: v.numFmt,
      numStart: num(v.numStart, 1),
      numRestart: v.numRestart,
      scope: v.scope,
    }),
});

export const caption = (): FormSpec => ({
  title: "Insert Caption",
  init: () => ({ label: "Figure", text: "", position: "below", excludeLabel: false }),
  fields: [
    {
      k: "select",
      key: "label",
      label: "Label:",
      options: [
        ["Figure", "Figure"],
        ["Table", "Table"],
        ["Equation", "Equation"],
      ],
    },
    { k: "text", key: "text", label: "Caption:" },
    {
      k: "select",
      key: "position",
      label: "Position:",
      options: [
        ["below", "Below selected item"],
        ["above", "Above selected item"],
      ],
    },
    { k: "check", key: "excludeLabel", label: "Exclude label from caption" },
  ],
  submit: (v, c) =>
    c.run("references.caption", {
      label: v.label,
      text: v.text,
      position: v.position,
      excludeLabel: !!v.excludeLabel,
    }),
});

export const tableOfFigures = (): FormSpec => ({
  title: "Insert Table of Figures",
  init: () => ({ label: "Figure" }),
  fields: [
    {
      k: "select",
      key: "label",
      label: "Caption label:",
      options: [
        ["Figure", "Figure"],
        ["Table", "Table"],
        ["Equation", "Equation"],
      ],
    },
  ],
  submit: (v, c) => c.run("references.tableOfFigures", { label: v.label }),
});

export const markEntry = (cx: Cx): FormSpec => ({
  title: "Mark Entry",
  init: () => ({
    entry: sel(cx),
    subentry: "",
    crossReference: "",
    bold: false,
    italic: false,
    all: false,
  }),
  fields: [
    { k: "text", key: "entry", label: "Main entry:" },
    { k: "text", key: "subentry", label: "Subentry:" },
    { k: "text", key: "crossReference", label: "Cross-reference:" },
    { k: "check", key: "bold", label: "Bold" },
    { k: "check", key: "italic", label: "Italic" },
    { k: "check", key: "all", label: "Mark All" },
  ],
  submit: (v, c) =>
    c.run("references.markEntry", {
      entry: v.entry || undefined,
      subentry: v.subentry || undefined,
      crossReference: v.crossReference || undefined,
      bold: !!v.bold,
      italic: !!v.italic,
      all: !!v.all,
    }),
});

export const insertIndex = (): FormSpec => ({
  title: "Insert Index",
  init: () => ({
    type: "indented",
    columns: 2,
    rightAlign: true,
    tabLeader: "dot",
    headings: true,
  }),
  fields: [
    {
      k: "radio",
      key: "type",
      label: "Type:",
      options: [
        ["indented", "Indented"],
        ["runIn", "Run-in"],
      ],
    },
    { k: "num", key: "columns", label: "Columns:", min: 1, max: 4 },
    { k: "check", key: "rightAlign", label: "Right align page numbers" },
    {
      k: "select",
      key: "tabLeader",
      label: "Tab leader:",
      options: [
        ["dot", "(dots)"],
        ["hyphen", "(dashes)"],
        ["underscore", "(line)"],
        ["none", "(none)"],
      ],
    },
    { k: "check", key: "headings", label: "Headings for separating letters" },
  ],
  submit: (v, c) =>
    c.run("references.index", {
      type: v.type,
      columns: num(v.columns, 2),
      rightAlign: !!v.rightAlign,
      tabLeader: v.tabLeader,
      headings: !!v.headings,
    }),
});

export const markCitation = (cx: Cx): FormSpec => ({
  title: "Mark Citation",
  init: () => ({ entry: sel(cx) }),
  fields: [{ k: "text", key: "entry", label: "Selected text:" }],
  submit: (v, c) => c.run("references.markCitation", { entry: v.entry || undefined }),
});

export const bibliography = (): FormSpec => ({
  title: "Bibliography",
  init: () => ({ title: "" }),
  fields: [{ k: "text", key: "title", label: "Title" }],
  submit: (v, c) => c.run("references.bibliography", v.title ? { title: v.title } : {}),
});

const SOURCE_KINDS: [string, string][] = [
  ["book", "Book"],
  ["bookSection", "Book Section"],
  ["article", "Journal Article"],
  ["periodical", "Article in a Periodical"],
  ["conference", "Conference Proceedings"],
  ["report", "Report"],
  ["website", "Web site"],
  ["film", "Film"],
  ["other", "Other"],
];

export const createSource = (): FormSpec => ({
  title: "Create Source",
  size: "wide",
  init: () => ({
    kind: "book",
    author: "",
    title: "",
    year: "",
    publisher: "",
    city: "",
    journal: "",
    volume: "",
    pages: "",
    url: "",
    doi: "",
    cite: true,
    tag: "",
  }),
  fields: [
    { k: "select", key: "kind", label: "Type of Source:", options: SOURCE_KINDS },
    { k: "text", key: "author", label: "Author:", placeholder: "Last, First; Last, First" },
    { k: "text", key: "title", label: "Title:" },
    { k: "text", key: "year", label: "Year:" },
    {
      k: "text",
      key: "publisher",
      label: "Publisher:",
      show: (v) => ["book", "bookSection", "report", "conference"].includes(String(v.kind)),
    },
    {
      k: "text",
      key: "city",
      label: "City:",
      show: (v) => ["book", "bookSection", "report", "conference"].includes(String(v.kind)),
    },
    {
      k: "text",
      key: "journal",
      label: "Journal Name:",
      show: (v) => ["article", "periodical"].includes(String(v.kind)),
    },
    {
      k: "text",
      key: "volume",
      label: "Volume:",
      show: (v) => ["article", "periodical"].includes(String(v.kind)),
    },
    { k: "text", key: "pages", label: "Pages:" },
    { k: "text", key: "url", label: "URL:", show: (v) => v.kind === "website" },
    { k: "text", key: "doi", label: "DOI:" },
    { k: "check", key: "cite", label: "Insert citation after adding" },
  ],
  submit: (v, c) => {
    const tag = String(
      v.tag ||
        `${String(v.author).split(/[,;]/)[0].replace(/\s+/g, "") || "Src"}${v.year || ""}${Date.now().toString(36).slice(-3)}`,
    );
    const source = {
      tag,
      kind: v.kind,
      author: v.author,
      title: v.title,
      year: v.year,
      publisher: v.publisher,
      city: v.city,
      journal: v.journal,
      volume: v.volume,
      pages: v.pages,
      url: v.url,
      doi: v.doi,
    };
    if (v.cite) c.run("references.citation", { tag, source });
    else c.run("references.sources", { add: source });
  },
});

/* ---------------- Рецензирование ---------------- */

export const language = (cx: Cx): FormSpec => ({
  title: "Language",
  init: () => ({
    lang: String(cx.s.format.lang || "en-US"),
    noProof: !!cx.s.format.noProof,
    detect: false,
    def: false,
  }),
  fields: [
    {
      k: "select",
      key: "lang",
      label: "Mark selected text as:",
      raw: true,
      options: [
        ["en-US", "English (United States)"],
        ["en-GB", "English (United Kingdom)"],
        ["de-DE", "German (Germany)"],
        ["fr-FR", "French (France)"],
        ["es-ES", "Spanish (Spain)"],
        ["it-IT", "Italian"],
        ["pt-BR", "Portuguese (Brazil)"],
        ["pt-PT", "Portuguese (Portugal)"],
        ["nl-NL", "Dutch"],
        ["pl-PL", "Polish"],
        ["cs-CZ", "Czech"],
        ["uk-UA", "Ukrainian"],
        ["ru-RU", "Russian"],
        ["tr-TR", "Turkish"],
        ["hr-HR", "Croatian"],
        ["el-GR", "Greek"],
        ["ja-JP", "Japanese"],
        ["zh-CN", "Chinese (Simplified)"],
        ["ko-KR", "Korean"],
        ["ar-SA", "Arabic"],
        ["he-IL", "Hebrew"],
      ].map(([t, n]) => [t, cx.tw(n)]),
    },
    { k: "check", key: "noProof", label: "Do not check spelling or grammar" },
    { k: "check", key: "detect", label: "Detect language automatically" },
    { k: "check", key: "def", label: "Set As Default" },
  ],
  submit: (v, c) =>
    c.run("review.language", {
      lang: v.lang,
      noProof: !!v.noProof,
      detect: !!v.detect,
      default: !!v.def,
    }),
});

export const trackingOptions = (): FormSpec => ({
  title: "Track Changes Options",
  size: "wide",
  init: () => ({
    insertMark: "underline",
    deleteMark: "strikethrough",
    changedLines: "outside",
    balloons: "commentsAndFormatting",
    trackFormatting: true,
    insertionsDeletions: true,
    comments: true,
    ink: true,
  }),
  fields: [
    { k: "check", key: "insertionsDeletions", label: "Insertions and Deletions" },
    { k: "check", key: "comments", label: "Comments" },
    { k: "check", key: "ink", label: "Ink" },
    { k: "check", key: "trackFormatting", label: "Formatting" },
    { k: "sep" },
    {
      k: "select",
      key: "insertMark",
      label: "Insertions:",
      options: [
        ["underline", "Underline"],
        ["doubleUnderline", "Double underline"],
        ["bold", "Bold"],
        ["italic", "Italic"],
        ["strikethrough", "Strikethrough"],
        ["colorOnly", "Color only"],
        ["none", "(none)"],
      ],
    },
    {
      k: "select",
      key: "deleteMark",
      label: "Deletions:",
      options: [
        ["strikethrough", "Strikethrough"],
        ["doubleStrikethrough", "Double strikethrough"],
        ["hidden", "Hidden"],
        ["caret", "^"],
        ["hash", "#"],
        ["underline", "Underline"],
        ["colorOnly", "Color only"],
      ],
    },
    {
      k: "select",
      key: "changedLines",
      label: "Changed lines:",
      options: [
        ["outside", "Outside border"],
        ["left", "Left border"],
        ["right", "Right border"],
        ["none", "(none)"],
      ],
    },
    {
      k: "select",
      key: "balloons",
      label: "Show revisions in balloons:",
      options: [
        ["revisions", "Always"],
        ["commentsAndFormatting", "Comments and formatting only"],
        ["inline", "Never"],
      ],
    },
  ],
  submit: (v, c) =>
    c.run("review.trackingOptions", {
      insertionsDeletions: !!v.insertionsDeletions,
      comments: !!v.comments,
      ink: !!v.ink,
      trackFormatting: !!v.trackFormatting,
      insertMark: v.insertMark,
      deleteMark: v.deleteMark,
      changedLines: v.changedLines,
      balloons: v.balloons,
    }),
});

export const restrict = (cx: Cx): FormSpec => ({
  title: "Restrict Editing",
  init: () => ({ mode: cx.s.settings.protection ?? "none", password: "", formatting: false }),
  fields: [
    {
      k: "radio",
      key: "mode",
      label: "Editing restrictions",
      options: [
        ["none", "No changes (none)"],
        ["readOnly", "No changes (Read only)"],
        ["comments", "Comments"],
        ["trackedChanges", "Tracked changes"],
        ["forms", "Filling in forms"],
      ],
    },
    { k: "check", key: "formatting", label: "Limit formatting to a selection of styles" },
    { k: "text", key: "password", label: "Password (optional):" },
  ],
  submit: (v, c) => {
    if (v.mode === "none")
      c.run("review.restrict", { mode: "none", password: v.password || undefined });
    else
      c.run("review.restrict", {
        mode: v.mode,
        formatting: !!v.formatting,
        password: v.password || undefined,
      });
  },
});

/* ---------------- Таблица ---------------- */

export const cellMargins = (cx: Cx): FormSpec => {
  const u = lenUnit(cx.lang);
  return {
    title: "Cell Margins",
    init: () => ({ top: 0, left: ptToUnit(5.4, u), bottom: 0, right: ptToUnit(5.4, u) }),
    fields: [
      { k: "num", key: "top", label: "Top:", step: 0.05, unit: u.name, min: 0 },
      { k: "num", key: "bottom", label: "Bottom:", step: 0.05, unit: u.name, min: 0 },
      { k: "num", key: "left", label: "Left:", step: 0.05, unit: u.name, min: 0 },
      { k: "num", key: "right", label: "Right:", step: 0.05, unit: u.name, min: 0 },
    ],
    submit: (v, c) =>
      c.run("table.cellMargins", {
        top: unitToPt(num(v.top), u),
        bottom: unitToPt(num(v.bottom), u),
        left: unitToPt(num(v.left), u),
        right: unitToPt(num(v.right), u),
      }),
  };
};

export const splitCells = (): FormSpec => ({
  title: "Split Cells",
  init: () => ({ columns: 2 }),
  fields: [{ k: "num", key: "columns", label: "Number of columns:", min: 1, max: 63 }],
  submit: (v, c) => c.run("table.split", { columns: num(v.columns, 2) }),
});

export const sortTable = (cx: Cx): FormSpec => ({
  title: "Sort",
  init: () => ({ column: 1, descending: false, header: !!cx.s.ctx.table?.look.headerRow }),
  fields: [
    { k: "num", key: "column", label: "Sort by column:", min: 1, max: cx.s.ctx.table?.cols ?? 20 },
    {
      k: "radio",
      key: "descending",
      label: "Order:",
      options: [
        ["false", "Ascending"],
        ["true", "Descending"],
      ],
    },
    { k: "check", key: "header", label: "Header row" },
  ],
  submit: (v, c) =>
    c.run("table.sort", {
      column: num(v.column, 1) - 1,
      descending: String(v.descending) === "true" || v.descending === true,
      header: !!v.header,
    }),
});

export const sortParagraphs = (): FormSpec => ({
  title: "Sort",
  init: () => ({ descending: "false" }),
  fields: [
    {
      k: "radio",
      key: "descending",
      label: "Order:",
      options: [
        ["false", "Ascending"],
        ["true", "Descending"],
      ],
    },
  ],
  submit: (v, c) => c.run("para.sort", { descending: String(v.descending) === "true" }),
});

export const tableToText = (): FormSpec => ({
  title: "Convert to Text",
  init: () => ({ separator: "tab" }),
  fields: [
    {
      k: "radio",
      key: "separator",
      label: "Separate text with:",
      options: [
        ["paragraph", "Paragraph marks"],
        ["tab", "Tabs"],
        ["comma", "Commas"],
      ],
    },
  ],
  submit: (v, c) => c.run("table.toText", { separator: v.separator }),
});

export const tableFormula = (): FormSpec => ({
  title: "Formula",
  init: () => ({ formula: "=SUM(ABOVE)" }),
  fields: [{ k: "text", key: "formula", label: "Formula:" }],
  submit: (v, c) => c.run("table.formula", { formula: v.formula }),
});

export const tableProperties = (cx: Cx): FormSpec => {
  const u = lenUnit(cx.lang);
  const t = cx.s.ctx.table;
  const unit = u.name === "cm" ? "cm" : "in";
  return {
    title: "Table Properties",
    tabs: ["Table", "Row", "Column", "Cell"],
    init: () => ({
      align: "left",
      indent: 0,
      rowHeight: t ? ptToUnit(t.height, u) : 0,
      rowRule: t?.heightExact ? "exact" : "atLeast",
      allowBreak: true,
      headerRow: !!t?.look.headerRow,
      columnWidth: t ? ptToUnit(t.width, u) : 0,
      valign: "top",
      alt: "",
    }),
    fields: [
      {
        k: "select",
        key: "align",
        label: "Alignment",
        options: [
          ["left", "Left"],
          ["center", "Center"],
          ["right", "Right"],
        ],
      },
      { k: "num", key: "indent", label: "Indent from left:", unit, step: 0.1 },
      { k: "num", key: "rowHeight", label: "Height:", unit, step: 0.1, min: 0, tab: 1 },
      {
        k: "select",
        key: "rowRule",
        label: "Row height is:",
        tab: 1,
        options: [
          ["atLeast", "At least"],
          ["exact", "Exactly"],
        ],
      },
      { k: "check", key: "allowBreak", label: "Allow row to break across pages", tab: 1 },
      {
        k: "check",
        key: "headerRow",
        label: "Repeat as header row at the top of each page",
        tab: 1,
      },
      { k: "num", key: "columnWidth", label: "Width:", unit, step: 0.1, min: 0, tab: 2 },
      {
        k: "select",
        key: "valign",
        label: "Vertical alignment",
        tab: 3,
        options: [
          ["top", "Top"],
          ["center", "Center"],
          ["bottom", "Bottom"],
        ],
      },
    ],
    submit: (v, c) =>
      c.run("table.properties", {
        align: v.align,
        indent: unitToPt(num(v.indent), u),
        rowHeight: num(v.rowHeight) > 0 ? unitToPt(num(v.rowHeight), u) : null,
        rowHeightRule: v.rowRule,
        allowBreak: !!v.allowBreak,
        headerRow: !!v.headerRow,
        columnWidth: num(v.columnWidth) > 0 ? unitToPt(num(v.columnWidth), u) : undefined,
        valign: v.valign,
      }),
  };
};

export const newTableStyle = (): FormSpec => ({
  title: "New Table Style…",
  init: () => ({
    name: "",
    basedOn: "TableGrid",
    headFill: "156082",
    headColor: "FFFFFF",
    band: "E8E8E8",
    apply: true,
  }),
  fields: [
    { k: "text", key: "name", label: "Name:", autoFocus: true },
    { k: "color", key: "headFill", label: "Header row fill:" },
    { k: "color", key: "headColor", label: "Header text color:" },
    { k: "color", key: "band", label: "Banded rows fill:" },
    { k: "check", key: "apply", label: "Apply to table" },
  ],
  submit: (v, c) => {
    if (!String(v.name).trim()) return;
    c.run("table.newStyle", {
      name: v.name,
      basedOn: v.basedOn,
      parts: [
        { part: "headerRow", fill: v.headFill, color: v.headColor, bold: true },
        { part: "band1Horz", fill: v.band },
      ],
      apply: !!v.apply,
    });
  },
});

export const modifyTableStyle = (cx: Cx): FormSpec => ({
  title: "Modify Table Style…",
  init: () => ({
    name: cx.s.ctx.table?.style ?? "",
    headFill: "156082",
    headColor: "FFFFFF",
    band: "E8E8E8",
  }),
  fields: [
    { k: "text", key: "name", label: "Name:" },
    { k: "color", key: "headFill", label: "Header row fill:" },
    { k: "color", key: "headColor", label: "Header text color:" },
    { k: "color", key: "band", label: "Banded rows fill:" },
  ],
  submit: (v, c) =>
    c.run("table.modifyStyle", {
      name: v.name,
      parts: [
        { part: "headerRow", fill: v.headFill, color: v.headColor, bold: true },
        { part: "band1Horz", fill: v.band },
      ],
    }),
});

export const crop = (cx: Cx): FormSpec => ({
  title: "Crop",
  init: () => {
    const c = cx.s.ctx.object?.crop ?? [0, 0, 0, 0];
    return {
      left: Math.round(c[0] * 100),
      top: Math.round(c[1] * 100),
      right: Math.round(c[2] * 100),
      bottom: Math.round(c[3] * 100),
    };
  },
  fields: [
    { k: "num", key: "left", label: "Left:", unit: "%", min: 0, max: 45 },
    { k: "num", key: "top", label: "Top:", unit: "%", min: 0, max: 45 },
    { k: "num", key: "right", label: "Right:", unit: "%", min: 0, max: 45 },
    { k: "num", key: "bottom", label: "Bottom:", unit: "%", min: 0, max: 45 },
  ],
  submit: (v, c) =>
    c.run("picture.crop", {
      left: num(v.left) / 100,
      top: num(v.top) / 100,
      right: num(v.right) / 100,
      bottom: num(v.bottom) / 100,
    }),
});

/* ---------------- Списки стилей ---------------- */

export const createStyle = (): FormSpec => ({
  title: "Create a Style",
  init: () => ({ name: "", fromSelection: true }),
  fields: [
    { k: "text", key: "name", label: "Name:", autoFocus: true },
    { k: "check", key: "fromSelection", label: "Update Style to Match Selection" },
  ],
  submit: (v, c) => {
    if (String(v.name).trim()) {
      c.run("styles.create", { name: v.name, fromSelection: !!v.fromSelection });
      window.dispatchEvent(new CustomEvent("wd-styles-changed"));
    }
  },
});

/* ---------------- Рассылки ---------------- */

export const envelopes = (): FormSpec => ({
  title: "Envelopes",
  size: "wide",
  init: () => ({ delivery: "", ret: "", size: "Envelope #10", add: false }),
  fields: [
    { k: "area", key: "delivery", label: "Delivery address:", rows: 4 },
    { k: "area", key: "ret", label: "Return address:", rows: 3 },
    {
      k: "select",
      key: "size",
      label: "Envelope size:",
      raw: true,
      options: ["Envelope #10", "Envelope #9", "Monarch", "DL", "C4", "C5", "C6", "B5"].map((n) => [
        n,
        n,
      ]),
    },
    { k: "check", key: "add", label: "Add to Document" },
  ],
  submit: (v, c) =>
    c.run("mailings.envelopes", {
      delivery: v.delivery,
      return: v.ret || undefined,
      size: v.size,
      add: !!v.add,
    }),
});

export const labels = (): FormSpec => ({
  title: "Labels",
  size: "wide",
  init: () => ({ text: "", product: "a4-3x7", fromRecipients: false }),
  fields: [
    { k: "area", key: "text", label: "Address:", rows: 4 },
    {
      k: "select",
      key: "product",
      label: "Label products:",
      raw: true,
      options: [
        "letter-3x10",
        "letter-2x10",
        "letter-2x7",
        "letter-2x5",
        "letter-4x20",
        "a4-3x7",
        "a4-2x7",
        "a4-3x8",
        "a4-2x4",
      ].map((n) => [n, n]),
    },
    { k: "check", key: "fromRecipients", label: "Use merge fields from the recipient list" },
  ],
  submit: (v, c) =>
    c.run("mailings.labels", {
      text: v.text,
      product: v.product,
      fromRecipients: !!v.fromRecipients,
    }),
});

export const finishMerge = (): FormSpec => ({
  title: "Finish & Merge",
  init: () => ({ from: "", to: "" }),
  fields: [
    { k: "num", key: "from", label: "From:", min: 1 },
    { k: "num", key: "to", label: "To:", min: 1 },
    { k: "note", text: "Leave empty to merge all records." },
  ],
  submit: (v, c) =>
    c.run("mailings.finish", {
      from: v.from === "" ? undefined : num(v.from),
      to: v.to === "" ? undefined : num(v.to),
    }),
});

export const findRecipient = (): FormSpec => ({
  title: "Find Recipient",
  init: () => ({ text: "" }),
  fields: [{ k: "text", key: "text", label: "Find:" }],
  submit: (v, c) => c.run("mailings.findRecipient", { text: v.text }),
});

export const insertMergeField = (): FormSpec => ({
  title: "Insert Merge Field",
  init: () => ({ field: "" }),
  fields: [
    { k: "text", key: "field", label: "Fields:", autoFocus: true },
    { k: "note", text: "Type the name of a column from the recipient list." },
  ],
  submit: (v, c) => {
    if (String(v.field).trim()) c.run("mailings.insertField", { field: v.field });
  },
});

export const matchFields = (): FormSpec => ({
  title: "Match Fields",
  noOk: true,
  init: () => ({}),
  fields: [{ k: "note", text: "Fields are matched by column name." }],
  submit: () => undefined,
});

export const controlProperties = (): FormSpec => ({
  title: "Properties",
  init: () => ({ title: "", tag: "", lockDelete: false, lockEdit: false }),
  fields: [
    { k: "text", key: "title", label: "Title:" },
    { k: "text", key: "tag", label: "Tag:" },
    { k: "check", key: "lockDelete", label: "Content control cannot be deleted" },
    { k: "check", key: "lockEdit", label: "Contents cannot be edited" },
  ],
  submit: (v, c) =>
    c.run("developer.properties", {
      title: v.title,
      tag: v.tag,
      lockDelete: !!v.lockDelete,
      lockEdit: !!v.lockEdit,
    }),
});

export type FormMaker = (cx: Cx) => FormSpec;
export type { Vals };
