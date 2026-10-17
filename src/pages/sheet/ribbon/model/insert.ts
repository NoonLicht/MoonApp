import type { Item, Tab } from "@/pages/word/ribbon/types";
import { big, cmd, dlg, fn, group, it, itd, menu, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

/** Подпись неподдерживаемой движком возможности: кнопка есть, как в Excel, но неактивна. */
export const NA = "Not supported by the spreadsheet engine yet";

const chartTypes: [string, string, [string, string, string][]][] = [
  [
    "Insert Column or Bar Chart",
    "colC",
    [
      ["2-D Column", "column", "clustered"],
      ["Stacked Column", "column", "stacked"],
      ["100% Stacked Column", "column", "stacked100"],
      ["2-D Bar", "bar", "clustered"],
      ["Stacked Bar", "bar", "stacked"],
      ["100% Stacked Bar", "bar", "stacked100"],
    ],
  ],
  [
    "Insert Line or Area Chart",
    "lineC",
    [
      ["Line", "line", "clustered"],
      ["Stacked Line", "line", "stacked"],
      ["100% Stacked Line", "line", "stacked100"],
      ["Line with Markers", "line", "markers"],
      ["Area", "area", "clustered"],
      ["Stacked Area", "area", "stacked"],
      ["100% Stacked Area", "area", "stacked100"],
    ],
  ],
  [
    "Insert Pie or Doughnut Chart",
    "pieC",
    [
      ["Pie", "pie", "clustered"],
      ["Doughnut", "doughnut", "clustered"],
    ],
  ],
  [
    "Insert Statistic Chart",
    "areaC",
    [
      ["Histogram", "histogram", "clustered"],
      ["Box and Whisker", "boxWhisker", "clustered"],
    ],
  ],
  [
    "Insert Scatter (X, Y) or Bubble Chart",
    "scatterC",
    [
      ["Scatter", "scatter", "clustered"],
      ["Scatter with Lines", "scatter", "markers"],
      ["Bubble", "bubble", "clustered"],
    ],
  ],
  [
    "Insert Waterfall, Funnel, Stock, Surface or Radar Chart",
    "barC",
    [
      ["Waterfall", "waterfall", "clustered"],
      ["Funnel", "funnel", "clustered"],
      ["Stock", "stock", "clustered"],
      ["Radar", "radar", "clustered"],
    ],
  ],
  [
    "Insert Hierarchy Chart",
    "layoutGrid",
    [
      ["Treemap", "treemap", "clustered"],
      ["Sunburst", "sunburst", "clustered"],
    ],
  ],
  ["Insert Combo Chart", "comboC", [["Combo", "combo", "clustered"]]],
];

const chartMenu = (label: string, icon: Parameters<typeof menu>[0], items: [string, string, string][]) =>
  menu(
    icon,
    label,
    items.map(([l, type, subtype]): Item<SheetCx> => it(l, "insert.chart", { type, subtype })),
    { tip: label },
  );

const shapes: [string, string][] = [
  ["Rectangle", "rectangle"],
  ["Rounded Rectangle", "roundedRectangle"],
  ["Oval", "ellipse"],
  ["Triangle", "triangle"],
  ["Line", "line"],
  ["Arrow", "arrow"],
  ["Text Box", "textBox"],
];

function pickPicture(cx: SheetCx): void {
  cx.ui.pickFile("image/*", (f) => {
    void cx.ui.upload(f).then((path) => {
      if (path) cx.run("insert.picture", { path, alt: f.name });
    });
  });
}

export const insert: Tab<SheetCx> = {
  id: "insert",
  label: "Insert",
  groups: [
    group("tables", "Tables", [
      menu(
        "pivot",
        "PivotTable",
        [itd("From Table/Range…", "createPivot"), itd("Recommended PivotTables…", "recommendedPivots")],
        { big: true },
      ),
      big("tableFmt", "Table", dlg("createTable", { style: "TableStyleMedium2" })),
    ]),
    group("illustrations", "Illustrations", [
      big("picture", "Pictures", fn(pickPicture)),
      menu(
        "shapesIc",
        "Shapes",
        shapes.map(([l, kind]) => it(l, "insert.shape", { kind })),
        { big: true },
      ),
      big("icons", "Icons", dlg("icons")),
      stack(
        small("smartArt", "SmartArt", fn(() => undefined), { enabled: () => false, tip: NA }),
        small("picture", "Screenshot", fn(() => undefined), { enabled: () => false, tip: NA }),
      ),
    ]),
    group(
      "charts",
      "Charts",
      [
        big("chart", "Recommended\nCharts", dlg("recommendedCharts")),
        stack(
          chartMenu("Column or Bar", "colC", chartTypes[0][2]),
          chartMenu("Line or Area", "lineC", chartTypes[1][2]),
          chartMenu("Pie or Doughnut", "pieC", chartTypes[2][2]),
        ),
        stack(
          chartMenu("Hierarchy", "layoutGrid", chartTypes[6][2]),
          chartMenu("Statistic", "areaC", chartTypes[3][2]),
          chartMenu("Scatter or Bubble", "scatterC", chartTypes[4][2]),
        ),
        stack(
          chartMenu("Waterfall or Stock", "barC", chartTypes[5][2]),
          chartMenu("Combo", "comboC", chartTypes[7][2]),
          small("pivot", "PivotChart", dlg("pivotChart")),
        ),
      ],
      { launcher: dlg("recommendedCharts") },
    ),
    group("sparklines", "Sparklines", [
      menu(
        "activity",
        "Sparklines",
        [
          itd("Line", "sparkline", { type: "line" }),
          itd("Column", "sparkline", { type: "column" }),
          itd("Win/Loss", "sparkline", { type: "winLoss" }),
        ],
        { big: true },
      ),
    ]),
    group("filters", "Filters", [
      big("slice", "Slicer", dlg("slicer")),
      small("calendarDays", "Timeline", fn(() => undefined), { enabled: () => false, tip: NA }),
    ]),
    group("links", "Links", [big("link", "Link", dlg("insertLink"))]),
    group("comments", "Comments", [
      menu("comment", "Comment", [it("New Comment", "review.newComment", { text: "" }), it("New Note", "review.newNote", { text: "" })], {
        big: true,
      }),
    ]),
    group("text", "Text", [
      big("textBox", "Text Box", cmd("insert.textBox", { text: "Text" })),
      big("header", "Header &\nFooter", dlg("pageSetup", { tab: "Header/Footer" })),
      stack(
        small("wordArt", "WordArt", fn(() => undefined), { enabled: () => false, tip: NA }),
        small("signature", "Signature Line", fn(() => undefined), { enabled: () => false, tip: NA }),
        small("object", "Object", fn(() => undefined), { enabled: () => false, tip: NA }),
      ),
    ]),
    group("symbols", "Symbols", [
      small("equation", "Equation", fn(() => undefined), { enabled: () => false, tip: NA }),
      big("symbol", "Symbol", dlg("symbol")),
    ]),
    group("controls", "Cell Controls", [big("check", "Checkbox", cmd("insert.checkbox"))]),
  ],
};

