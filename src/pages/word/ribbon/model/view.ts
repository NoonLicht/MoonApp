import {
  big,
  check,
  cmd,
  dlg,
  fn,
  group,
  it,
  itd,
  menu,
  small,
  stack,
} from "@/pages/word/ribbon/model/h";
import type { Cx, Tab } from "@/pages/word/ribbon/types";

const mode = (cx: Cx): string =>
  cx.s.view.readMode || cx.s.view.mode === "read" ? "read" : cx.s.view.mode;

export const view: Tab = {
  id: "View",
  label: "View",
  groups: [
    group("views", "Views", [
      big("readMode", "Read\nMode", cmd("view.readMode"), { on: (cx) => mode(cx) === "read" }),
      big("printLayout", "Print\nLayout", cmd("view.printLayout"), {
        on: (cx) => mode(cx) === "print",
      }),
      big("webLayout", "Web\nLayout", cmd("view.webLayout"), { on: (cx) => mode(cx) === "web" }),
      stack(
        small("outline", "Outline", cmd("view.outline"), { on: (cx) => mode(cx) === "outline" }),
        small("draft", "Draft", cmd("view.draft"), { on: (cx) => mode(cx) === "draft" }),
      ),
    ]),
    group("immersive", "Immersive", [
      big("focus", "Focus", cmd("view.focus"), { on: (cx) => cx.s.view.focusMode }),
      big(
        "immersive",
        "Immersive\nReader",
        fn(() => window.dispatchEvent(new CustomEvent("wd-read-aloud"))),
      ),
    ]),
    group("movement", "Page Movement", [
      big("vertical", "Vertical", cmd("view.vertical")),
      big("sideToSide", "Side\nto Side", cmd("view.sideToSide")),
    ]),
    group("show", "Show", [
      stack(
        check(
          "Ruler",
          (cx) => cx.s.view.ruler,
          (cx, v) => cx.run("view.ruler", { value: v }),
        ),
        check(
          "Gridlines",
          (cx) => cx.s.view.gridlines,
          (cx, v) => cx.run("view.gridlines", { value: v }),
        ),
        check(
          "Navigation Pane",
          (cx) => cx.ui.pane === "navigation",
          (cx, v) => cx.ui.togglePane("navigation", v),
        ),
      ),
      stack(
        check(
          "Hide White Space",
          (cx) => cx.s.view.hideWhiteSpace,
          (cx, v) => cx.run("view.hideWhiteSpace", { value: v }),
        ),
        check(
          "Field Codes",
          (cx) => cx.s.view.fieldCodes,
          (cx, v) => cx.run("view.fieldCodes", { value: v }),
        ),
      ),
    ]),
    group("zoom", "Zoom", [
      big("zoom", "Zoom", dlg("zoom")),
      big(
        "zoom",
        "100%",
        fn((cx) => cx.ui.setZoom(1)),
      ),
      stack(
        small(
          "zoomIn",
          "Zoom In",
          fn((cx) => cx.ui.setZoom(Math.min(5, +(cx.ui.zoom + 0.1).toFixed(2)))),
        ),
        small(
          "zoomOut",
          "Zoom Out",
          fn((cx) => cx.ui.setZoom(Math.max(0.1, +(cx.ui.zoom - 0.1).toFixed(2)))),
        ),
      ),
      stack(
        small("onePage", "One Page", cmd("view.onePage")),
        small("multiPage", "Multiple Pages", cmd("view.multiplePages"), {
          on: (cx) => cx.s.view.multiPage,
        }),
        small("pageWidth", "Page Width", cmd("view.pageWidth")),
      ),
    ]),
    group("dark", "Dark Mode", [
      big("dark", "Switch\nModes", cmd("view.darkMode"), { on: (cx) => cx.s.view.darkMode }),
    ]),
    group("window", "Window", [
      big("split", "Split", cmd("view.split")),
      big("fullScreen", "Full\nScreen", cmd("view.fullScreen"), {
        on: (cx) => cx.s.view.fullScreen,
      }),
    ]),
    group("macros", "Macros", [
      menu(
        "macros",
        "Macros",
        [itd("View Macros…", "macros"), it("Record Macro…", "tools.recordMacro")],
        { big: true },
      ),
    ]),
    group("templates", "Templates", [big("template", "Templates", dlg("templates"))]),
  ],
};
