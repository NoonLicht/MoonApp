import { galleryItem } from "@/pages/sheet/ribbon/TableStyleGallery";
import { colorMenu } from "@/pages/word/ribbon/colors";
import type { Item, Tab } from "@/pages/word/ribbon/types";
import { arrangeSel } from "@/pages/sheet/ribbon/model/layout";
import { big, check, cmd, dlg, fn, group, it, itf, menu, sep, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const objKind = (c: SheetCx): string => (c.ui.selObj?.kind === "slicer" ? "shape" : (c.ui.selObj?.kind ?? ""));
const idOf = (c: SheetCx): number => c.ui.selObj?.id ?? 0;

/** Команда над выбранным диаграммой/фигурой/картинкой. */
const onObj = (command: string, extra: Record<string, unknown> = {}) =>
  fn((c: SheetCx) => c.run(command, { kind: objKind(c), id: idOf(c), ...extra }));
const onChart = (command: string, extra: Record<string, unknown> = {}) =>
  fn((c: SheetCx) => c.run(command, { chart: idOf(c), ...extra }));

const tableStyleItems: Item<SheetCx>[] = [galleryItem((c, style) => c.run("table.style", { style }), (c) => c.s.ctx.table?.style)];

export const tableDesign: Tab<SheetCx> = {
  id: "tableDesign",
  label: "Table Design",
  contextual: true,
  groups: [
    group("props", "Properties", [
      stack(small("tableProps", "Table Name", dlg("renameTable")), small("scaling", "Resize Table", dlg("resizeTable"))),
    ]),
    group("tools", "Tools", [
      stack(
        small("pivot", "Summarize with PivotTable", cmd("table.summarizePivot")),
        small("trash", "Remove Duplicates", dlg("removeDuplicates")),
        small("unlink", "Convert to Range", cmd("table.convertToRange")),
      ),
      big("slice", "Insert\nSlicer", dlg("slicer")),
    ]),
    group("options", "Table Style Options", [
      stack(
        check("Header Row", (c) => !!c.s.ctx.table?.header, (c, v) => c.run("table.headerRow", { on: v })),
        check("Total Row", (c) => !!c.s.ctx.table?.totals, (c, v) => c.run("table.totalRow", { on: v })),
        check("Banded Rows", (c) => !!c.s.ctx.table?.bandedRows, (c, v) => c.run("table.bandedRows", { on: v })),
      ),
      stack(
        check("First Column", (c) => !!c.s.ctx.table?.firstCol, (c, v) => c.run("table.firstColumn", { on: v })),
        check("Last Column", (c) => !!c.s.ctx.table?.lastCol, (c, v) => c.run("table.lastColumn", { on: v })),
        check("Banded Columns", (c) => !!c.s.ctx.table?.bandedCols, (c, v) => c.run("table.bandedColumns", { on: v })),
      ),
    ]),
    group("styles", "Table Styles", [menu("tableFmt", "Table\nStyles", tableStyleItems, { big: true })]),
  ],
};

const addElements: Item<SheetCx>[] = [
  { label: "Chart Title", sub: [it("None", "chart.addElement", {}), itf("Above Chart", (c) => c.run("chart.addElement", { chart: idOf(c), element: "title", on: true }))] },
  itf("Legend: Bottom", (c) => c.run("chart.addElement", { chart: idOf(c), element: "legend", position: "bottom", on: true })),
  itf("Legend: Top", (c) => c.run("chart.addElement", { chart: idOf(c), element: "legend", position: "top", on: true })),
  itf("Legend: Left", (c) => c.run("chart.addElement", { chart: idOf(c), element: "legend", position: "left", on: true })),
  itf("Legend: Right", (c) => c.run("chart.addElement", { chart: idOf(c), element: "legend", position: "right", on: true })),
  itf("Legend: None", (c) => c.run("chart.addElement", { chart: idOf(c), element: "legend", on: false })),
  sep,
  itf("Data Labels", (c) => c.run("chart.addElement", { chart: idOf(c), element: "dataLabels" })),
  itf("Gridlines", (c) => c.run("chart.addElement", { chart: idOf(c), element: "gridlines" })),
  itf("Axis Titles", (c) => c.dialog("chartTitles", { chart: idOf(c) })),
  itf("Trendline: Linear", (c) => c.run("chart.addElement", { chart: idOf(c), element: "trendline", type: "linear", on: true })),
  itf("Smooth Lines", (c) => c.run("chart.addElement", { chart: idOf(c), element: "smooth" })),
];
addElements[0] = itf("Chart Title", (c) => c.dialog("chartTitles", { chart: idOf(c) }));

const palettes: [string, string][] = [
  ["Colorful", "colorful"],
  ["Monochrome", "monochrome"],
  ["Accent 1", "accent1"],
  ["Accent 2", "accent2"],
  ["Accent 3", "accent3"],
  ["Accent 4", "accent4"],
  ["Accent 5", "accent5"],
  ["Accent 6", "accent6"],
];

export const chartDesign: Tab<SheetCx> = {
  id: "chartDesign",
  label: "Chart Design",
  contextual: true,
  groups: [
    group("layouts", "Chart Layouts", [
      menu("plus", "Add Chart\nElement", addElements, { big: true }),
      menu("layoutGrid", "Quick\nLayout", [1, 2, 3, 4, 5, 6].map((n) => itf(`Layout ${n}`, (c) => c.run("chart.quickLayout", { chart: idOf(c), layout: n }), { raw: true })), { big: true }),
    ]),
    group("styles", "Chart Styles", [
      menu(
        "palette",
        "Change\nColors",
        palettes.map(([l, p]) => itf(l, (c) => c.run("chart.changeColors", { chart: idOf(c), palette: p }))),
        { big: true },
      ),
      menu("sparklesIc", "Styles", [1, 2, 3, 4, 5, 6, 7, 8].map((n) => itf(`Style ${n}`, (c) => c.run("chart.set", { chart: idOf(c), style: n }), { raw: true })), { big: true }),
    ]),
    group("data", "Data", [
      big("updown", "Switch Row/\nColumn", onChart("chart.switchRowColumn")),
      big("table", "Select\nData", dlg("selectData")),
    ]),
    group("type", "Type", [big("chart", "Change\nChart Type", dlg("changeChartType"))]),
    group("location", "Location", [big("move", "Move\nChart", dlg("moveChart"))]),
    group("arrange", "Arrange", [
      stack(
        small("forward", "Bring Forward", fn((c) => arrangeSel(c, "arrange.bringForward"))),
        small("backward", "Send Backward", fn((c) => arrangeSel(c, "arrange.sendBackward"))),
        small("selectionPane", "Selection Pane", fn((c) => c.ui.togglePane("selection"))),
      ),
      small("trash", "Delete", onObj("object.delete")),
    ]),
  ],
};

export const chartFormat: Tab<SheetCx> = {
  id: "chartFormat",
  label: "Format",
  contextual: true,
  groups: [
    group("selection", "Current Selection", [big("select", "Format\nSelection", fn((c) => c.ui.togglePane("formatChart", true)))]),
    group("styles", "Shape Styles", [
      menu("bucket", "Shape Fill", colorMenu<SheetCx>("chart.shapeFill", { extra: {}, memo: "chartfill" }).map(withChart), { big: true }),
      menu("border", "Shape Outline", colorMenu<SheetCx>("chart.shapeOutline", { extra: {}, memo: "chartline" }).map(withChart), { big: true }),
    ]),
  ],
};

/** Пункты палитры работают с выбранной диаграммой: подставляем её номер в параметры. */
function withChart(item: Item<SheetCx>): Item<SheetCx> {
  if (!item.act || !("cmd" in item.act)) return item;
  const { cmd: command, p } = item.act;
  return { ...item, act: { fn: (c: SheetCx) => c.run(command, { ...p, chart: idOf(c) }) } };
}

export const pictureFormat: Tab<SheetCx> = {
  id: "pictureFormat",
  label: "Picture Format",
  contextual: true,
  groups: [
    group("size", "Size", [big("crop", "Size…", dlg("objectSize")), big("move", "Position…", dlg("objectProperties"))]),
    group("arrange", "Arrange", [
      stack(
        small("forward", "Bring Forward", fn((c) => arrangeSel(c, "arrange.bringForward"))),
        small("backward", "Send Backward", fn((c) => arrangeSel(c, "arrange.sendBackward"))),
        small("selectionPane", "Selection Pane", fn((c) => c.ui.togglePane("selection"))),
      ),
    ]),
    group("accessibility", "Accessibility", [big("info", "Alt Text", dlg("altText"))]),
    group("actions", "Actions", [big("trash", "Delete", onObj("object.delete"))]),
  ],
};

export const shapeFormat: Tab<SheetCx> = {
  id: "shapeFormat",
  label: "Shape Format",
  contextual: true,
  groups: [
    group("insert", "Insert Shapes", [
      menu(
        "shapesIc",
        "Shapes",
        [
          ["Rectangle", "rectangle"],
          ["Rounded Rectangle", "roundedRectangle"],
          ["Oval", "ellipse"],
          ["Triangle", "triangle"],
          ["Line", "line"],
          ["Arrow", "arrow"],
          ["Text Box", "textBox"],
        ].map(([l, kind]) => it(l, "insert.shape", { kind })),
        { big: true },
      ),
      big("textBox", "Edit\nText", dlg("shapeText")),
    ]),
    group("styles", "Shape Styles", [
      menu("bucket", "Shape Fill", colorMenu<SheetCx>("chart.shapeFill", { extra: { kind: "shape" }, memo: "shapefill" }).map(withShape), { big: true }),
      menu("border", "Shape Outline", colorMenu<SheetCx>("chart.shapeOutline", { extra: { kind: "shape" }, memo: "shapeline" }).map(withShape), { big: true }),
    ]),
    group("arrange", "Arrange", [
      stack(
        small("forward", "Bring Forward", fn((c) => arrangeSel(c, "arrange.bringForward"))),
        small("backward", "Send Backward", fn((c) => arrangeSel(c, "arrange.sendBackward"))),
        small("selectionPane", "Selection Pane", fn((c) => c.ui.togglePane("selection"))),
      ),
      menu(
        "rotateCw",
        "Rotate",
        [
          itf("Rotate Right 90°", (c) => c.run("arrange.rotate", { kind: "shape", id: idOf(c) })),
          itf("Flip Vertical", (c) => c.run("arrange.rotate", { kind: "shape", id: idOf(c), flip: "vertical" })),
          itf("Flip Horizontal", (c) => c.run("arrange.rotate", { kind: "shape", id: idOf(c), flip: "horizontal" })),
        ],
        { big: true },
      ),
    ]),
    group("size", "Size", [big("crop", "Size…", dlg("objectSize")), big("move", "Position…", dlg("objectProperties"))]),
    group("actions", "Actions", [big("trash", "Delete", onObj("object.delete"))]),
  ],
};

function withShape(item: Item<SheetCx>): Item<SheetCx> {
  if (!item.act || !("cmd" in item.act)) return item;
  const { cmd: command, p } = item.act;
  return { ...item, act: { fn: (c: SheetCx) => c.run(command, { ...p, kind: "shape", id: idOf(c) }) } };
}

export const slicerTab: Tab<SheetCx> = {
  id: "slicerTab",
  label: "Slicer",
  contextual: true,
  groups: [
    group("slicer", "Slicer", [
      big("eraser", "Clear\nFilter", fn((c) => c.run("slicer.clear", { slicer: idOf(c) }))),
      big("trash", "Delete", fn((c) => c.run("slicer.delete", { slicer: idOf(c) }))),
    ]),
    group("arrange", "Arrange", [
      stack(
        small("forward", "Bring Forward", fn((c) => arrangeSel(c, "arrange.bringForward"))),
        small("backward", "Send Backward", fn((c) => arrangeSel(c, "arrange.sendBackward"))),
      ),
    ]),
  ],
};

const subtotals: Item<SheetCx>[] = [
  it("Do Not Show Subtotals", "pivot.subtotals", { mode: "none" }),
  it("Show all Subtotals at Bottom of Group", "pivot.subtotals", { mode: "bottom" }),
  it("Show all Subtotals at Top of Group", "pivot.subtotals", { mode: "top" }),
];
const grand: Item<SheetCx>[] = [
  it("Off for Rows and Columns", "pivot.grandTotals", { mode: "off" }),
  it("On for Rows and Columns", "pivot.grandTotals", { mode: "on" }),
  it("On for Rows Only", "pivot.grandTotals", { mode: "rows" }),
  it("On for Columns Only", "pivot.grandTotals", { mode: "columns" }),
];
const layouts: Item<SheetCx>[] = [
  it("Show in Compact Form", "pivot.reportLayout", { layout: "compact" }),
  it("Show in Outline Form", "pivot.reportLayout", { layout: "outline" }),
  it("Show in Tabular Form", "pivot.reportLayout", { layout: "tabular" }),
];
const pivotStyles: Item<SheetCx>[] = [
  ...Array.from({ length: 28 }, (_, i) => it(`PivotStyleLight${i + 1}`, "pivot.style", { style: `PivotStyleLight${i + 1}` }, { raw: true })),
  sep,
  ...Array.from({ length: 28 }, (_, i) => it(`PivotStyleMedium${i + 1}`, "pivot.style", { style: `PivotStyleMedium${i + 1}` }, { raw: true })),
  sep,
  ...Array.from({ length: 28 }, (_, i) => it(`PivotStyleDark${i + 1}`, "pivot.style", { style: `PivotStyleDark${i + 1}` }, { raw: true })),
];

export const pivotAnalyze: Tab<SheetCx> = {
  id: "pivotAnalyze",
  label: "PivotTable Analyze",
  contextual: true,
  groups: [
    group("pivot", "PivotTable", [
      stack(small("pivot", "PivotTable Name", dlg("pivotName")), small("slidersH", "Options", dlg("pivotOptions"))),
    ]),
    group("field", "Active Field", [big("settings", "Value Field\nSettings", dlg("valueSettings"))]),
    group("group", "Group", [big("group", "Group\nField", dlg("pivotGroup"))]),
    group("filter", "Filter", [big("slice", "Insert\nSlicer", dlg("slicer")), big("filter", "Filter", dlg("pivotFilter"))]),
    group("data", "Data", [
      big("refresh", "Refresh", cmd("pivot.refresh")),
      big("table", "Change Data\nSource", dlg("changePivotSource")),
    ]),
    group("actions", "Actions", [big("trash", "Clear All", cmd("pivot.delete"))]),
    group("calc", "Calculations", [big("calculator", "Fields,\nItems & Sets", dlg("pivotCalculatedField"))]),
    group("tools", "Tools", [big("chart", "PivotChart", dlg("pivotChart"))]),
    group("show", "Show", [big("list", "Field\nList", fn((c) => c.ui.togglePane("pivotFields")), { on: (c) => c.ui.pane === "pivotFields" })]),
  ],
};

export const pivotDesign: Tab<SheetCx> = {
  id: "pivotDesign",
  label: "PivotTable Design",
  contextual: true,
  groups: [
    group("layout", "Layout", [
      menu("calculator", "Subtotals", subtotals, { big: true }),
      menu("sigma", "Grand\nTotals", grand, { big: true }),
      menu("layoutGrid", "Report\nLayout", layouts, { big: true }),
    ]),
    group("styles", "PivotTable Styles", [menu("tableFmt", "PivotTable\nStyles", pivotStyles, { big: true })]),
  ],
};

