import { galleryItem } from "@/pages/sheet/ribbon/TableStyleGallery";
import { colorMenu, lastColor } from "@/pages/word/ribbon/colors";
import type { Item, Tab } from "@/pages/word/ribbon/types";
import {

  cmd,
  custom,
  dlg,
  fn,
  group,
  head,
  icon,
  it,
  itd,
  itf,
  menu,
  row,
  sep,
  small,
  stack,
  type SheetCx,
} from "@/pages/sheet/ribbon/h";

const PASTE: [string, string, string][] = [
  ["Paste", "all", "paste"],
  ["Formulas", "formulas", "fx"],
  ["Formulas & Number Formatting", "formulasAndNumberFormats", "fx"],
  ["Keep Source Formatting", "all", "paste"],
  ["No Borders", "allExceptBorders", "paste"],
  ["Keep Source Column Widths", "columnWidths", "cols"],
  ["Values", "values", "hash"],
  ["Values & Number Formatting", "valuesAndNumberFormats", "hash"],
  ["Formatting", "formats", "painter"],
];

const pasteItems: Item<SheetCx>[] = [
  head("Paste"),
  ...PASTE.slice(0, 6).map(([l, what]) => itf(l, (c) => c.ui.paste(what))),
  head("Paste Values"),
  ...PASTE.slice(6, 8).map(([l, what]) => itf(l, (c) => c.ui.paste(what))),
  head("Other Paste Options"),
  itf("Formatting", (c) => c.ui.paste("formats")),
  itf("Paste Link", (c) => c.ui.paste("all", "link")),
  itf("Transpose", (c) => c.ui.paste("all", "transpose")),
  sep,
  itd("Paste Special…", "pasteSpecial"),
];

const borderItems: Item<SheetCx>[] = [
  head("Borders"),
  ...(
    [
      ["Bottom Border", "bottom"],
      ["Top Border", "top"],
      ["Left Border", "left"],
      ["Right Border", "right"],
      ["No Border", "none"],
      ["All Borders", "all"],
      ["Outside Borders", "outside"],
      ["Thick Outside Borders", "thickOutside"],
      ["Bottom Double Border", "doubleBottom"],
      ["Thick Bottom Border", "thickBottom"],
      ["Top and Bottom Border", "topBottom"],
      ["Top and Thick Bottom Border", "topThickBottom"],
      ["Top and Double Bottom Border", "topDoubleBottom"],
    ] as [string, string][]
  ).map(([l, p]) => it(l, "home.borders", { preset: p })),
  sep,
  head("Draw Borders"),
  itf("Draw Border", (c) => c.dialog("drawBorder", { edge: "outside" })),
  itf("Draw Border Grid", (c) => c.dialog("drawBorder", { edge: "grid" })),
  sep,
  it("Inside Horizontal Border", "home.borders", { preset: "insideHorizontal" }),
  it("Inside Vertical Border", "home.borders", { preset: "insideVertical" }),
  it("Inside Borders", "home.borders", { preset: "inside" }),
  it("Diagonal Down Border", "home.borders", { preset: "diagonalDown" }),
  it("Diagonal Up Border", "home.borders", { preset: "diagonalUp" }),
  sep,
  itd("More Borders…", "formatCells", { tab: "Border" }),
];

const orientation: Item<SheetCx>[] = [
  it("Angle Counterclockwise", "home.orientation", { angle: 45 }),
  it("Angle Clockwise", "home.orientation", { angle: -45 }),
  it("Vertical Text", "home.orientation", { angle: "vertical" }),
  it("Rotate Text Up", "home.orientation", { angle: 90 }),
  it("Rotate Text Down", "home.orientation", { angle: -90 }),
  it("Horizontal", "home.orientation", { angle: 0 }),
  sep,
  itd("Format Cell Alignment", "formatCells", { tab: "Alignment" }),
];

const mergeItems: Item<SheetCx>[] = [
  it("Merge & Center", "home.mergeCenter"),
  it("Merge Across", "home.mergeAcross"),
  it("Merge Cells", "home.mergeCells"),
  it("Unmerge Cells", "home.unmergeCells"),
];

