import type { Item, Tab } from "@/pages/word/ribbon/types";
import { big, check, cmd, dlg, fn, group, it, itd, menu, sep, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const THEMES = ["Craft", "Slate", "Meadow", "Ember", "Ocean", "Orchid", "Graphite"];

const margins: Item<SheetCx>[] = [
  it("Normal", "pageLayout.margins", { preset: "normal" }),
  it("Wide", "pageLayout.margins", { preset: "wide" }),
  it("Narrow", "pageLayout.margins", { preset: "narrow" }),
  sep,
  itd("Custom Margins…", "pageSetup", { tab: "Margins" }),
];
const sizes = ["Letter", "Legal", "A4", "A3", "A5", "Tabloid", "Executive"];
const breaks: Item<SheetCx>[] = [
  it("Insert Page Break", "pageLayout.breaks", { insert: true }),
  it("Remove Page Break", "pageLayout.breaks", { remove: true }),
  it("Reset All Page Breaks", "pageLayout.breaks", { reset: true }),
];
/** Применить команду расположения к выбранному на листе объекту. */
export function arrangeSel(cx: SheetCx, command: string, extra: Record<string, unknown> = {}): void {
  const o = cx.ui.selObj;
  if (o) cx.run(command, { kind: o.kind === "slicer" ? "shape" : o.kind, id: o.id, ...extra });
}

export const pageLayout: Tab<SheetCx> = {
  id: "pageLayout",
  label: "Page Layout",
  groups: [
    group("themes", "Themes", [
      menu(
        "palette",
        "Themes",
        THEMES.map((n) => it(n, "pageLayout.theme", { name: n }, { raw: true })),
        { big: true },
      ),
      stack(
        menu(
          "palette",
          "Colors",
          THEMES.map((n) => it(n, "pageLayout.themeColors", { name: n }, { raw: true })),
        ),
        menu("fonts", "Fonts", [
          it("Calibri", "pageLayout.themeFonts", { major: "Calibri", minor: "Calibri" }, { raw: true }),
          it("Arial", "pageLayout.themeFonts", { major: "Arial", minor: "Arial" }, { raw: true }),
          it("Cambria - Calibri", "pageLayout.themeFonts", { major: "Cambria", minor: "Calibri" }, { raw: true }),
          it("Georgia - Verdana", "pageLayout.themeFonts", { major: "Georgia", minor: "Verdana" }, { raw: true }),
          it("Segoe UI", "pageLayout.themeFonts", { major: "Segoe UI", minor: "Segoe UI" }, { raw: true }),
        ]),
        menu(
          "wand",
          "Effects",
          THEMES.map((n) => it(n, "pageLayout.themeEffects", { name: n }, { raw: true })),
        ),
      ),
    ]),
    group(
      "setup",
      "Page Setup",
      [
        menu("margins", "Margins", margins, { big: true }),
        menu(
          "orientation",
          "Orientation",
          [it("Portrait", "pageLayout.orientation", { orientation: "portrait" }), it("Landscape", "pageLayout.orientation", { orientation: "landscape" })],
          { big: true },
        ),
        menu(
          "size",
          "Size",
          [...sizes.map((p) => it(p, "pageLayout.size", { paper: p }, { raw: true })), sep, itd("More Paper Sizes…", "pageSetup", { tab: "Page" })],
          { big: true },
        ),
        menu(
          "border",
          "Print\nArea",
          [it("Set Print Area", "pageLayout.printArea"), it("Clear Print Area", "pageLayout.printArea", { clear: true })],
          { big: true },
        ),
        menu("breaks", "Breaks", breaks, { big: true }),
        big("pageColor", "Background", dlg("sheetBackground")),
        big("tocUpdate", "Print\nTitles", dlg("printTitles")),
      ],
      { launcher: dlg("pageSetup") },
    ),
    group(
      "fit",
      "Scale to Fit",
      [
        stack(
          menu(
            "scaling",
            "Width:",
            [
              it("Automatic", "pageLayout.scaleToFit", { width: 0 }),
              ...[1, 2, 3, 4, 5].map((n) => it(`${n} page${n > 1 ? "s" : ""}`, "pageLayout.scaleToFit", { width: n }, { raw: true })),
            ],
            { tip: "Width" },
          ),
          menu(
            "scaling",
            "Height:",
            [
              it("Automatic", "pageLayout.scaleToFit", { height: 0 }),
              ...[1, 2, 3, 4, 5].map((n) => it(`${n} page${n > 1 ? "s" : ""}`, "pageLayout.scaleToFit", { height: n }, { raw: true })),
            ],
            { tip: "Height" },
          ),
          menu(
            "ratio",
            "Scale:",
            [100, 90, 80, 70, 60, 50].map((n) => it(`${n}%`, "pageLayout.scaleToFit", { scale: n }, { raw: true })),
            { tip: "Scale" },
          ),
        ),
      ],
      { launcher: dlg("pageSetup", { tab: "Page" }) },
    ),
    group(
      "sheetOptions",
      "Sheet Options",
      [
        stack(
          small("gridIc", "Gridlines", cmd("view.gridlines"), { on: (c) => c.s.view.gridlines }),
          small("hashIc", "Headings", cmd("view.headings"), { on: (c) => c.s.view.headings }),
        ),
        stack(
          check("Print Gridlines", (c) => c.s.view.printGridlines, (c, v) => c.run("pageLayout.printGridlines", { on: v })),
          check("Print Headings", (c) => c.s.view.printHeadings, (c, v) => c.run("pageLayout.printHeadings", { on: v })),
        ),
      ],
      { launcher: dlg("pageSetup", { tab: "Sheet" }) },
    ),
    group("arrange", "Arrange", [
      stack(
        small("forward", "Bring Forward", fn((c) => arrangeSel(c, "arrange.bringForward")), { enabled: (c) => !!c.ui.selObj }),
        small("backward", "Send Backward", fn((c) => arrangeSel(c, "arrange.sendBackward")), { enabled: (c) => !!c.ui.selObj }),
        small("selectionPane", "Selection Pane", fn((c) => c.ui.togglePane("selection")), { on: (c) => c.ui.pane === "selection" }),
      ),
    ]),
  ],
};
