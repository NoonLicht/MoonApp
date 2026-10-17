import type { FormSpec, Vals } from "@/pages/word/dialogs/form";
import type { SheetCx } from "@/pages/sheet/types";

type S = FormSpec<SheetCx>;
type Opt = [string, string];

const num = (v: string | number | boolean | undefined, d = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};
const opts = (...a: Opt[]): Opt[] => a;
const str = (v: unknown): string => String(v ?? "");
const lines = (s: unknown): string[] =>
  str(s)
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const PRESETS = opts(
  ["lightRedFillDarkRedText", "Light Red Fill with Dark Red Text"],
  ["yellowFillDarkYellowText", "Yellow Fill with Dark Yellow Text"],
  ["greenFillDarkGreenText", "Green Fill with Dark Green Text"],
  ["lightRedFill", "Light Red Fill"],
  ["redText", "Red Text"],
  ["redBorder", "Red Border"],
);

const PERIODS = opts(
  ["yesterday", "Yesterday"],
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["last7Days", "In the last 7 days"],
  ["lastWeek", "Last week"],
  ["thisWeek", "This week"],
  ["nextWeek", "Next week"],
  ["lastMonth", "Last month"],
  ["thisMonth", "This month"],
  ["nextMonth", "Next month"],
);

const CF_TYPES = opts(
  ["cellIs", "Format only cells that contain"],
  ["containsText", "Format only cells that contain text"],
  ["beginsWith", "Format only cells that begin with"],
  ["endsWith", "Format only cells that end with"],
  ["blanks", "Format only blank cells"],
  ["noBlanks", "Format only cells with no blanks"],
  ["errors", "Format only cells with errors"],
  ["noErrors", "Format only cells with no errors"],
  ["duplicate", "Format only duplicate values"],
  ["unique", "Format only unique values"],
  ["top10", "Format only top or bottom ranked values"],
  ["aboveAverage", "Format only values above or below average"],
  ["timePeriod", "Format only cells that contain a date"],
  ["expression", "Use a formula to determine which cells to format"],
  ["colorScale", "Format all cells based on their values: Color Scale"],
  ["dataBar", "Format all cells based on their values: Data Bar"],
  ["iconSet", "Format all cells based on their values: Icon Set"],
);

const CELL_OPS = opts(
  ["between", "between"],
  ["notBetween", "not between"],
  ["=", "equal to"],
  ["<>", "not equal to"],
  [">", "greater than"],
  ["<", "less than"],
  [">=", "greater than or equal to"],
  ["<=", "less than or equal to"],
);

const ICON_SETS = opts(
  ["3Arrows", "3 Arrows (Colored)"],
  ["3ArrowsGray", "3 Arrows (Gray)"],
  ["4Arrows", "4 Arrows (Colored)"],
  ["4ArrowsGray", "4 Arrows (Gray)"],
  ["5Arrows", "5 Arrows (Colored)"],
  ["5ArrowsGray", "5 Arrows (Gray)"],
  ["3TrafficLights1", "3 Traffic Lights (Unrimmed)"],
  ["3TrafficLights2", "3 Traffic Lights (Rimmed)"],
  ["4TrafficLights", "4 Traffic Lights"],
  ["3Symbols", "3 Symbols (Circled)"],
  ["3Symbols2", "3 Symbols (Uncircled)"],
  ["3Flags", "3 Flags"],
  ["3Stars", "3 Stars"],
  ["5Quarters", "5 Quarters"],
  ["5Rating", "5 Ratings"],
);

const OBJ_KINDS = new Set(["chart", "image", "shape"]);
const objOf = (cx: SheetCx): { kind: string; id: number } | null => {
  const o = cx.ui.selObj;
  return o && OBJ_KINDS.has(o.kind) ? o : null;
};

const CHART_TYPES = opts(
  ["column", "Column"],
  ["bar", "Bar"],
  ["line", "Line"],
  ["pie", "Pie"],
  ["doughnut", "Doughnut"],
  ["area", "Area"],
  ["scatter", "Scatter"],
  ["bubble", "Bubble"],
  ["radar", "Radar"],
  ["combo", "Combo"],
  ["histogram", "Histogram"],
  ["waterfall", "Waterfall"],
  ["funnel", "Funnel"],
  ["treemap", "Treemap"],
  ["sunburst", "Sunburst"],
  ["boxWhisker", "Box and Whisker"],
  ["stock", "Stock"],
);
const CHART_SUBTYPES = opts(["clustered", "Clustered"], ["stacked", "Stacked"], ["stacked100", "100% Stacked"], ["markers", "With markers"]);

