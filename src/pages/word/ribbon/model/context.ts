import { createElement } from "react";
import { colorMenu } from "@/pages/word/ribbon/colors";
import { SymbolGrid } from "@/pages/word/ribbon/pickers";
import { arrangeGroup } from "@/pages/word/ribbon/model/layout";
import {
  big,
  check,
  cmd,
  custom,
  dlg,
  fn,
  group,
  it,
  menu,
  row,
  sep,
  small,
  stack,
  icon,
} from "@/pages/word/ribbon/model/h";
import type { Cx, Tab } from "@/pages/word/ribbon/types";

const sel = (cx: Cx) => cx.s.ctx;

/* ---------------- Таблица ---------------- */

const tableBorders = [
  ["All Borders", "all"],
  ["Outside Borders", "outside"],
  ["Inside Borders", "inside"],
  ["No Border", "none"],
  ["Top Border", "top"],
  ["Bottom Border", "bottom"],
  ["Left Border", "left"],
  ["Right Border", "right"],
] as const;

export const tableDesign: Tab = {
  id: "Table Design",
  label: "Table Design",
  contextual: true,
  groups: [
    group("look", "Table Style Options", [custom("tableLook")]),
    group("styles", "Table Styles", [
      custom("tableStyles"),
      stack(
        menu("shading", "Shading", [
          it("No Color", "table.shading", { color: null }),
          ...colorMenu("table.shading", { memo: "tshade" }),
        ]),
      ),
    ]),
    group("borders", "Borders", [
      menu(
        "borders",
        "Borders",
        tableBorders.map(([l, k]) => it(l, "table.borders", { kind: k })),
        { big: true },
      ),
      big("pen", "Border\nPainter", cmd("table.borderPainter")),
    ]),
  ],
};

export const tableLayout: Tab = {
  id: "Table Layout",
  label: "Table Layout",
  contextual: true,
  groups: [
    group("table", "Table", [
      stack(
        menu("select", "Select", [
          it("Select Cell", "table.selectCell"),
          it("Select Column", "table.selectColumn"),
          it("Select Row", "table.selectRow"),
          it("Select Table", "table.selectTable"),
        ]),
        small("grid", "View Gridlines", cmd("table.viewGridlines"), {
          on: (cx) => cx.s.view.tableGridlines,
        }),
        small("tableProps", "Properties", dlg("tableProperties")),
      ),
    ]),
    group("draw", "Draw", [
      big(
        "pen",
        "Draw\nTable",
        fn((cx) => cx.ui.setTool(cx.ui.tool === "drawTable" ? null : "drawTable")),
        { on: (cx) => cx.ui.tool === "drawTable" },
      ),
      big(
        "eraserTool",
        "Eraser",
        fn((cx) => cx.ui.setTool(cx.ui.tool === "eraseTable" ? null : "eraseTable")),
        { on: (cx) => cx.ui.tool === "eraseTable" },
      ),
    ]),
    group("rc", "Rows & Columns", [
      menu(
        "trash",
        "Delete",
        [
          it("Delete Cells", "table.deleteCells"),
          it("Delete Columns", "table.deleteColumn"),
          it("Delete Rows", "table.deleteRow"),
          it("Delete Table", "table.deleteTable"),
        ],
        { big: true },
      ),
      big("insertAbove", "Insert\nAbove", cmd("table.insertRowAbove")),
      stack(
        small("insertBelow", "Insert Below", cmd("table.insertRowBelow")),
        small("insertLeft", "Insert Left", cmd("table.insertColumnLeft")),
        small("insertRight", "Insert Right", cmd("table.insertColumnRight")),
      ),
    ]),
    group("merge", "Merge", [
      stack(
        small("merge", "Merge Cells", cmd("table.merge")),
        small("splitCells", "Split Cells", dlg("splitCells")),
        small("split", "Split Table", cmd("table.splitTable")),
      ),
    ]),
    group("size", "Cell Size", [
      menu(
        "size",
        "AutoFit",
        [
          it("AutoFit Contents", "table.autofit", { mode: "contents" }),
          it("AutoFit Window", "table.autofit", { mode: "window" }),
          it("Fixed Column Width", "table.autofit", { mode: "fixed" }),
        ],
        { big: true },
      ),
      custom("cellSize"),
      stack(
        small("rowsAlt", "Distribute Rows", cmd("table.distributeRows")),
        small("cols", "Distribute Columns", cmd("table.distributeColumns")),
      ),
    ]),
    group("align", "Alignment", [
      custom("cellAlign"),
      big("orientation", "Text\nDirection", cmd("table.textDirection")),
      big("margins", "Cell\nMargins", dlg("cellMargins")),
    ]),
    group("data", "Data", [
      big("sort", "Sort", dlg("sortTable")),
      stack(
        small("rows", "Repeat Header Rows", cmd("table.repeatHeader")),
        small("sort", "Convert to Text", dlg("tableToText")),
        small("wordCount", "Formula", dlg("tableFormula")),
      ),
    ]),
  ],
};

