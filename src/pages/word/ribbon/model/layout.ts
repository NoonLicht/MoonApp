import {
  cmd,
  custom,
  dlg,
  fn,
  group,
  head,
  it,
  itd,
  menu,
  sep,
  small,
  stack,
} from "@/pages/word/ribbon/model/h";
import type { Cx, Group, Tab } from "@/pages/word/ribbon/types";

const PAPER = ["Letter", "Legal", "A3", "A4", "A5", "Executive", "Tabloid"];

const dirNow = (cx: Cx): string => String(cx.s.ctx.textDirection ?? "horizontal");

/** Порядок объектов на странице: общая группа для «Макета» и контекстных вкладок объектов. */
export const arrangeGroup = (id = "arrange"): Group =>
  group(id, "Arrange", [
    menu(
      "position",
      "Position",
      [
        head("In Line with Text"),
        it("In Line with Text", "arrange.wrap", { wrap: "inline" }),
        head("With Text Wrapping"),
        ...(
          [
            ["Top Left", "topLeft"],
            ["Top Center", "topCenter"],
            ["Top Right", "topRight"],
            ["Middle Left", "middleLeft"],
            ["Middle Center", "middleCenter"],
            ["Middle Right", "middleRight"],
            ["Bottom Left", "bottomLeft"],
            ["Bottom Center", "bottomCenter"],
            ["Bottom Right", "bottomRight"],
          ] as const
        ).map(([l, v]) => it(l, "arrange.position", { preset: v })),
      ],
      { big: true },
    ),
    menu(
      "wrap",
      "Wrap\nText",
      [
        ...(
          [
            ["In Line with Text", "inline"],
            ["Square", "square"],
            ["Tight", "tight"],
            ["Through", "through"],
            ["Top and Bottom", "topAndBottom"],
            ["Behind Text", "behindText"],
            ["In Front of Text", "inFrontOfText"],
          ] as const
        ).map(([l, v]) =>
          it(l, "arrange.wrap", { wrap: v }, { check: (cx) => cx.s.ctx.object?.float?.wrap === v }),
        ),
        sep,
        {
          label: "Wrap Text Sides",
          sub: (
            [
              ["Both Sides", "bothSides"],
              ["Left Only", "left"],
              ["Right Only", "right"],
              ["Largest Only", "largest"],
            ] as const
          ).map(([l, v]) => it(l, "arrange.wrapText", { side: v })),
        },
        it("Move with Text", "arrange.moveWithText", { value: true }),
      ],
      { big: true, tip: "Wrap Text" },
    ),
    stack(
      small("forward", "Bring Forward", cmd("arrange.bringForward")),
      small("backward", "Send Backward", cmd("arrange.sendBackward")),
      small(
        "selectionPane",
        "Selection Pane",
        fn((cx) => cx.ui.togglePane("selection")),
        { on: (cx) => cx.ui.pane === "selection" },
      ),
    ),
    stack(
      menu(
        "align",
        undefined,
        [
          it("Align Left", "arrange.align", { value: "left" }),
          it("Align Center", "arrange.align", { value: "center" }),
          it("Align Right", "arrange.align", { value: "right" }),
        ],
        { tip: "Align" },
      ),
      menu("group", undefined, [it("Group", "arrange.group"), it("Ungroup", "arrange.ungroup")], {
        tip: "Group",
      }),
      menu(
        "rotate",
        undefined,
        [
          it("Rotate Right 90°", "arrange.rotate", { direction: "right" }),
          it("Rotate Left 90°", "arrange.rotate", { direction: "left" }),
          it("Flip Vertical", "arrange.rotate", { direction: "flipVertical" }),
          it("Flip Horizontal", "arrange.rotate", { direction: "flipHorizontal" }),
        ],
        { tip: "Rotate" },
      ),
    ),
  ]);