/** Правило условного форматирования из значений формы. */
function cfRule(v: Vals): Record<string, unknown> {
  const type = str(v.type);
  const r: Record<string, unknown> = { type };
  if (type === "cellIs") {
    r.operator = v.operator;
    r.value = str(v.value);
    if (/between/i.test(str(v.operator))) r.value2 = str(v.value2);
  } else if (["containsText", "beginsWith", "endsWith"].includes(type)) r.text = str(v.text);
  else if (type === "expression") r.formula = str(v.formula);
  else if (type === "top10") {
    r.rank = num(v.rank, 10);
    r.bottom = v.rankSide === "bottom";
    r.percent = !!v.percent;
  } else if (type === "aboveAverage") r.below = v.avgSide === "below";
  else if (type === "timePeriod") r.period = v.period;
  else if (type === "colorScale") r.colors = v.scale === "three" ? [v.c1, v.c2, v.c3] : [v.c1, v.c3];
  else if (type === "dataBar") r.color = v.barColor;
  else if (type === "iconSet") r.set = v.iconSet;
  if (!["colorScale", "dataBar", "iconSet"].includes(type)) r.preset = v.preset;
  return r;
}

const ruleFields = (quick: boolean): S["fields"] => {
  const showT = (...t: string[]) => (v: Vals) => t.includes(str(v.type));
  return [
    ...(quick
      ? []
      : [{ k: "select", key: "type", label: "Select a Rule Type:", options: CF_TYPES } as const]),
    { k: "select", key: "operator", label: "Cell value", options: CELL_OPS, show: showT("cellIs") },
    { k: "text", key: "value", label: "Value:", show: showT("cellIs") },
    { k: "text", key: "value2", label: "and:", show: (v) => v.type === "cellIs" && /between/i.test(str(v.operator)) },
    { k: "text", key: "text", label: "Text:", show: showT("containsText", "beginsWith", "endsWith") },
    { k: "text", key: "formula", label: "Format values where this formula is true:", show: showT("expression") },
    { k: "num", key: "rank", label: "Rank:", min: 1, step: 1, show: showT("top10") },
    { k: "radio", key: "rankSide", options: opts(["top", "Top"], ["bottom", "Bottom"]), show: showT("top10") },
    { k: "check", key: "percent", label: "% of the selected range", show: showT("top10") },
    { k: "radio", key: "avgSide", options: opts(["above", "Above"], ["below", "Below"]), show: showT("aboveAverage") },
    { k: "select", key: "period", label: "Date occurring:", options: PERIODS, show: showT("timePeriod") },
    { k: "radio", key: "scale", options: opts(["two", "2-Color Scale"], ["three", "3-Color Scale"]), show: showT("colorScale") },
    { k: "color", key: "c1", label: "Minimum color:", show: showT("colorScale") },
    { k: "color", key: "c2", label: "Midpoint color:", show: (v) => v.type === "colorScale" && v.scale === "three" },
    { k: "color", key: "c3", label: "Maximum color:", show: showT("colorScale") },
    { k: "color", key: "barColor", label: "Bar color:", show: showT("dataBar") },
    { k: "select", key: "iconSet", label: "Icon Style:", options: ICON_SETS, show: showT("iconSet") },
    { k: "select", key: "preset", label: "Format with:", options: PRESETS, show: (v) => !["colorScale", "dataBar", "iconSet"].includes(str(v.type)) },
  ];
};