const accounting: Item<SheetCx>[] = [
  it("$ English (United States)", "home.accounting", { symbol: "$" }),
  it("£ English (United Kingdom)", "home.accounting", { symbol: "£" }),
  it("€ Euro (€ 123)", "home.accounting", { symbol: "€" }),
  it("¥ Chinese (PRC)", "home.accounting", { symbol: "¥" }),
  it("₽ Russian", "home.accounting", { symbol: "₽" }),
  sep,
  itd("More Accounting Formats…", "formatCells", { tab: "Number" }),
].map((x) => (x.label && !x.sep ? { ...x, raw: !x.label.startsWith("More") } : x));

const cfHighlight: Item<SheetCx>[] = [
  itd("Greater Than…", "cfRule", { type: "cellIs", operator: ">" }),
  itd("Less Than…", "cfRule", { type: "cellIs", operator: "<" }),
  itd("Between…", "cfRule", { type: "cellIs", operator: "between" }),
  itd("Equal To…", "cfRule", { type: "cellIs", operator: "=" }),
  itd("Text that Contains…", "cfRule", { type: "containsText" }),
  itd("A Date Occurring…", "cfRule", { type: "timePeriod" }),
  itd("Duplicate Values…", "cfRule", { type: "duplicate" }),
  sep,
  itd("More Rules…", "newRule"),
];
const cfTop: Item<SheetCx>[] = [
  itd("Top 10 Items…", "cfRule", { type: "top10" }),
  itd("Top 10 %…", "cfRule", { type: "top10", percent: true }),
  itd("Bottom 10 Items…", "cfRule", { type: "top10", bottom: true }),
  itd("Bottom 10 %…", "cfRule", { type: "top10", bottom: true, percent: true }),
  itd("Above Average…", "cfRule", { type: "aboveAverage" }),
  itd("Below Average…", "cfRule", { type: "aboveAverage", below: true }),
  sep,
  itd("More Rules…", "newRule"),
];
const bars: [string, string][] = [
  ["Blue", "#638EC6"],
  ["Green", "#63C384"],
  ["Red", "#FF555A"],
  ["Orange", "#FFB628"],
  ["Light Blue", "#008AEF"],
  ["Purple", "#D6007B"],
];
const cfBars: Item<SheetCx>[] = [
  head("Gradient Fill"),
  ...bars.map(([l, c]) => it(`${l} Data Bar`, "home.conditionalFormat", { rule: { type: "dataBar", color: c } }, { swatch: c })),
  head("Solid Fill"),
  ...bars.map(([l, c]) =>
    it(`${l} Data Bar `, "home.conditionalFormat", { rule: { type: "dataBar", color: c, gradient: false } }, { swatch: c }),
  ),
  sep,
  itd("More Rules…", "newRule", { type: "dataBar" }),
];
const scales: [string, string[]][] = [
  ["Green - Yellow - Red Color Scale", ["#F8696B", "#FFEB84", "#63BE7B"].reverse()],
  ["Red - Yellow - Green Color Scale", ["#F8696B", "#FFEB84", "#63BE7B"]],
  ["Green - White Color Scale", ["#FFFFFF", "#63BE7B"]],
  ["White - Green Color Scale", ["#63BE7B", "#FFFFFF"]],
  ["Blue - White - Red Color Scale", ["#5A8AC6", "#FCFCFF", "#F8696B"]],
  ["Red - White - Blue Color Scale", ["#F8696B", "#FCFCFF", "#5A8AC6"]],
  ["White - Red Color Scale", ["#FCFCFF", "#F8696B"]],
  ["Red - White Color Scale", ["#F8696B", "#FCFCFF"]],
  ["Green - Yellow Color Scale", ["#63BE7B", "#FFEB84"]],
  ["Yellow - Green Color Scale", ["#FFEB84", "#63BE7B"]],
];
const cfScales: Item<SheetCx>[] = [
  ...scales.map(([l, colors]) =>
    it(l, "home.conditionalFormat", { rule: { type: "colorScale", colors } }, { swatch: colors[colors.length - 1] }),
  ),
  sep,
  itd("More Rules…", "newRule", { type: "colorScale" }),
];
const iconSets: [string, string][] = [
  ["Directional", ""],
  ["3 Arrows (Colored)", "3Arrows"],
  ["3 Arrows (Gray)", "3ArrowsGray"],
  ["4 Arrows (Gray)", "4ArrowsGray"],
  ["4 Arrows (Colored)", "4Arrows"],
  ["5 Arrows (Gray)", "5ArrowsGray"],
  ["5 Arrows (Colored)", "5Arrows"],
  ["Shapes", ""],
  ["3 Traffic Lights (Unrimmed)", "3TrafficLights1"],
  ["3 Traffic Lights (Rimmed)", "3TrafficLights2"],
  ["4 Traffic Lights", "4TrafficLights"],
  ["Red To Black", "4RedToBlack"],
  ["Indicators", ""],
  ["3 Symbols (Circled)", "3Symbols"],
  ["3 Symbols (Uncircled)", "3Symbols2"],
  ["3 Flags", "3Flags"],
  ["Ratings", ""],
  ["3 Stars", "3Stars"],
  ["4 Ratings", "4Rating"],
  ["5 Quarters", "5Quarters"],
  ["5 Ratings", "5Rating"],
];
const cfIcons: Item<SheetCx>[] = [
  ...iconSets.map(([l, set]) =>
    set ? it(l, "home.conditionalFormat", { rule: { type: "iconSet", set } }) : head(l),
  ),
  sep,
  itd("More Rules…", "newRule", { type: "iconSet" }),
];