/* ---------------- Рисунок ---------------- */

export const pictureFormat: Tab = {
  id: "Picture Format",
  label: "Picture Format",
  contextual: true,
  groups: [
    group("adjust", "Adjust", [
      menu(
        "sun",
        "Corrections",
        [
          it("Brighter +20%", "picture.corrections", { brightness: 20, contrast: 0 }),
          it("Darker −20%", "picture.corrections", { brightness: -20, contrast: 0 }),
          it("More Contrast +20%", "picture.corrections", { brightness: 0, contrast: 20 }),
          it("Less Contrast −20%", "picture.corrections", { brightness: 0, contrast: -20 }),
          sep,
          it("Sharpen", "picture.corrections", { sharpen: 40 }),
          it("Soften", "picture.corrections", { sharpen: -40 }),
        ],
        { big: true },
      ),
      menu(
        "colors",
        "Color",
        [
          it("Full Saturation 100%", "picture.color", { mode: "saturation", saturation: 100 }),
          it("Muted 50%", "picture.color", { mode: "saturation", saturation: 50 }),
          it("Gray 0%", "picture.color", { mode: "saturation", saturation: 0 }),
          it("Vivid 200%", "picture.color", { mode: "saturation", saturation: 200 }),
          sep,
          it("Grayscale", "picture.color", { mode: "grayscale" }),
          it("Sepia", "picture.color", { mode: "sepia" }),
          it("Washout", "picture.color", { mode: "washout" }),
          it("Black and White", "picture.color", { mode: "blackAndWhite" }),
        ],
        { big: true },
      ),
      menu(
        "wand",
        "Artistic\nEffects",
        [
          it("Blur", "picture.effects", { effect: "blur" }),
          it("Sharpen", "picture.effects", { effect: "sharpen" }),
          it("Invert", "picture.effects", { effect: "invert" }),
          it("Posterize", "picture.effects", { effect: "posterize" }),
          it("Pixelate", "picture.effects", { effect: "pixelate" }),
        ],
        { big: true, tip: "Artistic Effects" },
      ),
      menu(
        "droplets",
        "Transparency",
        [0, 15, 30, 50, 65, 80, 95].map((v) =>
          it(`${v}%`, "picture.transparency", { percent: v }, { raw: true }),
        ),
        { big: true },
      ),
      stack(
        small("wand", "Remove Background", cmd("picture.removeBackground")),
        small(
          "changePic",
          "Change Picture",
          fn((cx) => cx.ui.pickImage("picture.change")),
        ),
        small("clear", "Reset Picture", cmd("picture.reset")),
      ),
    ]),
    group("styles", "Picture Styles", [
      menu(
        "picture",
        "Styles",
        [
          it("Simple Frame", "picture.style", { style: "simpleFrame" }),
          it("Thick Frame", "picture.style", { style: "thickFrame" }),
          it("Rounded", "picture.style", { style: "rounded" }),
          it("Soft Edge", "picture.style", { style: "softEdge" }),
          it("Shadow", "picture.style", { style: "shadow" }),
        ],
        { big: true, tip: "Picture Styles" },
      ),
      menu(
        "border",
        "Border",
        [
          it("Thin", "picture.border", { width: 2 }),
          it("Medium", "picture.border", { width: 4 }),
          it("Thick", "picture.border", { width: 8 }),
        ],
        { big: true, tip: "Picture Border" },
      ),
    ]),
    group("alt", "Accessibility", [
      big(
        "accessibility",
        "Alt\nText",
        fn((cx) => cx.ui.togglePane("altText", true)),
      ),
    ]),
    arrangeGroup(),
    group("size", "Size", [custom("objSize"), big("crop", "Crop", dlg("crop"))]),
  ],
};

