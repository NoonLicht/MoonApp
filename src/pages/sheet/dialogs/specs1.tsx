import type { FormSpec } from "@/pages/word/dialogs/form";
import type { SheetCx } from "@/pages/sheet/types";
import { colName } from "@/pages/sheet/grid/geometry";

type S = FormSpec<SheetCx>;

const num = (v: string | number | boolean | undefined, d = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};

/** Простые диалоги, описанные данными (название диалога → форма). */
export const FORMS1: Record<string, S> = {
  rowHeight: {
    title: "Row Height",
    fields: [{ k: "num", key: "height", label: "Row height:", min: 0, step: 1, unit: "points" }],
    init: () => ({ height: 20 }),
    submit: (v, cx) => cx.run("home.rowHeight", { height: num(v.height, 20) }),
  },
  columnWidth: {
    title: "Column Width",
    fields: [{ k: "num", key: "width", label: "Column width:", min: 0, step: 1, unit: "points" }],
    init: () => ({ width: 64 }),
    submit: (v, cx) => cx.run("home.columnWidth", { width: num(v.width, 64) }),
  },
  defaultWidth: {
    title: "Standard Width",
    fields: [{ k: "num", key: "width", label: "Standard column width:", min: 0, step: 1 }],
    init: () => ({ width: 64 }),
    submit: (v, cx) => cx.run("home.defaultWidth", { width: num(v.width, 64) }),
  },
  renameSheet: {
    title: "Rename Sheet",
    fields: [{ k: "text", key: "name", label: "Sheet name:", autoFocus: true }],
    init: (cx) => ({ name: cx.s.sheets[cx.s.active]?.name ?? "" }),
    submit: (v, cx) => cx.run("sheet.rename", { name: String(v.name).trim() }),
  },
  moveSheet: {
    title: "Move or Copy",
    fields: [
      { k: "pre", render: (_v, cx) => <span>{cx.tw("Move selected sheet")}</span> },
      { k: "select", key: "to", label: "Before sheet:", options: (cx) => cx.s.sheets.map((t, i): [string, string] => [String(i), t.name]).concat([[String(cx.s.sheets.length), "(move to end)"]]), raw: true },
      { k: "check", key: "copy", label: "Create a copy" },
    ],
    init: (cx, p) => ({ to: String(cx.s.sheets.length - 1), copy: false, sheet: Number(p.sheet ?? cx.s.active) }),
    submit: (v, cx) => cx.run("sheet.move", { sheet: v.sheet, to: num(v.to), copy: !!v.copy }),
  },
  insertCells: {
    title: "Insert",
    fields: [
      {
        k: "radio",
        key: "shift",
        label: "Insert",
        options: [
          ["right", "Shift cells right"],
          ["down", "Shift cells down"],
          ["row", "Entire row"],
          ["column", "Entire column"],
        ],
      },
    ],
    init: () => ({ shift: "down" }),
    submit: (v, cx) => cx.run("home.insertCells", { shift: v.shift }),
  },
  deleteCells: {
    title: "Delete",
    fields: [
      {
        k: "radio",
        key: "shift",
        label: "Delete",
        options: [
          ["left", "Shift cells left"],
          ["up", "Shift cells up"],
          ["row", "Entire row"],
          ["column", "Entire column"],
        ],
      },
    ],
    init: () => ({ shift: "up" }),
    submit: (v, cx) => cx.run("home.deleteCells", { shift: v.shift }),
  },
  goTo: {
    title: "Go To",
    fields: [
      { k: "text", key: "reference", label: "Reference:", autoFocus: true },
      { k: "note", text: "Type a cell reference like B5, a range like Sheet2!A1:C3, or a name." },
    ],
    init: () => ({ reference: "" }),
    submit: (v, cx) => cx.run("edit.goTo", { reference: String(v.reference) }),
  },
  goToSpecial: {
    title: "Go To Special",
    fields: [
      {
        k: "radio",
        key: "kind",
        label: "Select",
        options: [
          ["comments", "Comments"],
          ["constants", "Constants"],
          ["formulas", "Formulas"],
          ["blanks", "Blanks"],
          ["currentRegion", "Current region"],
          ["lastCell", "Last cell"],
          ["visible", "Visible cells only"],
          ["conditionalFormats", "Conditional formats"],
          ["dataValidation", "Data validation"],
          ["errors", "Errors"],
          ["numbers", "Numbers"],
          ["text", "Text"],
        ],
      },
    ],
    init: () => ({ kind: "constants" }),
    submit: (v, cx) => cx.run("edit.goToSpecial", { kind: v.kind }),
  },
  zoom: {
    title: "Zoom",
    fields: [
      {
        k: "radio",
        key: "pct",
        label: "Magnification",
        options: [
          ["200", "200%"],
          ["100", "100%"],
          ["75", "75%"],
          ["50", "50%"],
          ["25", "25%"],
          ["custom", "Custom"],
        ],
        raw: true,
      },
      { k: "num", key: "custom", label: "Custom:", min: 10, max: 400, unit: "%", show: (v) => v.pct === "custom" },
    ],
    init: (cx) => {
      const z = String(cx.s.view.zoom);
      return ["200", "100", "75", "50", "25"].includes(z) ? { pct: z, custom: cx.s.view.zoom } : { pct: "custom", custom: cx.s.view.zoom };
    },
    submit: (v, cx) => cx.run("view.zoom", { percent: v.pct === "custom" ? num(v.custom, 100) : num(v.pct, 100) }),
  },
  pasteSpecial: {
    title: "Paste Special",
    fields: [
      {
        k: "radio",
        key: "what",
        label: "Paste",
        options: [
          ["all", "All"],
          ["formulas", "Formulas"],
          ["values", "Values"],
          ["formats", "Formats"],
          ["comments", "Comments and Notes"],
          ["validation", "Validation"],
          ["allExceptBorders", "All except borders"],
          ["columnWidths", "Column widths"],
          ["formulasAndNumberFormats", "Formulas and number formats"],
          ["valuesAndNumberFormats", "Values and number formats"],
        ],
      },
      {
        k: "radio",
        key: "operation",
        label: "Operation",
        options: [
          ["none", "None"],
          ["add", "Add"],
          ["subtract", "Subtract"],
          ["multiply", "Multiply"],
          ["divide", "Divide"],
        ],
      },
      { k: "check", key: "skipBlanks", label: "Skip blanks" },
      { k: "check", key: "transpose", label: "Transpose" },
    ],
    init: () => ({ what: "all", operation: "none", skipBlanks: false, transpose: false }),
    submit: (v, cx) =>
      cx.run("edit.pasteSpecial", { what: v.what, operation: v.operation, skipBlanks: !!v.skipBlanks, transpose: !!v.transpose }),
  },
  series: {
    title: "Series",
    fields: [
      {
        k: "radio",
        key: "direction",
        label: "Series in",
        options: [
          ["columns", "Columns"],
          ["rows", "Rows"],
        ],
      },
      {
        k: "radio",
        key: "type",
        label: "Type",
        options: [
          ["linear", "Linear"],
          ["growth", "Growth"],
          ["date", "Date"],
          ["autofill", "AutoFill"],
        ],
      },
      {
        k: "select",
        key: "dateUnit",
        label: "Date unit",
        options: [
          ["day", "Day"],
          ["weekday", "Weekday"],
          ["month", "Month"],
          ["year", "Year"],
        ],
        show: (v) => v.type === "date",
      },
      { k: "num", key: "step", label: "Step value:", step: 1 },
      { k: "text", key: "stop", label: "Stop value:" },
    ],
    init: () => ({ direction: "columns", type: "linear", dateUnit: "day", step: 1, stop: "" }),
    submit: (v, cx) =>
      cx.run("edit.fillSeries", {
        direction: v.direction,
        type: v.type,
        step: num(v.step, 1),
        ...(String(v.stop).trim() ? { stop: num(v.stop) } : {}),
        ...(v.type === "date" ? { dateUnit: v.dateUnit } : {}),
      }),
  },
  createTable: {
    title: "Create Table",
    fields: [
      { k: "text", key: "range", label: "Where is the data for your table?", autoFocus: true },
      { k: "check", key: "header", label: "My table has headers" },
    ],
    init: (cx, p) => ({ range: cx.s.sel.a1, header: true, style: String(p.style ?? "TableStyleMedium2") }),
    submit: (v, cx) =>
      cx.run("insert.table", { range: String(v.range), header: !!v.header, style: String(v.style) }),
  },
  unhideSheet: {
    title: "Unhide",
    fields: [{ k: "select", key: "sheet", label: "Unhide sheet:", options: (cx) => cx.s.sheets.filter((t) => t.visibility !== "Visible").map((t): [string, string] => [t.name, t.name]), raw: true }],
    init: (cx) => ({ sheet: cx.s.sheets.find((s) => s.visibility !== "Visible")?.name ?? "" }),
    submit: (v, cx) => cx.run("sheet.unhide", { sheet: String(v.sheet) }),
  },
  protectSheet: {
    title: "Protect Sheet",
    fields: [
      { k: "text", key: "password", label: "Password to unprotect sheet (optional):" },
      { k: "note", text: "Allow all users of this worksheet to:" },
      { k: "check", key: "formatCells", label: "Format cells" },
      { k: "check", key: "formatColumns", label: "Format columns" },
      { k: "check", key: "formatRows", label: "Format rows" },
      { k: "check", key: "insertColumns", label: "Insert columns" },
      { k: "check", key: "insertRows", label: "Insert rows" },
      { k: "check", key: "deleteColumns", label: "Delete columns" },
      { k: "check", key: "deleteRows", label: "Delete rows" },
      { k: "check", key: "sort", label: "Sort" },
      { k: "check", key: "autofilter", label: "Use AutoFilter" },
    ],
    init: () => ({ password: "" }),
    submit: (v, cx) => {
      if (cx.s.ctx.protected) return cx.run("review.unprotectSheet", { password: String(v.password) });
      const p: Record<string, unknown> = {};
      for (const k of ["formatCells", "formatColumns", "formatRows", "insertColumns", "insertRows", "deleteColumns", "deleteRows", "sort", "autofilter"])
        p[k] = !!v[k];
      if (String(v.password)) p.password = String(v.password);
      cx.run("review.protectSheet", p);
    },
  },
  protectWorkbook: {
    title: "Protect Structure and Windows",
    fields: [{ k: "text", key: "password", label: "Password (optional):" }],
    init: () => ({ password: "" }),
    submit: (v, cx) => cx.run("review.protectWorkbook", { ...(String(v.password) ? { password: String(v.password) } : {}) }),
  },
  defineName: {
    title: "New Name",
    fields: [
      { k: "text", key: "name", label: "Name:", autoFocus: true },
      { k: "select", key: "scope", label: "Scope:", options: (cx) => [["Workbook", "Workbook"] as [string, string]].concat(cx.s.sheets.map((t): [string, string] => [t.name, t.name])), raw: true },
      { k: "text", key: "comment", label: "Comment:" },
      { k: "text", key: "refersTo", label: "Refers to:" },
    ],
    init: (cx, p) => ({
      name: String(p.name ?? ""),
      scope: String(p.scope ?? "Workbook"),
      comment: String(p.comment ?? ""),
      refersTo: String(p.refersTo ?? `=${cx.s.sheets[cx.s.active]?.name ?? "Sheet1"}!${absRange(cx.s.sel.ranges[cx.s.sel.ranges.length - 1])}`),
    }),
    submit: (v, cx, p) =>
      cx.run("formulas.defineName", {
        name: String(v.name),
        refersTo: String(v.refersTo),
        scope: String(v.scope),
        comment: String(v.comment),
        ...(p.oldName ? { oldName: p.oldName, oldScope: p.oldScope } : {}),
      }),
  },
  customFilter: {
    title: "Custom AutoFilter",
    fields: [
      {
        k: "select",
        key: "op",
        label: "Show rows where:",
        options: [
          ["=", "equals"],
          ["<>", "does not equal"],
          [">", "is greater than"],
          [">=", "is greater than or equal to"],
          ["<", "is less than"],
          ["<=", "is less than or equal to"],
          ["=*{}*", "contains"],
          ["<>*{}*", "does not contain"],
          ["={}*", "begins with"],
          ["=*{}", "ends with"],
        ],
      },
      { k: "text", key: "value", label: "Value:", autoFocus: true },
      {
        k: "radio",
        key: "and",
        options: [
          ["true", "And"],
          ["false", "Or"],
        ],
      },
      {
        k: "select",
        key: "op2",
        options: [
          ["", "(none)"],
          ["=", "equals"],
          ["<>", "does not equal"],
          [">", "is greater than"],
          ["<", "is less than"],
        ],
      },
      { k: "text", key: "value2", label: "Value:", show: (v) => !!v.op2 },
    ],
    init: () => ({ op: "=", value: "", and: "true", op2: "", value2: "" }),
    submit: (v, cx, p) => {
      const fmt = (op: string, val: string): { op: string; value: string } =>
        op.includes("{}") ? { op: op.replace("{}", val), value: val } : { op, value: val };
      const a = fmt(String(v.op), String(v.value));
      const custom: Record<string, unknown> = { op: a.op, value: a.value };
      if (v.op2) {
        const b = fmt(String(v.op2), String(v.value2));
        custom.op2 = b.op;
        custom.value2 = b.value;
        custom.and = v.and === "true";
      }
      cx.run("data.filterBy", { column: p.column ?? 0, custom });
    },
  },
};

/** Диапазон с абсолютными адресами для имени: A1:B2 → $A$1:$B$2. */
function absRange(r?: { r0: number; c0: number; r1: number; c1: number }): string {
  if (!r) return "$A$1";
  const one = (row: number, col: number): string => `$${colName(col)}$${row + 1}`;
  return r.r0 === r.r1 && r.c0 === r.c1 ? one(r.r0, r.c0) : `${one(r.r0, r.c0)}:${one(r.r1, r.c1)}`;
}
