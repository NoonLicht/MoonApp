import { createElement } from "react";
import { SymbolGrid, TableGrid } from "@/pages/word/ribbon/pickers";
import {
  big,
  cmd,
  dlg,
  fn,
  group,
  it,
  itd,
  itf,
  menu,
  sep,
  small,
  stack,
} from "@/pages/word/ribbon/model/h";
import type { Cx, Item, Tab } from "@/pages/word/ribbon/types";

const SHAPES: [string, string][] = [
  ["Rectangle", "rectangle"],
  ["Rounded Rectangle", "roundedRectangle"],
  ["Oval", "ellipse"],
  ["Triangle", "triangle"],
  ["Diamond", "diamond"],
  ["Line", "line"],
  ["Arrow", "arrow"],
  ["Star", "star"],
  ["Heart", "heart"],
];

const CONNECTORS: [string, string, string][] = [
  ["Straight Connector", "straightConnector", "none"],
  ["Straight Arrow Connector", "straightConnector", "end"],
  ["Elbow Connector", "elbowConnector", "none"],
  ["Elbow Arrow Connector", "elbowConnector", "end"],
  ["Curved Connector", "curvedConnector", "none"],
  ["Curved Arrow Connector", "curvedConnector", "end"],
];

const headerItems = (kind: "header" | "footer"): Item[] => [
  it("Blank", `insert.${kind}`, { preset: "blank" }),
  it("Blank (Three Columns)", `insert.${kind}`, { preset: "blankThree" }),
  kind === "header"
    ? it("Document Title", "insert.header", { preset: "title" })
    : it("Page Number", "insert.footer", { preset: "pageNumber" }),
  sep,
  it(
    kind === "header" ? "Edit Header" : "Edit Footer",
    kind === "header" ? "insert.editHeader" : "insert.editFooter",
  ),
  it(
    kind === "header" ? "Remove Header" : "Remove Footer",
    kind === "header" ? "insert.removeHeader" : "insert.removeFooter",
  ),
];

export const insert: Tab = {
  id: "Insert",
  label: "Insert",
  groups: [
    group("pages", "Pages", [
      stack(
        menu("coverPage", "Cover Page", [
          it("Studio cover", "insert.coverPage"),
          itd("Custom Cover Page…", "coverPage"),
        ]),
        small("blankPage", "Blank Page", cmd("insert.blankPage")),
        small("pageBreak", "Page Break", cmd("insert.pageBreak")),
      ),
    ]),
    group("tables", "Tables", [
      menu(
        "table",
        "Table",
        [
          { render: (cx: Cx, close: () => void) => createElement(TableGrid, { cx, close }) },
          sep,
          itd("Insert Table…", "insertTable"),
          itf("Draw Table", (cx) => cx.ui.setTool("drawTable")),
          it("Convert Text to Table…", "table.fromText"),
          {
            label: "Quick Tables",
            sub: [
              it("Tabular List", "table.quick", { kind: "tabular" }),
              it("Matrix", "table.quick", { kind: "matrix" }),
              it("Calendar", "table.quick", { kind: "calendar" }),
            ],
          },
          it("Spreadsheet Table", "insert.spreadsheet"),
        ],
        { big: true, tip: "Add a Table" },
      ),
    ]),
    group("illustrations", "Illustrations", [
      big(
        "picture",
        "Pictures",
        fn((cx) => cx.ui.pickImage("insert.picture")),
      ),
      menu(
        "shapes",
        "Shapes",
        [
          ...SHAPES.map(([l, k]) => it(l, "insert.shape", { kind: k })),
          sep,
          it("New Drawing Canvas", "insert.canvas"),
          ...CONNECTORS.map(([l, k, a]) => it(l, "insert.shape", { kind: k, arrow: a })),
        ],
        { big: true },
      ),
      stack(
        small("icons", "Icons", dlg("icons")),
        small("smartArt", "SmartArt", dlg("insertSmartArt")),
        small("chart", "Chart", dlg("insertChart")),
      ),
    ]),
    group("links", "Links", [
      stack(
        small("link", "Link", dlg("link")),
        small("bookmark", "Bookmark", dlg("bookmark")),
        small("crossRef", "Cross-reference", dlg("crossReference")),
      ),
    ]),
    group("comments", "Comments", [big("comment", "Comment", dlg("newComment"))]),
    group("hf", "Header & Footer", [
      menu("header", "Header", headerItems("header"), { big: true }),
      menu("footer", "Footer", headerItems("footer"), { big: true }),
      menu(
        "pageNumber",
        "Page\nNumber",
        [
          it("Top of Page", "insert.pageNumber", { position: "top", align: "right" }),
          it("Bottom of Page", "insert.pageNumber", { position: "bottom", align: "center" }),
          it("Page X of Y", "insert.pageNumber", { position: "bottom", format: "x of y" }),
          it("Current Position", "insert.pageNumber", { position: "current" }),
          sep,
          itd("Format Page Numbers…", "pageNumberFormat"),
        ],
        { big: true, tip: "Page Number" },
      ),
    ]),
    group("text", "Text", [
      big("textBox", "Text\nBox", cmd("insert.textBox")),
      stack(
        menu("quickParts", "Quick Parts", [
          itd("Field…", "field"),
          itd("AutoText…", "autoText"),
          itd("Document Property", "docProperty"),
          itd("Building Blocks Organizer…", "quickParts"),
        ]),
        menu("wordArt", "WordArt", [
          ...(
            [
              ["Solid", "solid"],
              ["Outlined", "outlined"],
              ["Hollow", "hollow"],
              ["Gradient", "gradient"],
              ["Shadowed", "shadowed"],
              ["Glowing", "glowing"],
              ["Reflected", "reflected"],
              ["Sunset", "sunset"],
            ] as const
          ).map(([l, v]) => it(l, "insert.wordArt", { style: v })),
        ]),
        menu("dropCap", "Drop Cap", [
          it("None", "insert.dropCap", { lines: 0 }),
          it("Dropped", "insert.dropCap", { lines: 3 }),
          it("In margin", "insert.dropCap", { lines: 2 }),
          itd("Drop Cap Options…", "dropCap"),
        ]),
      ),
      stack(
        small("signature", "Signature Line", dlg("signatureLine")),
        small("dateTime", "Date & Time", dlg("dateTime")),
        small("object", "Object", dlg("insertObject")),
      ),
    ]),
    group("symbols", "Symbols", [
      menu(
        "equation",
        "Equation",
        [
          it("Insert New Equation", "insert.equation"),
          itd("Equation Gallery…", "equationGallery"),
          itd("Equation from Text…", "equationText"),
        ],
        { big: true, split: cmd("insert.equation") },
      ),
      menu(
        "symbol",
        "Symbol",
        [
          { render: (cx: Cx, close: () => void) => createElement(SymbolGrid, { cx, close }) },
          sep,
          itd("More Symbols…", "symbol"),
        ],
        { big: true },
      ),
    ]),
  ],
};