export const FORMS3: Record<string, S> = {
  cfRule: {
    title: "Conditional Formatting",
    fields: ruleFields(true),
    init: (_cx, p) => ({
      type: str(p.type ?? "cellIs"),
      operator: str(p.operator ?? ">"),
      value: "",
      value2: "",
      text: "",
      formula: "",
      rank: 10,
      rankSide: p.bottom ? "bottom" : "top",
      percent: !!p.percent,
      avgSide: p.below ? "below" : "above",
      period: "today",
      preset: "lightRedFillDarkRedText",
    }),
    submit: (v, cx) => cx.run("home.conditionalFormat", { rule: cfRule(v) }),
  },
  newRule: {
    title: "New Formatting Rule",
    size: "wide",
    fields: ruleFields(false),
    init: (_cx, p) => ({
      type: str(p.type ?? "cellIs"),
      operator: ">",
      value: "",
      value2: "",
      text: "",
      formula: "",
      rank: 10,
      rankSide: "top",
      percent: false,
      avgSide: "above",
      period: "today",
      scale: "three",
      c1: "#F8696B",
      c2: "#FFEB84",
      c3: "#63BE7B",
      barColor: "#638EC6",
      iconSet: "3TrafficLights1",
      preset: "lightRedFillDarkRedText",
    }),
    submit: (v, cx) => cx.run("home.conditionalFormat", { rule: cfRule(v) }),
  },
  pivotCalculatedField: {
    title: "Insert Calculated Field",
    fields: [
      { k: "text", key: "name", label: "Name:", autoFocus: true },
      { k: "text", key: "formula", label: "Formula:" },
      { k: "note", text: "Fields are written bare or 'quoted', for example =Sales*0.1" },
    ],
    init: (_cx, p) => ({ name: str(p.name), formula: str(p.formula) }),
    submit: (v, cx, p) => cx.run("pivot.calculatedField", { ...(p.pivot ? { pivot: p.pivot } : {}), name: str(v.name), formula: str(v.formula) }),
  },
  chartTitle: {
    title: "Chart Title",
    fields: [
      { k: "text", key: "title", label: "Title:", autoFocus: true },
      { k: "text", key: "xTitle", label: "Horizontal axis title:" },
      { k: "text", key: "yTitle", label: "Vertical axis title:" },
    ],
    init: () => ({ title: "", xTitle: "", yTitle: "" }),
    submit: (v, cx, p) => {
      const o = objOf(cx);
      cx.run("chart.set", { chart: p.chart ?? o?.id, title: str(v.title), xTitle: str(v.xTitle), yTitle: str(v.yTitle) });
    },
  },
  changeChartType: {
    title: "Change Chart Type",
    fields: [
      { k: "select", key: "type", label: "Chart type:", options: CHART_TYPES },
      { k: "select", key: "subtype", label: "Subtype:", options: CHART_SUBTYPES, show: (v) => ["column", "bar", "line", "area"].includes(str(v.type)) },
    ],
    init: () => ({ type: "column", subtype: "clustered" }),
    submit: (v, cx) => {
      const o = objOf(cx);
      cx.run("chart.changeType", { chart: o?.id, type: v.type, ...(["column", "bar", "line", "area"].includes(str(v.type)) ? { subtype: v.subtype } : {}) });
    },
  },
  recommendedCharts: {
    title: "Insert Chart",
    fields: [
      { k: "select", key: "type", label: "Chart type:", options: CHART_TYPES },
      { k: "select", key: "subtype", label: "Subtype:", options: CHART_SUBTYPES, show: (v) => ["column", "bar", "line", "area"].includes(str(v.type)) },
      { k: "text", key: "title", label: "Title:" },
      { k: "text", key: "range", label: "Data range:" },
    ],
    init: (cx) => ({ type: "column", subtype: "clustered", title: "", range: cx.s.sel.a1 }),
    submit: (v, cx) =>
      cx.run("insert.chart", {
        range: str(v.range),
        type: v.type,
        ...(["column", "bar", "line", "area"].includes(str(v.type)) ? { subtype: v.subtype } : {}),
        ...(str(v.title) ? { title: str(v.title) } : {}),
      }),
  },
  selectData: {
    title: "Select Data Source",
    fields: [
      { k: "text", key: "range", label: "Chart data range:" },
      { k: "radio", key: "byRows", options: opts(["false", "Series in columns"], ["true", "Series in rows"]) },
      { k: "text", key: "categories", label: "Horizontal (Category) Axis Labels:" },
    ],
    init: () => ({ range: "", byRows: "false", categories: "" }),
    submit: (v, cx) => {
      const o = objOf(cx);
      cx.run("chart.selectData", { chart: o?.id, ...(str(v.range) ? { range: str(v.range) } : {}), byRows: v.byRows === "true", categories: str(v.categories) });
    },
  },
  moveChart: {
    title: "Move Chart",
    fields: [
      { k: "radio", key: "where", options: opts(["here", "On this sheet"], ["sheet", "On another sheet"]) },
      { k: "text", key: "at", label: "Top-left cell:", show: (v) => v.where === "here" },
      { k: "select", key: "sheet", label: "Sheet:", options: (cx) => cx.s.sheets.map((t): Opt => [t.name, t.name]), raw: true, show: (v) => v.where === "sheet" },
    ],
    init: (cx) => ({ where: "here", at: "A1", sheet: cx.s.sheets[cx.s.active]?.name ?? "" }),
    submit: (v, cx) => {
      const o = objOf(cx);
      cx.run("chart.move", { chart: o?.id, ...(v.where === "here" ? { at: str(v.at) } : { sheet: str(v.sheet) }) });
    },
  },
  objectSize: {
    title: "Size",
    fields: [
      { k: "num", key: "width", label: "Width:", min: 1, step: 1, unit: "points" },
      { k: "num", key: "height", label: "Height:", min: 1, step: 1, unit: "points" },
    ],
    init: () => ({ width: 320, height: 200 }),
    submit: (v, cx) => {
      const o = objOf(cx);
      if (o) cx.run("object.move", { kind: o.kind, id: o.id, width: num(v.width, 320), height: num(v.height, 200) });
    },
  },
  objectProperties: {
    title: "Position",
    fields: [
      { k: "text", key: "at", label: "Top-left cell:" },
      { k: "radio", key: "mode", options: opts(["moveAndSize", "Move and size with cells"], ["moveOnly", "Move but don't size with cells"], ["absolute", "Don't move or size with cells"]) },
    ],
    init: () => ({ at: "", mode: "moveAndSize" }),
    submit: (v, cx) => {
      const o = objOf(cx);
      if (!o) return;
      if (str(v.at)) cx.run("object.move", { kind: o.kind, id: o.id, at: str(v.at) });
      cx.run("object.setAnchorMode", { kind: o.kind, id: o.id, mode: v.mode });
    },
  },
  altText: {
    title: "Alt Text",
    noOk: true,
    fields: [{ k: "note", text: "Alt text is set when a picture is inserted. Editing it afterwards is not supported by the spreadsheet engine yet." }],
    init: () => ({}),
    submit: () => undefined,
  },
  shapeText: {
    title: "Edit Text",
    fields: [{ k: "area", key: "text", label: "Text:" }],
    init: () => ({ text: "" }),
    submit: (v, cx) => {
      const o = objOf(cx);
      if (o) cx.run("shape.setText", { id: o.id, text: str(v.text) });
    },
  },
  createPivot: {
    title: "PivotTable from table or range",
    fields: [
      { k: "text", key: "source", label: "Table/Range:" },
      { k: "radio", key: "dest", options: opts(["new", "New Worksheet"], ["here", "Existing Worksheet"]) },
      { k: "text", key: "location", label: "Location:", show: (v) => v.dest === "here" },
      { k: "text", key: "rows", label: "Rows (field names, comma-separated):" },
      { k: "text", key: "columns", label: "Columns:" },
      { k: "text", key: "values", label: "Values:" },
      { k: "text", key: "filters", label: "Filters:" },
    ],
    init: (cx) => ({ source: cx.s.ctx.table ? str((cx.s.ctx.table as { name?: string }).name) : cx.s.sel.a1, dest: "new", location: "", rows: "", columns: "", values: "", filters: "" }),
    submit: (v, cx) =>
      cx.run("insert.pivotTable", {
        source: str(v.source),
        destination: v.dest === "here" ? str(v.location) : "new",
        rows: lines(v.rows),
        columns: lines(v.columns),
        values: lines(v.values),
        filters: lines(v.filters),
      }),
  },
  recommendedPivots: {
    title: "Recommended PivotTables",
    fields: [{ k: "note", text: "Creates the best-fitting PivotTable for the selected data." }],
    init: () => ({}),
    submit: (_v, cx) => cx.run("insert.recommendedPivotTables", { apply: 0 }),
  },
  pivotChart: {
    title: "Insert Chart",
    fields: [
      { k: "select", key: "type", label: "Chart type:", options: CHART_TYPES },
      { k: "text", key: "title", label: "Title:" },
    ],
    init: () => ({ type: "column", title: "" }),
    submit: (v, cx) => cx.run("insert.pivotChart", { type: v.type, ...(str(v.title) ? { title: str(v.title) } : {}) }),
  },
  pivotName: {
    title: "PivotTable Name",
    noOk: true,
    fields: [{ k: "pre", render: (_v, cx) => <span>{str(cx.s.ctx.pivot?.name)}</span> }, { k: "note", text: "Renaming a PivotTable is not supported by the spreadsheet engine yet." }],
    init: () => ({}),
    submit: () => undefined,
  },
  pivotOptions: {
    title: "PivotTable Options",
    fields: [
      { k: "select", key: "layout", label: "Report layout:", options: opts(["compact", "Compact"], ["outline", "Outline"], ["tabular", "Tabular"]) },
      { k: "check", key: "rows", label: "Show grand totals for rows" },
      { k: "check", key: "cols", label: "Show grand totals for columns" },
      { k: "select", key: "subtotals", label: "Subtotals:", options: opts(["none", "Do Not Show Subtotals"], ["top", "Show all Subtotals at Top of Group"], ["bottom", "Show all Subtotals at Bottom of Group"]) },
    ],
    init: () => ({ layout: "compact", rows: true, cols: true, subtotals: "top" }),
    submit: (v, cx) => cx.run("pivot.layout", { layout: v.layout, grandTotalsRows: !!v.rows, grandTotalsCols: !!v.cols, subtotals: v.subtotals }),
  },
  valueSettings: {
    title: "Value Field Settings",
    fields: [
      { k: "text", key: "field", label: "Source name:" },
      { k: "text", key: "name", label: "Custom Name:" },
      { k: "select", key: "func", label: "Summarize value field by:", options: opts(["sum", "Sum"], ["count", "Count"], ["average", "Average"], ["max", "Max"], ["min", "Min"], ["product", "Product"], ["countNumbers", "Count Numbers"], ["stdDev", "StdDev"], ["stdDevP", "StdDevp"], ["var", "Var"], ["varP", "Varp"]) },
      { k: "select", key: "showAs", label: "Show values as:", options: opts(["normal", "No Calculation"], ["percentOfGrandTotal", "% of Grand Total"], ["percentOfColumnTotal", "% of Column Total"], ["percentOfRowTotal", "% of Row Total"], ["runningTotal", "Running Total In"], ["rank", "Rank"]) },
      { k: "text", key: "numberFormat", label: "Number Format:" },
    ],
    init: () => ({ field: "", name: "", func: "sum", showAs: "normal", numberFormat: "" }),
    submit: (v, cx) =>
      cx.run("pivot.valueSettings", {
        field: str(v.field),
        func: v.func,
        showAs: v.showAs,
        ...(str(v.name) ? { name: str(v.name) } : {}),
        ...(str(v.numberFormat) ? { numberFormat: str(v.numberFormat) } : {}),
      }),
  },
  pivotGroup: {
    title: "Grouping",
    fields: [
      { k: "text", key: "field", label: "Field:" },
      { k: "select", key: "by", label: "By:", options: opts(["years", "Years"], ["quarters", "Quarters"], ["months", "Months"], ["days", "Days"], ["none", "Ungroup"]) },
    ],
    init: () => ({ field: "", by: "months" }),
    submit: (v, cx) => cx.run("pivot.group", { field: str(v.field), by: v.by }),
  },
  pivotFilter: {
    title: "Filter",
    fields: [
      { k: "text", key: "field", label: "Field:" },
      { k: "text", key: "selected", label: "Show items (comma-separated; empty = all):" },
    ],
    init: () => ({ field: "", selected: "" }),
    submit: (v, cx) => cx.run("pivot.filter", { field: str(v.field), selected: lines(v.selected).length ? lines(v.selected) : null }),
  },
  changePivotSource: {
    title: "Change PivotTable Data Source",
    fields: [{ k: "text", key: "source", label: "Table/Range:" }],
    init: () => ({ source: "" }),
    submit: (v, cx) => cx.run("pivot.changeSource", { source: str(v.source) }),
  },
  unprotectSheet: {
    title: "Unprotect Sheet",
    fields: [{ k: "text", key: "password", label: "Password:", autoFocus: true }],
    init: () => ({ password: "" }),
    submit: (v, cx) => cx.run("review.unprotectSheet", { password: str(v.password) }),
  },
  unprotectWorkbook: {
    title: "Unprotect Workbook",
    fields: [{ k: "text", key: "password", label: "Password:", autoFocus: true }],
    init: () => ({ password: "" }),
    submit: (v, cx) => cx.run("review.protectWorkbook", { on: false, password: str(v.password) }),
  },
  editRanges: {
    title: "Allow Edit Ranges",
    fields: [
      { k: "text", key: "title", label: "Title:" },
      { k: "text", key: "range", label: "Refers to cells:" },
      { k: "text", key: "password", label: "Range password (optional):" },
    ],
    init: (cx) => ({ title: "", range: cx.s.sel.a1, password: "" }),
    submit: (v, cx) => cx.run("review.allowEditRanges", { action: "add", title: str(v.title), range: str(v.range), ...(str(v.password) ? { password: str(v.password) } : {}) }),
  },
  allowEditRanges: {
    title: "Allow Edit Ranges",
    fields: [
      { k: "text", key: "title", label: "Title:" },
      { k: "text", key: "range", label: "Refers to cells:" },
    ],
    init: (cx) => ({ title: "", range: cx.s.sel.a1 }),
    submit: (v, cx) => cx.run("review.allowEditRanges", { action: "add", title: str(v.title), range: str(v.range) }),
  },
  headerFooter: {
    title: "Header/Footer",
    fields: [
      { k: "text", key: "header", label: "Header (&L &C &R sections, &P page, &N pages):" },
      { k: "text", key: "footer", label: "Footer:" },
      { k: "check", key: "differentFirst", label: "Different first page" },
      { k: "check", key: "differentOddEven", label: "Different odd and even pages" },
    ],
    init: () => ({ header: "", footer: "&CPage &P of &N", differentFirst: false, differentOddEven: false }),
    submit: (v, cx) => cx.run("pageLayout.headerFooter", { header: str(v.header), footer: str(v.footer), differentFirst: !!v.differentFirst, differentOddEven: !!v.differentOddEven }),
  },
  sheetBackground: {
    title: "Sheet Background",
    fields: [{ k: "note", text: "Choose a picture to tile behind the sheet cells, or remove the current one." }],
    init: () => ({}),
    ok: "Choose Picture…",
    submit: (_v, cx) =>
      cx.ui.pickFile("image/*", (f) => {
        void cx.ui.upload(f).then((path) => {
          if (path) cx.run("pageLayout.background", { path });
        });
      }),
  },
  insertPicture: {
    title: "Insert Picture",
    fields: [
      { k: "radio", key: "placement", options: opts(["overCells", "Place over cells"], ["cell", "Place in cell"]) },
      { k: "text", key: "alt", label: "Alt text:" },
    ],
    init: (_cx, p) => ({ placement: str(p.placement ?? "overCells"), alt: "" }),
    ok: "Choose Picture…",
    submit: (v, cx) =>
      cx.ui.pickFile("image/*", (f) => {
        void cx.ui.upload(f).then((path) => {
          if (path) cx.run("insert.picture", { path, placement: v.placement, ...(str(v.alt) ? { alt: str(v.alt) } : {}) });
        });
      }),
  },
  icons: {
    title: "Insert Icons",
    fields: [
      { k: "select", key: "name", label: "Icon:", options: ["chart", "table", "sum", "filter", "lock", "comment", "picture", "book", "folder", "search", "calc", "check"].map((n): Opt => [n, n]), raw: true },
      { k: "color", key: "color", label: "Color:" },
      { k: "num", key: "size", label: "Size:", min: 8, step: 8 },
    ],
    init: () => ({ name: "chart", color: "#2B579A", size: 48 }),
    submit: (v, cx) => cx.run("insert.icons", { name: v.name, color: str(v.color), size: num(v.size, 48) }),
  },
  copyPicture: {
    title: "Copy Picture",
    noOk: true,
    fields: [{ k: "note", text: "Copying a range as a picture is not supported by the spreadsheet engine yet." }],
    init: () => ({}),
    submit: () => undefined,
  },
  newCellStyle: {
    title: "Style",
    fields: [{ k: "text", key: "name", label: "Style name:", autoFocus: true }],
    init: () => ({ name: "" }),
    submit: (v, cx) => cx.run("home.newCellStyle", { name: str(v.name) }),
  },
  newTableStyle: {
    title: "New Table Style",
    fields: [{ k: "note", text: "Custom table styles are not available yet. Use Format as Table to pick a built-in style." }],
    init: () => ({}),
    submit: () => undefined,
    noOk: true,
  },
  analysisToolPak: {
    title: "Data Analysis",
    fields: [
      {
        k: "select",
        key: "tool",
        label: "Analysis Tools:",
        options: opts(
          ["anovaSingle", "Anova: Single Factor"],
          ["correlation", "Correlation"],
          ["covariance", "Covariance"],
          ["descriptive", "Descriptive Statistics"],
          ["exponentialSmoothing", "Exponential Smoothing"],
          ["fTest", "F-Test Two-Sample for Variances"],
          ["histogram", "Histogram"],
          ["movingAverage", "Moving Average"],
          ["rankPercentile", "Rank and Percentile"],
          ["regression", "Regression"],
          ["tTestPaired", "t-Test: Paired Two Sample for Means"],
          ["tTestEqual", "t-Test: Two-Sample Assuming Equal Variances"],
          ["tTestUnequal", "t-Test: Two-Sample Assuming Unequal Variances"],
        ),
      },
      { k: "text", key: "range", label: "Input Range:", show: (v) => !["regression", "fTest", "tTestPaired", "tTestEqual", "tTestUnequal"].includes(str(v.tool)) },
      { k: "text", key: "range1", label: "Variable 1 Range:", show: (v) => ["fTest", "tTestPaired", "tTestEqual", "tTestUnequal"].includes(str(v.tool)) },
      { k: "text", key: "range2", label: "Variable 2 Range:", show: (v) => ["fTest", "tTestPaired", "tTestEqual", "tTestUnequal"].includes(str(v.tool)) },
      { k: "text", key: "inputY", label: "Input Y Range:", show: (v) => v.tool === "regression" },
      { k: "text", key: "inputX", label: "Input X Range:", show: (v) => v.tool === "regression" },
      { k: "check", key: "labels", label: "Labels" },
      { k: "text", key: "output", label: "Output Range (empty = new worksheet):" },
    ],
    init: (cx) => ({ tool: "descriptive", range: cx.s.sel.a1, range1: "", range2: "", inputY: "", inputX: "", labels: true, output: "" }),
    submit: (v, cx) => {
      const t = str(v.tool);
      const p: Record<string, unknown> = { tool: t, labels: !!v.labels };
      if (t === "regression") Object.assign(p, { inputY: str(v.inputY), inputX: str(v.inputX) });
      else if (["fTest", "tTestPaired", "tTestEqual", "tTestUnequal"].includes(t)) Object.assign(p, { range1: str(v.range1), range2: str(v.range2) });
      else p.range = str(v.range);
      if (str(v.output)) p.output = str(v.output);
      cx.run("data.analysisToolPak", p);
    },
  },
  solver: {
    title: "Solver Parameters",
    size: "wide",
    fields: [
      { k: "text", key: "objective", label: "Set Objective:" },
      { k: "radio", key: "goal", options: opts(["max", "Max"], ["min", "Min"], ["value", "Value of:"]) },
      { k: "text", key: "value", label: "Target value:", show: (v) => v.goal === "value" },
      { k: "text", key: "variables", label: "By Changing Variable Cells:" },
      { k: "area", key: "constraints", label: "Subject to the Constraints (one per line, e.g. B5 <= 10):", rows: 4 },
      { k: "check", key: "nonNegative", label: "Make Unconstrained Variables Non-Negative" },
      { k: "select", key: "method", label: "Select a Solving Method:", options: opts(["grg", "GRG Nonlinear"], ["simplex", "Simplex LP"], ["evolutionary", "Evolutionary"]) },
    ],
    init: () => ({ objective: "", goal: "max", value: "0", variables: "", constraints: "", nonNegative: true, method: "grg" }),
    submit: async (v, cx) => {
      const r = (await cx.call("data.solver", {
          objective: str(v.objective),
          goal: v.goal,
          ...(v.goal === "value" ? { value: num(v.value) } : {}),
          variables: str(v.variables),
          constraints: str(v.constraints).split(/\n+/).map((x) => x.trim()).filter(Boolean),
          nonNegative: !!v.nonNegative,
          method: v.method,
      })) as { message?: string; status?: string } | undefined;
      cx.ui.status(r?.message ?? r?.status ?? "");
    },
  },
};