const cfMenu: Item<SheetCx>[] = [
  { label: "Highlight Cells Rules", sub: cfHighlight },
  { label: "Top/Bottom Rules", sub: cfTop },
  { label: "Data Bars", sub: cfBars },
  { label: "Color Scales", sub: cfScales },
  { label: "Icon Sets", sub: cfIcons },
  sep,
  itd("New Rule…", "newRule"),
  {
    label: "Clear Rules",
    sub: [
      it("Clear Rules from Selected Cells", "home.clearRules"),
      it("Clear Rules from Entire Sheet", "home.clearRules", { sheet: true }),
    ],
  },
  itd("Manage Rules…", "manageRules"),
];

const tableMenu: Item<SheetCx>[] = [
  galleryItem((c, style) => c.dialog("createTable", { style })),
  sep,
  itd("New Table Style…", "newTableStyle"),
];

const cellStyles: [string, string[]][] = [
  ["Good, Bad and Neutral", ["Normal", "Bad", "Good", "Neutral"]],
  ["Data and Model", ["Calculation", "Check Cell", "Explanatory Text", "Input", "Linked Cell", "Note", "Output", "Warning Text"]],
  ["Titles and Headings", ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Title", "Total"]],
  ["Themed Cell Styles", ["Accent1", "Accent2", "Accent3", "Accent4", "Accent5", "Accent6"]],
  ["Number Format", ["Comma", "Comma [0]", "Currency", "Currency [0]", "Percent"]],
];
const cellStyleMenu: Item<SheetCx>[] = [
  ...cellStyles.flatMap(([h, names]): Item<SheetCx>[] => [
    head(h),
    ...names.map((n) => it(n, "home.cellStyle", { name: n })),
  ]),
  sep,
  itd("New Cell Style…", "newCellStyle"),
];

const insertMenu: Item<SheetCx>[] = [
  itd("Insert Cells…", "insertCells"),
  it("Insert Sheet Rows", "home.insertRows"),
  it("Insert Sheet Columns", "home.insertColumns"),
  it("Insert Sheet", "home.insertSheet"),
];
const deleteMenu: Item<SheetCx>[] = [
  itd("Delete Cells…", "deleteCells"),
  it("Delete Sheet Rows", "home.deleteRows"),
  it("Delete Sheet Columns", "home.deleteColumns"),
  it("Delete Sheet", "home.deleteSheet"),
];

const formatMenu: Item<SheetCx>[] = [
  head("Cell Size"),
  itd("Row Height…", "rowHeight"),
  it("AutoFit Row Height", "home.autofitRowHeight"),
  itd("Column Width…", "columnWidth"),
  it("AutoFit Column Width", "home.autofitColumnWidth"),
  itd("Default Width…", "defaultWidth"),
  head("Visibility"),
  {
    label: "Hide & Unhide",
    sub: [
      it("Hide Rows", "home.hideRows"),
      it("Hide Columns", "home.hideColumns"),
      it("Hide Sheet", "sheet.hide"),
      sep,
      it("Unhide Rows", "home.unhideRows"),
      it("Unhide Columns", "home.unhideColumns"),
      itd("Unhide Sheet…", "unhideSheet"),
    ],
  },
  head("Organize Sheets"),
  itd("Rename Sheet", "renameSheet"),
  itd("Move or Copy Sheet…", "moveSheet"),
  {
    label: "Tab Color",
    sub: colorMenu<SheetCx>("sheet.tabColor", { none: "No Color", noneValue: "none" }),
  },
  head("Protection"),
  itd("Protect Sheet…", "protectSheet"),
  it("Lock Cell", "home.lockCell", undefined, { check: (c) => c.s.format.locked }),
  itd("Format Cells…", "formatCells"),
];

const autoSum: Item<SheetCx>[] = [
  it("Sum", "formulas.autoSum", { function: "SUM" }),
  it("Average", "formulas.autoSum", { function: "AVERAGE" }),
  it("Count Numbers", "formulas.autoSum", { function: "COUNT" }),
  it("Max", "formulas.autoSum", { function: "MAX" }),
  it("Min", "formulas.autoSum", { function: "MIN" }),
  sep,
  itd("More Functions…", "insertFunction"),
];
const fillMenu: Item<SheetCx>[] = [
  it("Down", "edit.fillDown"),
  it("Right", "edit.fillRight"),
  it("Up", "edit.fillUp"),
  it("Left", "edit.fillLeft"),
  itd("Series…", "series"),
  sep,
  it("Flash Fill", "edit.flashFill"),
];
const clearMenu: Item<SheetCx>[] = [
  it("Clear All", "edit.clearAll"),
  it("Clear Formats", "edit.clearFormats"),
  it("Clear Contents", "edit.clearContents"),
  it("Clear Comments and Notes", "edit.clearComments"),
  it("Clear Hyperlinks", "edit.clearHyperlinks"),
];
const sortMenu: Item<SheetCx>[] = [
  it("Sort A to Z", "data.sortAscending"),
  it("Sort Z to A", "data.sortDescending"),
  itd("Custom Sort…", "sort"),
  sep,
  it("Filter", "data.filter", undefined, { check: (c) => c.s.ctx.autofilter }),
  it("Clear", "data.clearFilter"),
  it("Reapply", "data.reapply"),
];
const findMenu: Item<SheetCx>[] = [
  itf("Find…", (c) => c.ui.togglePane("find", true)),
  itf("Replace…", (c) => c.ui.togglePane("find", true)),
  itd("Go To…", "goTo"),
  itd("Go To Special…", "goToSpecial"),
  sep,
  it("Formulas", "edit.goToSpecial", { kind: "formulas" }),
  it("Comments", "edit.goToSpecial", { kind: "comments" }),
  it("Conditional Formatting", "edit.goToSpecial", { kind: "conditionalFormats" }),
  it("Constants", "edit.goToSpecial", { kind: "constants" }),
  it("Data Validation", "edit.goToSpecial", { kind: "dataValidation" }),
];

const ul = (c: SheetCx): boolean => c.s.format.underline !== "None";

export const home: Tab<SheetCx> = {
  id: "home",
  label: "Home",
  groups: [
    group(
      "clipboard",
      "Clipboard",
      [
        menu("paste", "Paste", pasteItems, { big: true, split: cmd("edit.paste") }),
        stack(
          small("cut", "Cut", fn((c) => c.ui.copy(true))),
          menu("copy", "Copy", [it("Copy", "edit.copy"), itd("Copy as Picture…", "copyPicture")], {
            split: fn((c) => c.ui.copy(false)),
          }),
          small("painter", "Format Painter", cmd("edit.formatPainter"), { on: (c) => c.s.painter }),
        ),
      ],
      { launcher: fn((c) => c.ui.togglePane("find", false)) },
    ),
    group(
      "font",
      "Font",
      [
        stack(
          row(custom("fontName"), custom("fontSize"), small("grow", undefined, cmd("home.increaseFontSize"), { tip: "Increase Font Size" }), small("shrink", undefined, cmd("home.decreaseFontSize"), { tip: "Decrease Font Size" })),
          row(
            icon("bold", "Bold (Ctrl+B)", cmd("home.bold"), { on: (c) => c.s.format.bold }),
            icon("italic", "Italic (Ctrl+I)", cmd("home.italic"), { on: (c) => c.s.format.italic }),
            menu("underline", undefined, [it("Underline", "home.underline"), it("Double Underline", "home.doubleUnderline")], {
              tip: "Underline (Ctrl+U)",
              split: cmd("home.underline"),
              on: ul,
            }),
            icon("strike", "Strikethrough", cmd("home.strikethrough"), { on: (c) => c.s.format.strike }),
            menu("border", undefined, borderItems, { tip: "Borders", split: cmd("home.borders", { preset: "bottom" }) }),
            menu("bucket", undefined, colorMenu<SheetCx>("home.fillColor", { none: "No Fill", noneValue: "none", memo: "fill" }), {
              tip: "Fill Color",
              split: () => cmd("home.fillColor", { color: lastColor("fill", "#FFFF00") }),
              swatch: () => lastColor("fill", "#FFFF00"),
            }),
            menu("fontColor", undefined, colorMenu<SheetCx>("home.fontColor", { auto: "Automatic", memo: "font" }), {
              tip: "Font Color",
              split: () => cmd("home.fontColor", { color: lastColor("font", "#FF0000") }),
              swatch: () => lastColor("font", "#FF0000"),
            }),
          ),
        ),
      ],
      { launcher: dlg("formatCells", { tab: "Font" }) },
    ),
    group(
      "align",
      "Alignment",
      [
        stack(
          row(
            icon("alignTop", "Top Align", cmd("home.alignTop"), { on: (c) => c.s.format.v === "Top" }),
            icon("alignMid", "Middle Align", cmd("home.alignMiddle"), { on: (c) => c.s.format.v === "Center" }),
            icon("alignBottom", "Bottom Align", cmd("home.alignBottom"), { on: (c) => c.s.format.v === "Bottom" }),
            menu("rotateCcw", undefined, orientation, { tip: "Orientation" }),
            small("wrapText", "Wrap Text", cmd("home.wrapText"), { on: (c) => c.s.format.wrap }),
          ),
          row(
            icon("alignLeft", "Align Left", cmd("home.alignLeft"), { on: (c) => c.s.format.h === "Left" }),
            icon("alignCenter", "Center", cmd("home.alignCenter"), { on: (c) => c.s.format.h === "Center" }),
            icon("alignRight", "Align Right", cmd("home.alignRight"), { on: (c) => c.s.format.h === "Right" }),
            icon("outdent", "Decrease Indent", cmd("home.decreaseIndent")),
            icon("indent", "Increase Indent", cmd("home.increaseIndent")),
            menu("mergeCells", "Merge & Center", mergeItems, { split: cmd("home.mergeCenter") }),
          ),
        ),
      ],
      { launcher: dlg("formatCells", { tab: "Alignment" }) },
    ),
    group(
      "number",
      "Number",
      [
        stack(
          custom("numFmt"),
          row(
            menu("dollar", undefined, accounting, { tip: "Accounting Number Format", split: cmd("home.accounting") }),
            icon("percent", "Percent Style", cmd("home.percent")),
            icon("hashIc", "Comma Style", cmd("home.comma")),
            icon("plus", "Increase Decimal", cmd("home.increaseDecimal")),
            icon("minus", "Decrease Decimal", cmd("home.decreaseDecimal")),
          ),
        ),
      ],
      { launcher: dlg("formatCells", { tab: "Number" }) },
    ),
    group("styles", "Styles", [
      menu("condFmt", "Conditional\nFormatting", cfMenu, { big: true }),
      menu("tableFmt", "Format as\nTable", tableMenu, { big: true }),
      menu("cellStyles", "Cell\nStyles", cellStyleMenu, { big: true }),
    ]),
    group("cells", "Cells", [
      stack(
        menu("insertBelow", "Insert", insertMenu, { split: dlg("insertCells") }),
        menu("trash", "Delete", deleteMenu, { split: dlg("deleteCells") }),
        menu("layoutGrid", "Format", formatMenu),
      ),
    ]),
    group("editing", "Editing", [
      stack(
        menu("sigma", "AutoSum", autoSum, { split: cmd("formulas.autoSum") }),
        menu("fillDown", "Fill", fillMenu),
        menu("eraser", "Clear", clearMenu),
      ),
      stack(
        menu("sortDesc", "Sort & Filter", sortMenu, { big: false }),
        menu("find", "Find & Select", findMenu),
      ),
    ]),
  ],
};