/* ---------------- Фигура ---------------- */

export const shapeFormat: Tab = {
  id: "Shape Format",
  label: "Shape Format",
  contextual: true,
  groups: [
    group("styles", "Shape Styles", [
      stack(
        menu("shading", "Shape Fill", [
          it("No Color", "shape.fill", { color: null }),
          ...colorMenu("shape.fill", { memo: "sfill" }),
        ]),
        menu("pen", "Shape Outline", [
          it("No Color", "shape.outline", { color: null }),
          ...colorMenu("shape.outline"),
          sep,
          {
            label: "Weight",
            sub: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) =>
              it(`${w} pt`, "shape.outline", { color: "000000", width: w }, { raw: true }),
            ),
          },
        ]),
        menu("effects", "Shape Effects", [
          {
            label: "Shadow",
            sub: [
              it("No Shadow", "shape.effects", { shadow: null }),
              it("Offset: Bottom Right", "shape.effects", { shadow: "offsetBottomRight" }),
              it("Offset: Bottom", "shape.effects", { shadow: "offsetBottom" }),
            ],
          },
          {
            label: "Glow",
            sub: [
              it("No Glow", "shape.effects", { glow: null }),
              ...[5, 8, 11, 18].map((g) =>
                it(`${g} pt`, "shape.effects", { glow: g }, { raw: true }),
              ),
            ],
          },
          {
            label: "Soft Edges",
            sub: [
              it("No Soft Edges", "shape.effects", { softEdge: null }),
              ...[1, 2.5, 5, 10, 25, 50].map((g) =>
                it(`${g} pt`, "shape.effects", { softEdge: g }, { raw: true }),
              ),
            ],
          },
        ]),
      ),
    ]),
    group("alt", "Accessibility", [
      big(
        "accessibility",
        "Alt\nText",
        fn((cx) => cx.ui.togglePane("altText", true)),
      ),
    ]),
    group(
      "canvas",
      "Drawing Canvas",
      [
        menu(
          "canvas",
          "Drawing\nCanvas",
          [
            it("Fit", "canvas.fit"),
            it("Expand", "canvas.expand"),
            {
              label: "Scale Drawing",
              sub: [50, 75, 125, 150, 200].map((p) =>
                it(`${p}%`, "canvas.scale", { factor: p / 100 }, { raw: true }),
              ),
            },
          ],
          { big: true },
        ),
      ],
      {},
    ),
    group("wordart", "WordArt Styles", [
      menu(
        "wordArt",
        "Styles",
        [
          "solid",
          "outlined",
          "hollow",
          "gradient",
          "shadowed",
          "glowing",
          "reflected",
          "sunset",
        ].map((v) => it(v[0].toUpperCase() + v.slice(1), "wordArt.style", { style: v })),
        { big: true, tip: "WordArt Styles" },
      ),
      stack(
        menu("shading", "Text Fill", [
          it("No Color", "wordArt.textFill", { fill: "none" }),
          ...colorMenu("wordArt.textFill", { key: "fill" }),
        ]),
        menu("pen", "Text Outline", [
          it("No Color", "wordArt.textOutline", { outline: "none" }),
          ...colorMenu("wordArt.textOutline"),
        ]),
        menu("effects", "Text Effects", [
          {
            label: "Transform",
            sub: [
              "textArchUp",
              "textArchDown",
              "textCircle",
              "textWave1",
              "textSlantUp",
              "textSlantDown",
            ].map((p) => it(p, "wordArt.transform", { preset: p }, { raw: true })),
          },
        ]),
      ),
    ]),
    group("text", "Text", [
      stack(
        menu("orientation", "Text Direction", [
          it("Horizontal", "shape.textDirection", { dir: "horz" }),
          it("Rotate all text 90°", "shape.textDirection", { dir: "vert" }),
          it("Rotate all text 270°", "shape.textDirection", { dir: "vert270" }),
          it("Stacked", "shape.textDirection", { dir: "wordArtVert" }),
        ]),
        menu("alignTop", "Align Text", [
          it("Top", "shape.alignText", { anchor: "t" }),
          it("Middle", "shape.alignText", { anchor: "ctr" }),
          it("Bottom", "shape.alignText", { anchor: "b" }),
        ]),
        small("link", "Create Link", cmd("shape.link")),
      ),
    ]),
    arrangeGroup(),
    group("size", "Size", [custom("objSize")]),
  ],
};

