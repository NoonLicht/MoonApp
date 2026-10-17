import { colorMenu } from "@/pages/word/ribbon/colors";
import {
  big,
  cmd,
  dlg,
  fn,
  group,
  icon,
  it,
  itd,
  menu,
  row,
  small,
  stack,
} from "@/pages/word/ribbon/model/h";
import { rgbHex } from "@/pages/word/lib";
import type { Cx, Tab } from "@/pages/word/ribbon/types";

const ctl = (ic: Parameters<typeof icon>[0], tip: string, c: string) => icon(ic, tip, cmd(c));

export const developer: Tab = {
  id: "Developer",
  label: "Developer",
  groups: [
    group("controls", "Controls", [
      stack(
        row(
          ctl("textBox", "Rich Text Content Control", "developer.richText"),
          ctl("font", "Plain Text Content Control", "developer.plainText"),
          ctl("picture", "Picture Content Control", "developer.picture"),
        ),
        row(
          ctl("quickParts", "Building Block Gallery Content Control", "developer.buildingBlock"),
          ctl("check", "Check Box Content Control", "developer.checkBox"),
          ctl("controls", "Combo Box Content Control", "developer.comboBox"),
        ),
        row(
          ctl("chevD", "Drop-Down List Content Control", "developer.dropDown"),
          ctl("dateTime", "Date Picker Content Control", "developer.datePicker"),
          ctl("rows", "Repeating Section Content Control", "developer.repeatingSection"),
        ),
      ),
      stack(
        small("design", "Design Mode", cmd("developer.designMode"), {
          on: (cx) => cx.s.view.designMode,
        }),
        small("properties", "Properties", dlg("controlProperties")),
      ),
    ]),
  ],
};

const penColor = (cx: Cx): string => {
  const d = cx.s.view.draw;
  const tool = d.mode === "pencil" ? d.pencil : d.mode === "highlighter" ? d.highlighter : d.pen;
  return `#${rgbHex(tool.color)}`;
};

const penCmd = (cx: Cx): string =>
  cx.s.view.draw.mode === "pencil"
    ? "draw.pencil"
    : cx.s.view.draw.mode === "highlighter"
      ? "draw.highlighter"
      : "draw.pen";

export const draw: Tab = {
  id: "Draw",
  label: "Draw",
  groups: [
    group("tools", "Drawing Tools", [
      big("select", "Select", cmd("draw.select"), { on: (cx) => cx.s.view.draw.mode === "select" }),
      big("lasso", "Lasso", cmd("draw.lasso"), { on: (cx) => cx.s.view.draw.mode === "lasso" }),
      big("eraserTool", "Eraser", cmd("draw.eraser"), {
        on: (cx) => cx.s.view.draw.mode === "eraser",
      }),
      big("pen", "Pen", cmd("draw.pen"), { on: (cx) => cx.s.view.draw.mode === "pen" }),
      big("pencil", "Pencil", cmd("draw.pencil"), { on: (cx) => cx.s.view.draw.mode === "pencil" }),
      big("highlight", "Highlighter", cmd("draw.highlighter"), {
        on: (cx) => cx.s.view.draw.mode === "highlighter",
      }),
      menu(
        "plus",
        "Add\nPen",
        [
          it("Pen", "draw.addPen", { kind: "pen" }),
          it("Pencil", "draw.addPen", { kind: "pencil" }),
          it("Highlighter", "draw.addPen", { kind: "highlighter" }),
        ],
        { big: true, tip: "Add Pen" },
      ),
      stack(
        menu("fontColor", "Color", (cx) => colorMenu(penCmd(cx)), { swatch: penColor }),
        menu("lineSpacing", "Thickness", (cx) =>
          (cx.s.view.draw.mode === "highlighter"
            ? [4, 8, 12, 18, 24]
            : [0.5, 1, 1.5, 2.5, 3.5, 5]
          ).map((w) => it(`${w} pt`, penCmd(cx), { width: w }, { raw: true })),
        ),
      ),
    ]),
    group("convert", "Convert", [
      big("shapes", "Ink to\nShape", cmd("draw.inkToShape"), {
        on: (cx) => cx.s.view.draw.inkToShape,
      }),
    ]),
    group("insert", "Insert", [big("canvas", "Drawing\nCanvas", cmd("insert.canvas"))]),
    group("replay", "Replay", [
      big("record", "Ink\nReplay", cmd("draw.replay"), { on: (cx) => !!cx.s.view.draw.replay }),
    ]),
  ],
};

export const help: Tab = {
  id: "Help",
  label: "Help",
  groups: [
    group("help", "Help", [
      big("help", "Help", dlg("about")),
      big("commands", "Commands", dlg("commands")),
    ]),
    group("data", "Document", [
      menu("export", "Export", [itd("Save a Copy…", "saveAs"), itd("Export PDF…", "exportPdf")], {
        big: true,
      }),
      big(
        "print",
        "Print",
        fn(() => window.print()),
      ),
    ]),
  ],
};

export const hf: Tab = {
  id: "Header & Footer",
  label: "Header & Footer",
  contextual: true,
  groups: [
    group("hf", "Header & Footer", [
      menu(
        "header",
        "Header",
        [
          it("Blank", "insert.header", { preset: "blank" }),
          it("Blank (Three Columns)", "insert.header", { preset: "blankThree" }),
          it("Document Title", "insert.header", { preset: "title" }),
          it("Remove Header", "insert.removeHeader"),
        ],
        { big: true },
      ),
      menu(
        "footer",
        "Footer",
        [
          it("Blank", "insert.footer", { preset: "blank" }),
          it("Blank (Three Columns)", "insert.footer", { preset: "blankThree" }),
          it("Page Number", "insert.footer", { preset: "pageNumber" }),
          it("Remove Footer", "insert.removeFooter"),
        ],
        { big: true },
      ),
      menu(
        "pageNumber",
        "Page\nNumber",
        [
          it("Top of Page", "insert.pageNumber", { position: "top", align: "right" }),
          it("Bottom of Page", "insert.pageNumber", { position: "bottom", align: "center" }),
          it("Page X of Y", "insert.pageNumber", { position: "bottom", format: "x of y" }),
          it("Current Position", "insert.pageNumber", { position: "current" }),
          itd("Format Page Numbers…", "pageNumberFormat"),
        ],
        { big: true, tip: "Page Number" },
      ),
    ]),
    group("nav", "Navigation", [
      stack(
        small("prev", "Previous Section", cmd("hf.previous")),
        small("next", "Next Section", cmd("hf.next")),
        small("link", "Link to Previous", cmd("layout.linkToPrevious")),
      ),
    ]),
    group("opts", "Options", [
      stack(
        {
          k: "check",
          label: "Different First Page",
          on: (cx) => !!cx.s.ctx.section.titlePage,
          act: (cx) => cx.run("layout.differentFirstPage"),
        },
        {
          k: "check",
          label: "Different Odd & Even Pages",
          on: (cx) => cx.s.settings.evenOdd,
          act: (cx) => cx.run("layout.differentOddEven"),
        },
      ),
    ]),
    group("pos", "Position", [{ k: "custom", id: "hfPosition" }]),
    group("close", "Close", [big("clear", "Close Header\nand Footer", cmd("insert.closeHeader"))]),
  ],
};
