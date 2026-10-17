import type { FormSpec, Vals } from "@/pages/word/dialogs/form";
import type { SheetCx } from "@/pages/sheet/types";

type S = FormSpec<SheetCx>;

const num = (v: string | number | boolean | undefined, d = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};
const list = (s: string): string[] =>
  String(s)
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const hexToColor = (h: unknown): unknown => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? ""));
  return m ? { Rgb: parseInt(m[1], 16) } : "Auto";
};
const opts = (...a: [string, string][]): [string, string][] => a;

const NUM_CATEGORIES: [string, string, string][] = [
  ["General", "General", "General"],
  ["Number", "Number", "0.00"],
  ["Currency", "Currency", "$#,##0.00"],
  ["Accounting", "Accounting", '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'],
  ["Date", "Date", "m/d/yyyy"],
  ["Time", "Time", "h:mm:ss AM/PM"],
  ["Percentage", "Percentage", "0.00%"],
  ["Fraction", "Fraction", "# ?/?"],
  ["Scientific", "Scientific", "0.00E+00"],
  ["Text", "Text", "@"],
  ["Custom", "Custom", "General"],
];

const BORDER_STYLES = opts(
  ["None", "None"],
  ["Hair", "Hair"],
  ["Thin", "Thin"],
  ["Dotted", "Dotted"],
  ["Dashed", "Dashed"],
  ["DashDot", "Dash-dot"],
  ["DashDotDot", "Dash-dot-dot"],
  ["Medium", "Medium"],
  ["MediumDashed", "Medium dashed"],
  ["MediumDashDot", "Medium dash-dot"],
  ["MediumDashDotDot", "Medium dash-dot-dot"],
  ["SlantDashDot", "Slanted dash-dot"],
  ["Thick", "Thick"],
  ["Double", "Double"],
);

const SIDES: [string, string][] = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
  ["diag_down", "Diagonal down"],
  ["diag_up", "Diagonal up"],
];

const borderFields: S["fields"] = SIDES.flatMap(([k, label]): S["fields"] => [
  { k: "select", key: `b_${k}`, label, options: BORDER_STYLES, tab: 3 },
  { k: "color", key: `bc_${k}`, tab: 3, show: (v: Vals) => v[`b_${k}`] !== "None" },
]);

const cmpOps = opts(
  ["between", "between"],
  ["notBetween", "not between"],
  ["equal", "equal to"],
  ["notEqual", "not equal to"],
  ["greater", "greater than"],
  ["less", "less than"],
  ["greaterOrEqual", "greater than or equal to"],
  ["lessOrEqual", "less than or equal to"],
);