/* ---------------- Диаграмма и SmartArt ---------------- */

const LEGEND_POS: [string, string][] = [
  ["Right", "right"],
  ["Top", "top"],
  ["Left", "left"],
  ["Bottom", "bottom"],
];

export const chartDesign: Tab = {
  id: "Chart Design",
  label: "Chart Design",
  contextual: true,
  groups: [
    group("layouts", "Chart Layouts", [
      menu(
        "chart",
        "Chart Title",
        [
          {
            label: "None",
            act: cmd("chart.title", { text: null }),
            check: (cx) => !sel(cx).object?.chart?.title,
          },
          {
            label: "Above Chart",
            act: cmd("chart.title", {}),
            check: (cx) => !!sel(cx).object?.chart?.title,
          },
        ],
        { big: true },
      ),
      menu(
        "chart",
        "Legend",
        [
          {
            label: "None",
            act: cmd("chart.legend", { pos: "none" }),
            check: (cx) => !sel(cx).object?.chart?.legend,
          },
          ...LEGEND_POS.map(([l, p]) =>
            it(
              l,
              "chart.legend",
              { pos: p },
              { check: (cx: Cx) => sel(cx).object?.chart?.legend === p },
            ),
          ),
        ],
        { big: true },
      ),
      menu(
        "chart",
        "Data Labels",
        [
          {
            label: "None",
            act: cmd("chart.dataLabels", { on: false }),
            check: (cx) => !sel(cx).object?.chart?.dataLabels,
          },
          {
            label: "Show",
            act: cmd("chart.dataLabels", { on: true }),
            check: (cx) => !!sel(cx).object?.chart?.dataLabels,
          },
        ],
        { big: true },
      ),
    ]),
    group("data", "Data", [big("table", "Edit\nData", dlg("chartData"))]),
    group("type", "Type", [big("chart", "Change\nChart Type", dlg("changeChartType"))]),
    group("size", "Size", [custom("objSize")]),
  ],
};

const SMART_LAYOUTS: [string, string][] = [
  ["Basic List", "basicList"],
  ["Process", "process"],
  ["Cycle", "cycle"],
  ["Hierarchy", "hierarchy"],
  ["Pyramid", "pyramid"],
  ["Radial", "radial"],
  ["Matrix", "matrix"],
  ["Venn", "venn"],
];

