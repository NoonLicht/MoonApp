import { createElement } from "react";
import { colorMenu, lastColor } from "@/pages/word/ribbon/colors";
import { HighlightGrid, highlightHex } from "@/pages/word/ribbon/pickers";
import {
  big,
  cmd,
  custom,
  dlg,
  fn,
  group,
  icon,
  it,
  itd,
  menu,
  row,
  sep,
  small,
  stack,
  head,
} from "@/pages/word/ribbon/model/h";
import type { Item, Tab } from "@/pages/word/ribbon/types";

let lastHighlight = "yellow";

const underlineItems: Item[] = [
  ["Single", "single"],
  ["Double", "double"],
  ["Thick", "thick"],
  ["Dotted", "dotted"],
  ["Dashed", "dash"],
  ["Dot-dash", "dotDash"],
  ["Wave", "wave"],
  ["Words only", "words"],
].map(([l, v]) => it(l, "format.underline", { style: v, value: true }));

const EFFECT_STYLES: [string, string][] = [
  ["Solid", "solid"],
  ["Outlined", "outlined"],
  ["Hollow", "hollow"],
  ["Gradient", "gradient"],
  ["Shadowed", "shadowed"],
  ["Glowing", "glowing"],
  ["Reflected", "reflected"],
  ["Sunset", "sunset"],
];

const bulletItems = (): Item[] => [
  head("Bullet Library"),
  ...["•", "○", "▪", "◆", "➢", "✓", "–"].map((c) => ({
    label: c,
    raw: true,
    act: cmd("para.bullets", { kind: c }),
  })),
  sep,
  it("None", "para.bullets", { off: true }),
  itd("Define New Bullet…", "defineBullet"),
];

const lineSpacingItems: Item[] = [
  ...[1, 1.15, 1.5, 2, 2.5, 3].map((v) => ({
    label: String(v),
    raw: true,
    act: cmd("para.lineSpacing", { value: v }),
  })),
  sep,
  it("Add Space Before Paragraph", "para.addSpaceBefore"),
  it("Remove Space After Paragraph", "para.removeSpaceAfter"),
  itd("Line Spacing Options…", "paragraph"),
];

const borderItems: Item[] = [
  ["Bottom Border", "bottom"],
  ["Top Border", "top"],
  ["Left Border", "left"],
  ["Right Border", "right"],
  ["No Border", "none"],
  ["All Borders", "all"],
  ["Outside Borders", "outside"],
  ["Inside Borders", "inside"],
].map(([l, k]) => it(l, "para.borders", { kind: k }));

