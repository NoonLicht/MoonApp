import type { Tab } from "@/pages/word/ribbon/types";
import { big, check, cmd, dlg, group, it, menu, sep, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const frozen = (c: SheetCx): boolean => !!c.s.view.freeze;

export const view: Tab<SheetCx> = {
  id: "view",
  label: "View",
  groups: [
    group("views", "Workbook Views", [
      big("scroll", "Normal", cmd("view.normal"), { on: (c) => c.s.view.mode === "normal" }),
      big("pageBreak", "Page Break\nPreview", cmd("view.pageBreakPreview"), { on: (c) => c.s.view.mode === "pageBreakPreview" }),
      big("printLayout", "Page\nLayout", cmd("view.pageLayout"), { on: (c) => c.s.view.mode === "pageLayout" }),
      big("settings", "Custom\nViews", dlg("customViews")),
    ]),
    group("show", "Show", [
      stack(
        check("Ruler", (c) => c.s.view.ruler, (c, v) => c.run("view.ruler", { on: v })),
        check("Formula Bar", (c) => c.s.view.formulaBar, (c, v) => c.run("view.formulaBar", { on: v })),
      ),
      stack(
        check("Gridlines", (c) => c.s.view.gridlines, (c, v) => c.run("view.gridlines", { on: v })),
        check("Headings", (c) => c.s.view.headings, (c, v) => c.run("view.headings", { on: v })),
      ),
    ]),
    group("zoom", "Zoom", [
      big("zoom", "Zoom", dlg("zoom")),
      big("zoomIn", "100%", cmd("view.zoom100")),
      big("zoomIn", "Zoom to\nSelection", cmd("view.zoomToSelection")),
    ]),
    group("window", "Window", [
      big("newWindow", "New\nWindow", cmd("view.newWindow")),
      big("layoutGrid", "Arrange\nAll", cmd("view.arrangeAll")),
      menu(
        "pinIc",
        "Freeze\nPanes",
        [
          it("Freeze Panes", "view.freezePanes", undefined, { check: frozen }),
          it("Freeze Top Row", "view.freezeTopRow"),
          it("Freeze First Column", "view.freezeFirstColumn"),
          sep,
          it("Unfreeze Panes", "view.unfreezePanes", undefined, { enabled: frozen }),
        ],
        { big: true },
      ),
      stack(
        small("splitIc", "Split", cmd("view.split")),
        small("eyeOff", "Hide", cmd("view.hideWindow")),
        small("eyeIc", "Unhide", dlg("unhideWindow")),
      ),
      big("newWindow", "Switch\nWindows", dlg("switchWindows")),
    ]),
    group("macros", "Macros", [big("macros", "Macros", dlg("macros"))]),
  ],
};