export const smartArtDesign: Tab = {
  id: "SmartArt Design",
  label: "SmartArt Design",
  contextual: true,
  groups: [
    group("create", "Create Graphic", [
      big("plus", "Add\nShape", cmd("smartArt.addShape")),
      stack(
        small("up", "Promote", cmd("smartArt.promote")),
        small("down", "Demote", cmd("smartArt.demote")),
        small(
          "rows",
          "Text Pane",
          fn((cx) => cx.ui.togglePane("smartArt")),
          { on: (cx) => cx.ui.pane === "smartArt" },
        ),
      ),
    ]),
    group("layouts", "Layouts", [
      menu(
        "smartArt",
        "Change Layout",
        SMART_LAYOUTS.map(([l, v]) =>
          it(
            l,
            "smartArt.layout",
            { layout: v },
            { check: (cx: Cx) => sel(cx).object?.smartArt?.layout === v },
          ),
        ),
        { big: true },
      ),
    ]),
    group("styles", "SmartArt Styles", [
      menu(
        "colors",
        "Change\nColors",
        ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "colorful"].map((v) =>
          it(
            v[0].toUpperCase() + v.slice(1),
            "smartArt.colors",
            { variant: v },
            { raw: true, check: (cx: Cx) => sel(cx).object?.smartArt?.colors === v },
          ),
        ),
        { big: true, tip: "Change Colors" },
      ),
    ]),
    group("reset", "Reset", [big("clear", "Reset\nGraphic", cmd("smartArt.reset"))]),
  ],
};

/* ---------------- Формула ---------------- */

export const equationTab: Tab = {
  id: "Equation",
  label: "Equation",
  contextual: true,
  groups: [
    group("tools", "Tools", [
      big("equation", "Display", cmd("equation.display")),
      stack(
        small("equal", "Professional", cmd("equation.convert", { to: "professional" })),
        small("code", "Linear", cmd("equation.convert", { to: "linear" })),
        small("font", "Normal Text", cmd("equation.normalText")),
      ),
    ]),
    group("conv", "Conversions", [
      stack(
        small("code", "LaTeX", cmd("equation.inputFormat", { format: "latex" })),
        small("symbol", "Unicode", cmd("equation.inputFormat", { format: "unicode" })),
        small("rows", "Equation Number", cmd("equation.number")),
      ),
    ]),
    group("symbols", "Symbols", [
      menu(
        "symbol",
        "Symbol",
        [{ render: (cx: Cx, close: () => void) => createElement(SymbolGrid, { cx, close }) }],
        { big: true },
      ),
    ]),
    group("structures", "Structures", [big("radical", "Structures", dlg("equationGallery"))]),
  ],
};

/* ---------------- Структура ---------------- */

export const outlining: Tab = {
  id: "Outlining",
  label: "Outlining",
  contextual: true,
  groups: [
    group("tools", "Outline Tools", [
      stack(
        row(
          icon("top", "Promote to Heading 1", cmd("outline.promoteToHeading1")),
          icon("chevL", "Promote", cmd("outline.promote")),
          custom("outlineLevel"),
          icon("chevR", "Demote", cmd("outline.demote")),
          icon("bottom", "Demote to Body Text", cmd("outline.demoteToBody")),
        ),
        row(
          icon("up", "Move Up", cmd("outline.moveUp")),
          icon("down", "Move Down", cmd("outline.moveDown")),
          icon("plus", "Expand", cmd("outline.expand")),
          icon("minus", "Collapse", cmd("outline.collapse")),
        ),
        row(
          check(
            "Show Text Formatting",
            (cx) => !cx.s.view.outline.hideFormatting,
            (cx, v) => cx.run("outline.showFormatting", { value: v }),
          ),
          check(
            "Show First Line Only",
            (cx) => cx.s.view.outline.firstLineOnly,
            (cx, v) => cx.run("outline.firstLineOnly", { value: v }),
          ),
        ),
      ),
    ]),
    group("close", "Close", [big("clear", "Close Outline\nView", cmd("outline.close"))]),
  ],
};