export const home: Tab = {
  id: "Home",
  label: "Home",
  groups: [
    group(
      "clipboard",
      "Clipboard",
      [
        menu(
          "paste",
          "Paste",
          [
            { label: "Paste", act: fn((cx) => cx.ui.paste()) },
            { label: "Keep Text Only", act: fn((cx) => cx.ui.paste("text")) },
            { label: "Merge Formatting", act: fn((cx) => cx.ui.paste("merge")) },
            itd("Paste Special…", "pasteSpecial"),
          ],
          { big: true, split: fn((cx) => cx.ui.paste()) },
        ),
        stack(
          small(
            "cut",
            "Cut",
            fn((cx) => cx.ui.copy(true)),
          ),
          small(
            "copy",
            "Copy",
            fn((cx) => cx.ui.copy()),
          ),
          small("painter", "Format Painter", cmd("edit.formatPainter"), {
            on: (cx) => cx.s.ctx.painter,
          }),
        ),
      ],
      { launcher: fn((cx) => cx.ui.togglePane("clipboard")) },
    ),
    group(
      "font",
      "Font",
      [
        stack(
          row(
            custom("fontName"),
            custom("fontSize"),
            icon("grow", "Increase Font Size", cmd("format.growFont")),
            icon("shrink", "Decrease Font Size", cmd("format.shrinkFont")),
            menu(
              "case",
              undefined,
              [
                it("Sentence case.", "format.changeCase", { mode: "sentence" }),
                it("lowercase", "format.changeCase", { mode: "lower" }),
                it("UPPERCASE", "format.changeCase", { mode: "upper" }),
                it("Capitalize Each Word", "format.changeCase", { mode: "title" }),
                it("tOGGLE cASE", "format.changeCase", { mode: "toggle" }),
              ],
              { tip: "Change Case" },
            ),
            icon("clear", "Clear All Formatting", cmd("format.clear")),
            icon("phonetic", "Phonetic Guide", dlg("phonetic")),
          ),
          row(
            icon("bold", "Bold", cmd("format.bold"), { on: (cx) => !!cx.s.format.bold }),
            icon("italic", "Italic", cmd("format.italic"), { on: (cx) => !!cx.s.format.italic }),
            menu("underline", undefined, underlineItems, {
              tip: "Underline",
              split: cmd("format.underline"),
              on: (cx) => !!cx.s.format.underline,
            }),
            icon("strike", "Strikethrough", cmd("format.strikethrough"), {
              on: (cx) => !!cx.s.format.strike,
            }),
            icon("sub", "Subscript", cmd("format.subscript"), {
              on: (cx) => !!cx.s.format.subscript,
            }),
            icon("sup", "Superscript", cmd("format.superscript"), {
              on: (cx) => !!cx.s.format.superscript,
            }),
            icon("border", "Character Border", cmd("format.border"), {
              on: (cx) => !!cx.s.format.border,
            }),
            icon("enclose", "Enclose Characters", dlg("enclose")),
            menu(
              "effects",
              undefined,
              [
                ...EFFECT_STYLES.map(([l, v]) => it(l, "format.textEffects", { style: v })),
                it("No Effects", "format.textEffects", { clear: true }),
                sep,
                it("Outline", "format.outline"),
                it("Shadow", "format.shadow"),
                it("Small Caps", "format.smallCaps"),
                it("All Caps", "format.allCaps"),
                it("Double Strikethrough", "format.doubleStrikethrough"),
                it("Hidden", "format.hidden"),
              ],
              { tip: "Text Effects and Typography" },
            ),
            menu(
              "highlight",
              undefined,
              [
                {
                  render: (cx, close) =>
                    createElement(HighlightGrid, {
                      cx,
                      close,
                      onPick: (n: string) => (lastHighlight = n),
                    }),
                },
                it("No Color", "format.highlight", { color: "none" }),
              ],
              {
                tip: "Text Highlight Color",
                split: { fn: (cx) => cx.run("format.highlight", { color: lastHighlight }) },
                swatch: (cx) =>
                  cx.s.format.highlight && cx.s.format.highlight !== "none"
                    ? `#${highlightHex(cx.s.format.highlight)}`
                    : `#${highlightHex(lastHighlight)}`,
              },
            ),
            menu(
              "fontColor",
              undefined,
              [
                it("Automatic", "format.color", { color: "auto" }),
                ...colorMenu("format.color", { memo: "font" }),
              ],
              {
                tip: "Font Color",
                split: {
                  fn: (cx) => cx.run("format.color", { color: lastColor("font", "FF0000") }),
                },
                swatch: () => `#${lastColor("font", "FF0000")}`,
              },
            ),
          ),
        ),
      ],
      { launcher: dlg("font") },
    ),
    group(
      "paragraph",
      "Paragraph",
      [
        stack(
          row(
            menu("bullets", undefined, bulletItems(), {
              tip: "Bullets",
              split: cmd("para.bullets"),
              on: (cx) => !!cx.s.paraResolved?.lists.bullets,
            }),
            menu(
              "numbering",
              undefined,
              [
                ...(
                  [
                    ["1. 2. 3.", "numbered"],
                    ["1) 2) 3)", "numberedParen"],
                    ["I. II. III.", "outline"],
                    ["A. B. C.", "upperLetter"],
                    ["a) b) c)", "lowerLetter"],
                    ["i. ii. iii.", "lowerRoman"],
                  ] as const
                ).map(([l, k]) => ({
                  label: l,
                  raw: true,
                  act: cmd("para.numbering", { kind: k }),
                })),
                sep,
                it("Restart at 1", "para.restartNumbering"),
                itd("Set Numbering Value…", "setNumberingValue"),
                itd("Define New Number Format…", "defineNumber"),
                it("None", "para.numbering", { off: true }),
              ],
              {
                tip: "Numbering",
                split: cmd("para.numbering"),
                on: (cx) => !!cx.s.paraResolved?.lists.numbering,
              },
            ),
            menu(
              "multilevel",
              undefined,
              [
                {
                  label: "1. 1.1. 1.1.1.",
                  raw: true,
                  act: cmd("para.multilevel", { kind: "legal" }),
                },
                {
                  label: "I. A. 1. a.",
                  raw: true,
                  act: cmd("para.multilevel", { kind: "outline" }),
                },
                sep,
                itd("Define New Multilevel List…", "defineMultilevel"),
                sep,
                ...[0, 1, 2, 3, 4].map((l) =>
                  it(`Change to Level ${l + 1}`, "para.listLevel", { level: l }, { raw: false }),
                ),
              ],
              {
                tip: "Multilevel List",
                split: cmd("para.multilevel"),
                on: (cx) => !!cx.s.paraResolved?.lists.multilevel,
              },
            ),
            icon("outdent", "Decrease Indent", cmd("para.outdent")),
            icon("indent", "Increase Indent", cmd("para.indent")),
            icon("sort", "Sort", dlg("sortParagraphs")),
            icon("pilcrow", "Show/Hide ¶", cmd("view.marks"), { on: (cx) => cx.s.view.marks }),
          ),
          row(
            icon("alignLeft", "Align Left", cmd("para.alignLeft"), {
              on: (cx) => cx.s.paraResolved?.visualAlign === "left",
            }),
            icon("alignCenter", "Center", cmd("para.alignCenter"), {
              on: (cx) => cx.s.paraResolved?.visualAlign === "center",
            }),
            icon("alignRight", "Align Right", cmd("para.alignRight"), {
              on: (cx) => cx.s.paraResolved?.visualAlign === "right",
            }),
            icon("justify", "Justify", cmd("para.justify"), {
              on: (cx) => cx.s.paraResolved?.visualAlign === "justify",
            }),
            icon("ltr", "Left-to-Right Text Direction", cmd("para.ltr"), {
              on: (cx) => !cx.s.paraResolved?.bidi,
            }),
            icon("rtl", "Right-to-Left Text Direction", cmd("para.rtl"), {
              on: (cx) => !!cx.s.paraResolved?.bidi,
            }),
            menu("lineSpacing", undefined, lineSpacingItems, { tip: "Line and Paragraph Spacing" }),
            menu(
              "shading",
              undefined,
              [
                it("No Color", "para.shading", { color: null }),
                ...colorMenu("para.shading", { memo: "shade" }),
              ],
              {
                tip: "Shading",
                split: {
                  fn: (cx) => cx.run("para.shading", { color: lastColor("shade", "FFFF00") }),
                },
                swatch: () => `#${lastColor("shade", "FFFF00")}`,
              },
            ),
            menu(
              "borders",
              undefined,
              [
                ...borderItems,
                sep,
                it("Horizontal Line", "insert.horizontalLine"),
                itd("Borders and Shading…", "paragraphBorders"),
              ],
              {
                tip: "Borders",
                split: cmd("para.borders", { kind: "bottom" }),
              },
            ),
          ),
        ),
      ],
      { launcher: dlg("paragraph") },
    ),
    group("styles", "Styles", [custom("styleGallery")], {
      launcher: fn((cx) => cx.ui.togglePane("styles")),
    }),
    group("editing", "Editing", [
      stack(
        menu(
          "find",
          "Find",
          [it("Find", "edit.find"), itd("Advanced Find…", "find"), itd("Go To…", "goto")],
          { split: fn((cx) => cx.ui.togglePane("find", true)) },
        ),
        small("replace", "Replace", dlg("replace")),
        menu("select", "Select", [
          it("Select All", "select.all"),
          it("Select Paragraph", "select.paragraph"),
          it("Select Sentence", "select.sentence"),
          it("Select Text with Similar Formatting", "select.similar"),
          it("Select Objects", "select.objects"),
        ]),
      ),
    ]),
    group("editor", "Editor", [
      big(
        "editor",
        "Editor",
        fn((cx) => cx.ui.togglePane("proofing", true)),
      ),
    ]),
  ],
};