export const layout: Tab = {
  id: "Layout",
  label: "Layout",
  groups: [
    group(
      "pagesetup",
      "Page Setup",
      [
        menu(
          "orientation",
          "Text\nDirection",
          [
            {
              label: "Horizontal",
              act: cmd("layout.textDirection", { value: "horizontal" }),
              check: (cx) => dirNow(cx) === "horizontal",
            },
            {
              label: "Rotate all text 90°",
              act: cmd("layout.textDirection", { value: "down" }),
              check: (cx) => dirNow(cx) === "down",
            },
            {
              label: "Rotate all text 270°",
              act: cmd("layout.textDirection", { value: "up" }),
              check: (cx) => dirNow(cx) === "up",
            },
          ],
          { big: true, tip: "Text Direction" },
        ),
        menu(
          "margins",
          "Margins",
          [
            ...(
              [
                ["Normal", "normal"],
                ["Narrow", "narrow"],
                ["Moderate", "moderate"],
                ["Wide", "wide"],
                ["Mirrored", "mirrored"],
                ["Office 2003 Default", "office2003"],
              ] as const
            ).map(([l, k]) => ({
              label: l,
              act: cmd("layout.margins", { preset: k }),
              check: (cx: Cx) => cx.s.ctx.marginsPreset === k,
            })),
            sep,
            itd("Custom Margins…", "pageSetup"),
          ],
          { big: true },
        ),
        menu(
          "orientation",
          "Orientation",
          [
            {
              label: "Portrait",
              act: cmd("layout.orientation", { value: "portrait" }),
              check: (cx) => !cx.s.ctx.section.landscape,
            },
            {
              label: "Landscape",
              act: cmd("layout.orientation", { value: "landscape" }),
              check: (cx) => cx.s.ctx.section.landscape,
            },
          ],
          { big: true },
        ),
        menu(
          "size",
          "Size",
          [
            ...PAPER.map((n) => it(n, "layout.size", { name: n }, { raw: true })),
            sep,
            itd("More Paper Sizes…", "pageSetup"),
          ],
          {
            big: true,
          },
        ),
        menu(
          "columns",
          "Columns",
          [
            {
              label: "One",
              act: cmd("layout.columns", { count: 1 }),
              check: (cx) => cx.s.ctx.columnsPreset === "one",
            },
            {
              label: "Two",
              act: cmd("layout.columns", { count: 2 }),
              check: (cx) => cx.s.ctx.columnsPreset === "two",
            },
            {
              label: "Three",
              act: cmd("layout.columns", { count: 3 }),
              check: (cx) => cx.s.ctx.columnsPreset === "three",
            },
            {
              label: "Left",
              act: cmd("layout.columns", { preset: "left" }),
              check: (cx) => cx.s.ctx.columnsPreset === "left",
            },
            {
              label: "Right",
              act: cmd("layout.columns", { preset: "right" }),
              check: (cx) => cx.s.ctx.columnsPreset === "right",
            },
            sep,
            itd("More Columns…", "columns"),
          ],
          { big: true },
        ),
        stack(
          menu("breaks", "Breaks", [
            head("Page Breaks"),
            it("Page", "layout.break", { kind: "page" }),
            it("Column", "layout.break", { kind: "column" }),
            it("Text Wrapping", "layout.break", { kind: "textWrapping" }),
            head("Section Breaks"),
            it("Next Page", "layout.break", { kind: "nextPage" }),
            it("Continuous", "layout.break", { kind: "continuous" }),
            it("Even Page", "layout.break", { kind: "evenPage" }),
            it("Odd Page", "layout.break", { kind: "oddPage" }),
          ]),
          menu("lineNumbers", "Line Numbers", [
            it("None", "layout.lineNumbers", { value: "none" }),
            it("Continuous", "layout.lineNumbers", { value: "continuous" }),
            it("Restart Each Page", "layout.lineNumbers", { value: "restartPage" }),
            it("Restart Each Section", "layout.lineNumbers", { value: "restartSection" }),
            sep,
            itd("Line Numbering Options…", "lineNumbers"),
          ]),
          menu("hyphenation", "Hyphenation", [
            {
              label: "None",
              act: cmd("layout.hyphenation", { value: false }),
              check: (cx) => !cx.s.settings.autoHyphenation,
            },
            {
              label: "Automatic",
              act: cmd("layout.hyphenation", { value: true }),
              check: (cx) => cx.s.settings.autoHyphenation,
            },
            sep,
            itd("Hyphenation Options…", "hyphenation"),
          ]),
        ),
      ],
      { launcher: dlg("pageSetup") },
    ),
    group("paragraph", "Paragraph", [custom("paraFields")], { launcher: dlg("paragraph") }),
    arrangeGroup(),
  ],
};