export const FORMS2: Record<string, S> = {
  formatCells: {
    title: "Format Cells",
    tabs: ["Number", "Alignment", "Font", "Border", "Fill", "Protection"],
    size: "wide",
    fields: [
      // Число
      { k: "select", key: "cat", label: "Category:", options: NUM_CATEGORIES.map(([k, l]): [string, string] => [k, l]), tab: 0 },
      { k: "text", key: "code", label: "Format code:", tab: 0, show: (v) => v.cat !== "General" && v.cat !== "Text" },
      // Выравнивание
      {
        k: "select",
        key: "h",
        label: "Horizontal:",
        options: opts(
          ["General", "General"],
          ["Left", "Left (Indent)"],
          ["Center", "Center"],
          ["Right", "Right (Indent)"],
          ["Fill", "Fill"],
          ["Justify", "Justify"],
          ["CenterAcross", "Center Across Selection"],
          ["Distributed", "Distributed (Indent)"],
        ),
        tab: 1,
      },
      { k: "num", key: "indent", label: "Indent:", min: 0, max: 250, step: 1, tab: 1 },
      {
        k: "select",
        key: "v",
        label: "Vertical:",
        options: opts(["Top", "Top"], ["Center", "Center"], ["Bottom", "Bottom"], ["Justify", "Justify"], ["Distributed", "Distributed"]),
        tab: 1,
      },
      { k: "num", key: "rotation", label: "Orientation:", min: -90, max: 90, step: 1, unit: "degrees", tab: 1 },
      { k: "check", key: "wrap", label: "Wrap text", tab: 1 },
      { k: "check", key: "shrink", label: "Shrink to fit", tab: 1 },
      // Шрифт
      { k: "text", key: "font", label: "Font:", tab: 2 },
      { k: "num", key: "size", label: "Size:", min: 1, max: 409, step: 1, tab: 2 },
      { k: "check", key: "bold", label: "Bold", tab: 2 },
      { k: "check", key: "italic", label: "Italic", tab: 2 },
      {
        k: "select",
        key: "underline",
        label: "Underline:",
        options: opts(
          ["None", "None"],
          ["Single", "Single"],
          ["Double", "Double"],
          ["SingleAccounting", "Single Accounting"],
          ["DoubleAccounting", "Double Accounting"],
        ),
        tab: 2,
      },
      { k: "color", key: "color", label: "Color:", tab: 2 },
      { k: "check", key: "strike", label: "Strikethrough", tab: 2 },
      {
        k: "select",
        key: "vert",
        label: "Effects:",
        options: opts(["Baseline", "Normal"], ["Superscript", "Superscript"], ["Subscript", "Subscript"]),
        tab: 2,
      },
      // Границы
      ...borderFields,
      // Заливка
      { k: "color", key: "fill", label: "Background Color:", allowNone: true, noneLabel: "No Color", tab: 4 },
      {
        k: "select",
        key: "pattern",
        label: "Pattern Style:",
        options: opts(
          ["Solid", "Solid"],
          ["Gray50", "50% Gray"],
          ["Gray75", "75% Gray"],
          ["Gray25", "25% Gray"],
          ["Gray125", "12.5% Gray"],
          ["Gray0625", "6.25% Gray"],
          ["DarkHorizontal", "Horizontal Stripe"],
          ["DarkVertical", "Vertical Stripe"],
          ["DarkDown", "Reverse Diagonal Stripe"],
          ["DarkUp", "Diagonal Stripe"],
          ["DarkGrid", "Diagonal Crosshatch"],
          ["DarkTrellis", "Thick Diagonal Crosshatch"],
          ["LightHorizontal", "Thin Horizontal Stripe"],
          ["LightVertical", "Thin Vertical Stripe"],
          ["LightDown", "Thin Reverse Diagonal Stripe"],
          ["LightUp", "Thin Diagonal Stripe"],
          ["LightGrid", "Thin Horizontal Crosshatch"],
          ["LightTrellis", "Thin Diagonal Crosshatch"],
        ),
        tab: 4,
      },
      { k: "color", key: "patternColor", label: "Pattern Color:", tab: 4, show: (v) => v.pattern !== "Solid" },
      // Защита
      { k: "check", key: "locked", label: "Locked", tab: 5 },
      { k: "check", key: "hidden", label: "Hidden", tab: 5 },
      { k: "note", text: "Locking cells or hiding formulas has no effect until you protect the worksheet (Review tab › Protect Sheet).", tab: 5 },
    ],
    init: (cx, p) => {
      const f = cx.s.format;
      const code = f.numFmt;
      const known = NUM_CATEGORIES.find(([, , c]) => c === code);
      const side = (b: unknown): [string, string] => {
        const t = b as [number, string, string] | null;
        return t ? [t[2], t[1]] : ["None", "#000000"];
      };
      const out: Vals = {
        cat: String(p.tab) === "number" && p.cat ? String(p.cat) : known ? known[0] : /^(General)$/.test(code) ? "General" : "Custom",
        code,
        h: f.h,
        indent: f.indent,
        v: f.v,
        rotation: f.rotation === 255 ? 0 : f.rotation,
        wrap: f.wrap,
        shrink: f.shrink,
        font: f.font,
        size: f.size,
        bold: f.bold,
        italic: f.italic,
        underline: f.underline,
        color: f.color ?? "#000000",
        strike: f.strike,
        vert: f.vert,
        fill: f.fill ?? "",
        pattern: "Solid",
        patternColor: "#000000",
        locked: f.locked,
        hidden: f.hiddenFormula,
      };
      const sides: Record<string, unknown> = { top: f.borders.t, bottom: f.borders.b, left: f.borders.l, right: f.borders.r, diag_down: f.borders.d, diag_up: f.borders.u };
      for (const [k] of SIDES) {
        const [st, c] = side(sides[k]);
        out[`b_${k}`] = st;
        out[`bc_${k}`] = c;
      }
      return out;
    },
    submit: (v, cx) => {
      const cat = String(v.cat);
      const code = cat === "Custom" || cat === "General" || cat === "Text" ? (cat === "Custom" ? String(v.code) : NUM_CATEGORIES.find(([k]) => k === cat)![2]) : String(v.code);
      const borders: Record<string, unknown> = {};
      for (const [k] of SIDES) {
        const st = String(v[`b_${k}`]);
        borders[k] = { style: st, color: st === "None" ? "Auto" : hexToColor(v[`bc_${k}`]) };
      }
      const fill = v.fill ? (v.pattern === "Solid" ? { pattern: "Solid", fg: hexToColor(v.fill), bg: "Auto" } : { pattern: v.pattern, fg: hexToColor(v.patternColor), bg: hexToColor(v.fill) }) : { pattern: "None", fg: "Auto", bg: "Auto" };
      cx.run("home.formatCells", {
        style: {
          num_fmt: code,
          align: { h: v.h, v: v.v, wrap: !!v.wrap, shrink: !!v.shrink, indent: num(v.indent), rotation: num(v.rotation) },
          font: { name: String(v.font), size: num(v.size, 11), bold: !!v.bold, italic: !!v.italic, underline: v.underline, strike: !!v.strike, color: hexToColor(v.color), vert: v.vert },
          borders,
          fill,
          protection: { locked: !!v.locked, hidden: !!v.hidden },
        },
      });
    },
  },
  sort: {
    title: "Sort",
    size: "wide",
    fields: [
      { k: "check", key: "header", label: "My data has headers" },
      { k: "text", key: "col1", label: "Sort by (column letter):", autoFocus: true },
      { k: "select", key: "by1", options: opts(["values", "Cell Values"], ["cellColor", "Cell Color"], ["fontColor", "Font Color"]) },
      { k: "select", key: "ord1", options: opts(["asc", "A to Z"], ["desc", "Z to A"]) },
      { k: "text", key: "col2", label: "Then by (column letter):" },
      { k: "select", key: "ord2", options: opts(["asc", "A to Z"], ["desc", "Z to A"]), show: (v) => !!String(v.col2).trim() },
      { k: "text", key: "col3", label: "Then by (column letter):", show: (v) => !!String(v.col2).trim() },
      { k: "select", key: "ord3", options: opts(["asc", "A to Z"], ["desc", "Z to A"]), show: (v) => !!String(v.col3).trim() },
      { k: "check", key: "matchCase", label: "Case sensitive" },
      { k: "radio", key: "orientation", options: opts(["rows", "Sort top to bottom"], ["columns", "Sort left to right"]) },
    ],
    init: (cx) => ({ header: true, col1: String(cx.s.sel.a1).replace(/[0-9]+.*$/, "") || "A", by1: "values", ord1: "asc", col2: "", ord2: "asc", col3: "", ord3: "asc", matchCase: false, orientation: "rows" }),
    submit: (v, cx) => {
      const keys = [1, 2, 3]
        .map((n) => ({ column: String(v[`col${n}`]).trim().toUpperCase(), order: String(v[`ord${n}`]), ...(n === 1 && v.by1 !== "values" ? { by: v.by1 } : {}) }))
        .filter((k) => k.column);
      if (keys.length) cx.run("data.sort", { header: !!v.header, keys, orientation: v.orientation, matchCase: !!v.matchCase });
    },
  },
  dataValidation: {
    title: "Data Validation",
    tabs: ["Settings", "Input Message", "Error Alert"],
    fields: [
      {
        k: "select",
        key: "type",
        label: "Allow:",
        options: opts(
          ["any", "Any value"],
          ["whole", "Whole number"],
          ["decimal", "Decimal"],
          ["list", "List"],
          ["date", "Date"],
          ["time", "Time"],
          ["textLength", "Text length"],
          ["custom", "Custom"],
        ),
        tab: 0,
      },
      { k: "select", key: "operator", label: "Data:", options: cmpOps, tab: 0, show: (v) => !["any", "list", "custom"].includes(String(v.type)) },
      { k: "text", key: "formula1", label: "Minimum / Value / Source:", tab: 0, show: (v) => v.type !== "any" },
      { k: "text", key: "formula2", label: "Maximum:", tab: 0, show: (v) => !["any", "list", "custom"].includes(String(v.type)) && /between/i.test(String(v.operator)) },
      { k: "check", key: "ignoreBlank", label: "Ignore blank", tab: 0 },
      { k: "check", key: "dropdown", label: "In-cell dropdown", tab: 0, show: (v) => v.type === "list" },
      { k: "text", key: "inputTitle", label: "Title:", tab: 1 },
      { k: "area", key: "inputMessage", label: "Input message:", tab: 1 },
      { k: "select", key: "errorStyle", label: "Style:", options: opts(["stop", "Stop"], ["warning", "Warning"], ["information", "Information"]), tab: 2 },
      { k: "text", key: "errorTitle", label: "Title:", tab: 2 },
      { k: "area", key: "errorMessage", label: "Error message:", tab: 2 },
    ],
    init: (cx) => {
      const val = cx.s.ctx.validation as Record<string, unknown> | null;
      return {
        type: String(val?.type ?? "any"),
        operator: String(val?.operator ?? "between"),
        formula1: String(val?.formula1 ?? ""),
        formula2: String(val?.formula2 ?? ""),
        ignoreBlank: val?.ignoreBlank !== false,
        dropdown: val?.dropdown !== false,
        inputTitle: String(val?.inputTitle ?? ""),
        inputMessage: String(val?.inputMessage ?? ""),
        errorStyle: String(val?.errorStyle ?? "stop"),
        errorTitle: String(val?.errorTitle ?? ""),
        errorMessage: String(val?.errorMessage ?? ""),
      };
    },
    submit: (v, cx) => {
      if (v.type === "any" && !v.inputMessage) return cx.run("data.validation", { clear: true, type: "any" });
      cx.run("data.validation", {
        type: v.type,
        ...(["any", "list", "custom"].includes(String(v.type)) ? {} : { operator: v.operator }),
        formula1: String(v.formula1),
        ...(String(v.formula2) ? { formula2: String(v.formula2) } : {}),
        ignoreBlank: !!v.ignoreBlank,
        dropdown: !!v.dropdown,
        inputTitle: String(v.inputTitle),
        inputMessage: String(v.inputMessage),
        errorStyle: v.errorStyle,
        errorTitle: String(v.errorTitle),
        errorMessage: String(v.errorMessage),
      });
    },
  },
  textToColumns: {
    title: "Convert Text to Columns",
    fields: [
      { k: "check", key: "tab", label: "Tab" },
      { k: "check", key: "semicolon", label: "Semicolon" },
      { k: "check", key: "comma", label: "Comma delimiter" },
      { k: "check", key: "space", label: "Space" },
      { k: "text", key: "other", label: "Other:" },
      { k: "check", key: "treatConsecutive", label: "Treat consecutive delimiters as one" },
      { k: "text", key: "destination", label: "Destination:" },
    ],
    init: (cx) => ({ tab: false, semicolon: false, comma: true, space: false, other: "", treatConsecutive: false, destination: cx.s.sel.a1.split(":")[0] }),
    submit: (v, cx) => {
      const delimiters = [v.tab && "\t", v.semicolon && ";", v.comma && ",", v.space && " "].filter(Boolean);
      cx.run("data.textToColumns", {
        delimiters,
        ...(String(v.other) ? { other: String(v.other) } : {}),
        treatConsecutive: !!v.treatConsecutive,
        destination: String(v.destination),
      });
    },
  },
  removeDuplicates: {
    title: "Remove Duplicates",
    fields: [
      { k: "check", key: "header", label: "My data has headers" },
      { k: "text", key: "columns", label: "Columns (letters, separated by commas; empty = all):" },
    ],
    init: () => ({ header: true, columns: "" }),
    submit: (v, cx) => {
      const columns = list(String(v.columns)).map((c) => c.toUpperCase());
      cx.run("data.removeDuplicates", { header: !!v.header, ...(columns.length ? { columns } : {}) });
    },
  },
  subtotal: {
    title: "Subtotal",
    fields: [
      { k: "text", key: "groupBy", label: "At each change in (column):" },
      { k: "select", key: "function", label: "Use function:", options: opts(["sum", "Sum"], ["count", "Count"], ["average", "Average"], ["max", "Max"], ["min", "Min"], ["product", "Product"]) },
      { k: "text", key: "columns", label: "Add subtotal to (columns):" },
    ],
    init: () => ({ groupBy: "A", function: "sum", columns: "B" }),
    submit: (v, cx) =>
      cx.run("data.subtotal", { groupBy: String(v.groupBy).toUpperCase(), function: v.function, columns: list(String(v.columns)).map((c) => c.toUpperCase()), header: true }),
  },
  advancedFilter: {
    title: "Advanced Filter",
    fields: [
      { k: "radio", key: "action", options: opts(["filter", "Filter the list, in-place"], ["copy", "Copy to another location"]) },
      { k: "text", key: "list", label: "List range:" },
      { k: "text", key: "criteria", label: "Criteria range:" },
      { k: "text", key: "copyTo", label: "Copy to:", show: (v) => v.action === "copy" },
      { k: "check", key: "unique", label: "Unique records only" },
    ],
    init: (cx) => ({ action: "filter", list: cx.s.sel.a1, criteria: "", copyTo: "", unique: false }),
    submit: (v, cx) =>
      cx.run("data.advancedFilter", {
        listRange: String(v.list),
        criteriaRange: String(v.criteria),
        ...(v.action === "copy" ? { copyTo: String(v.copyTo) } : {}),
        unique: !!v.unique,
      }),
  },
  consolidate: {
    title: "Consolidate",
    fields: [
      { k: "select", key: "function", label: "Function:", options: opts(["sum", "Sum"], ["count", "Count"], ["countNums", "Count Numbers"], ["average", "Average"], ["max", "Max"], ["min", "Min"], ["product", "Product"]) },
      { k: "area", key: "sources", label: "References (one per line):", rows: 5 },
      { k: "text", key: "destination", label: "Destination:" },
      { k: "check", key: "topRow", label: "Top row" },
      { k: "check", key: "leftColumn", label: "Left column" },
    ],
    init: (cx) => ({ function: "sum", sources: "", destination: cx.s.sel.a1.split(":")[0], topRow: false, leftColumn: false }),
    submit: (v, cx) =>
      cx.run("data.consolidate", {
        function: v.function,
        sources: String(v.sources).split(/\n+/).map((x) => x.trim()).filter(Boolean),
        destination: String(v.destination),
        topRow: !!v.topRow,
        leftColumn: !!v.leftColumn,
      }),
  },
  goalSeek: {
    title: "Goal Seek",
    fields: [
      { k: "text", key: "set", label: "Set cell:" },
      { k: "text", key: "to", label: "To value:" },
      { k: "text", key: "changing", label: "By changing cell:" },
    ],
    init: (cx) => ({ set: cx.s.sel.a1.split(":")[0], to: "", changing: "" }),
    submit: async (v, cx) => {
      const r = (await cx.call("data.goalSeek", { set: String(v.set), to: num(v.to), changing: String(v.changing) })) as { result?: unknown; converged?: boolean; value?: unknown } | undefined;
      cx.ui.status(r?.converged ? `${cx.tw("Goal Seeking found a solution.")} ${String(r.value ?? "")}` : cx.tw("Goal Seeking may not have found a solution."));
    },
  },
  dataTable: {
    title: "Data Table",
    fields: [
      { k: "text", key: "range", label: "Table range:" },
      { k: "text", key: "rowInput", label: "Row input cell:" },
      { k: "text", key: "columnInput", label: "Column input cell:" },
    ],
    init: (cx) => ({ range: cx.s.sel.a1, rowInput: "", columnInput: "" }),
    submit: (v, cx) =>
      cx.run("data.dataTable", {
        range: String(v.range),
        ...(String(v.rowInput) ? { rowInput: String(v.rowInput) } : {}),
        ...(String(v.columnInput) ? { columnInput: String(v.columnInput) } : {}),
      }),
  },
  forecastSheet: {
    title: "Create Forecast Worksheet",
    fields: [
      { k: "text", key: "timeline", label: "Timeline range:" },
      { k: "text", key: "values", label: "Values range:" },
      { k: "num", key: "periods", label: "Forecast periods:", min: 1, step: 1 },
    ],
    init: () => ({ timeline: "", values: "", periods: 10 }),
    submit: (v, cx) =>
      cx.run("data.forecastSheet", {
        ...(String(v.timeline) ? { timeline: String(v.timeline) } : {}),
        ...(String(v.values) ? { values: String(v.values) } : {}),
        periods: num(v.periods, 10),
      }),
  },
  createNames: {
    title: "Create Names from Selection",
    fields: [
      { k: "check", key: "top", label: "Top row" },
      { k: "check", key: "left", label: "Left column" },
      { k: "check", key: "bottom", label: "Bottom row" },
      { k: "check", key: "right", label: "Right column" },
    ],
    init: () => ({ top: true, left: false, bottom: false, right: false }),
    submit: (v, cx) => cx.run("formulas.createFromSelection", { top: !!v.top, left: !!v.left, bottom: !!v.bottom, right: !!v.right }),
  },
  insertLink: {
    title: "Insert Hyperlink",
    fields: [
      { k: "text", key: "text", label: "Text to display:" },
      { k: "text", key: "target", label: "Address:", autoFocus: true },
      { k: "text", key: "tooltip", label: "ScreenTip:" },
    ],
    init: (cx) => {
      const l = cx.s.ctx.link as { target?: string; tooltip?: string } | null;
      return { text: "", target: l?.target ?? "", tooltip: l?.tooltip ?? "" };
    },
    submit: (v, cx) =>
      cx.run("insert.link", { target: String(v.target), ...(String(v.text) ? { text: String(v.text) } : {}), ...(String(v.tooltip) ? { tooltip: String(v.tooltip) } : {}) }),
  },
  symbol: {
    title: "Symbol",
    fields: [{ k: "text", key: "char", label: "Character:", autoFocus: true }],
    init: () => ({ char: "" }),
    submit: (v, cx) => cx.run("insert.symbol", { char: String(v.char) }),
  },
  sparkline: {
    title: "Create Sparklines",
    fields: [
      { k: "select", key: "type", label: "Type:", options: opts(["line", "Line"], ["column", "Column"], ["winLoss", "Win/Loss"]) },
      { k: "text", key: "range", label: "Data range:" },
      { k: "text", key: "location", label: "Location range:" },
      { k: "check", key: "markers", label: "Markers", show: (v) => v.type === "line" },
    ],
    init: (cx, p) => ({ type: String(p.type ?? "line"), range: cx.s.sel.a1, location: "", markers: false }),
    submit: (v, cx) => cx.run("insert.sparkline", { type: v.type, range: String(v.range), location: String(v.location), markers: !!v.markers }),
  },
  slicer: {
    title: "Insert Slicers",
    fields: [{ k: "text", key: "column", label: "Column (header text):" }],
    init: () => ({ column: "" }),
    submit: (v, cx) => cx.run("insert.slicer", { column: String(v.column) }),
  },
  renameTable: {
    title: "Table Name",
    fields: [{ k: "text", key: "name", label: "Table name:", autoFocus: true }],
    init: (cx) => ({ name: String((cx.s.ctx.table as { name?: string } | null)?.name ?? "") }),
    submit: (v, cx) => cx.run("table.rename", { name: String(v.name) }),
  },
  resizeTable: {
    title: "Resize Table",
    fields: [{ k: "text", key: "range", label: "Select the new data range for your table:" }],
    init: (cx) => ({ range: String((cx.s.ctx.table as { range?: string } | null)?.range ?? cx.s.sel.a1) }),
    submit: (v, cx) => cx.run("table.resize", { range: String(v.range) }),
  },
  printTitles: {
    title: "Print Titles",
    fields: [
      { k: "text", key: "rows", label: "Rows to repeat at top:" },
      { k: "text", key: "cols", label: "Columns to repeat at left:" },
    ],
    init: () => ({ rows: "", cols: "" }),
    submit: (v, cx) => cx.run("pageLayout.printTitles", { ...(String(v.rows) ? { rows: String(v.rows) } : {}), ...(String(v.cols) ? { cols: String(v.cols) } : {}) }),
  },
  pageSetup: {
    title: "Page Setup",
    tabs: ["Page", "Margins", "Scaling"],
    fields: [
      { k: "radio", key: "orientation", options: opts(["portrait", "Portrait"], ["landscape", "Landscape"]), tab: 0 },
      { k: "select", key: "paper", label: "Paper size:", options: ["Letter", "Legal", "A4", "A3", "A5", "Tabloid", "Executive", "Ledger", "B5"].map((x): [string, string] => [x, x]), raw: true, tab: 0 },
      { k: "num", key: "top", label: "Top:", min: 0, step: 0.05, unit: "in", tab: 1 },
      { k: "num", key: "bottom", label: "Bottom:", min: 0, step: 0.05, unit: "in", tab: 1 },
      { k: "num", key: "left", label: "Left:", min: 0, step: 0.05, unit: "in", tab: 1 },
      { k: "num", key: "right", label: "Right:", min: 0, step: 0.05, unit: "in", tab: 1 },
      { k: "num", key: "scale", label: "Adjust to (%):", min: 10, max: 400, step: 5, tab: 2 },
      { k: "num", key: "fitWidth", label: "Fit to pages wide (0 = auto):", min: 0, step: 1, tab: 2 },
      { k: "num", key: "fitHeight", label: "Pages tall (0 = auto):", min: 0, step: 1, tab: 2 },
    ],
    init: () => ({ orientation: "portrait", paper: "Letter", top: 0.75, bottom: 0.75, left: 0.7, right: 0.7, scale: 100, fitWidth: 0, fitHeight: 0 }),
    submit: (v, cx) =>
      cx.run("pageLayout.pageSetup", {
        orientation: v.orientation,
        paper: v.paper,
        margins: { top: num(v.top), bottom: num(v.bottom), left: num(v.left), right: num(v.right) },
        ...(num(v.fitWidth) || num(v.fitHeight) ? { fitWidth: num(v.fitWidth), fitHeight: num(v.fitHeight) } : { scale: num(v.scale, 100) }),
      }),
  },
  insertFunction: {
    title: "Insert Function",
    size: "wide",
    fields: [
      { k: "text", key: "q", label: "Search for a function:", autoFocus: true },
      { k: "select", key: "name", label: "Select a function:", options: (cx) => FUNCS.map((n): [string, string] => [n, n]).concat(cx.s.names.map((n): [string, string] => [String((n as { name?: string }).name ?? n), String((n as { name?: string }).name ?? n)])), raw: true },
    ],
    init: () => ({ q: "", name: "SUM" }),
    submit: (v, cx) => {
      const name = String(v.name || v.q).trim().toUpperCase();
      if (name) cx.ui.edit.type(`=${name}(`);
    },
  },
};

const FUNCS = [
  "ABS", "AND", "AVERAGE", "AVERAGEIF", "AVERAGEIFS", "CEILING", "CHOOSE", "CONCAT", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS",
  "DATE", "DAY", "EDATE", "EOMONTH", "EXACT", "FILTER", "FIND", "FLOOR", "HLOOKUP", "IF", "IFERROR", "IFNA", "IFS", "INDEX", "INT", "LEFT", "LEN",
  "LET", "LOWER", "MATCH", "MAX", "MID", "MIN", "MOD", "MONTH", "NOW", "OR", "PMT", "PROPER", "RAND", "RANDBETWEEN", "REPLACE", "RIGHT", "ROUND",
  "ROUNDDOWN", "ROUNDUP", "SEQUENCE", "SORT", "SORTBY", "SQRT", "SUBSTITUTE", "SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "SWITCH", "TEXT", "TEXTJOIN",
  "TODAY", "TRIM", "UNIQUE", "UPPER", "VLOOKUP", "WEEKDAY", "XLOOKUP", "XMATCH", "YEAR",
];
