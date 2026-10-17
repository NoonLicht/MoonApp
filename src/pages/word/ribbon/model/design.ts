import { colorMenu } from "@/pages/word/ribbon/colors";
import {
  big,
  cmd,
  dlg,
  group,
  it,
  itd,
  menu,
  sep,
  small,
  stack,
} from "@/pages/word/ribbon/model/h";
import type { Tab } from "@/pages/word/ribbon/types";

const THEMES: [string, string, string][] = [
  ["Craft", "Aptos Display", "Aptos"],
  ["Studio", "Georgia", "Georgia"],
  ["Gallery", "Helvetica Neue", "Helvetica Neue"],
  ["Atelier", "Palatino", "Palatino"],
  ["Darkroom", "Futura", "Avenir Next"],
  ["Sketchbook", "Gill Sans", "Gill Sans"],
];

const STYLE_SETS: [string, string][] = [
  ["Default", "default"],
  ["Basic", "basic"],
  ["Lines", "lines"],
  ["Shaded", "shaded"],
  ["Casual", "casual"],
  ["Centered", "centered"],
  ["Minimalist", "minimalist"],
  ["Title", "title"],
];

export const design: Tab = {
  id: "Design",
  label: "Design",
  groups: [
    group("themes", "Themes", [
      menu(
        "themes",
        "Themes",
        THEMES.map(([n]) =>
          it(
            n,
            "design.theme",
            { name: n },
            { raw: true, check: (cx) => cx.s.settings.themeName === n },
          ),
        ),
        { big: true },
      ),
    ]),
    group("docfmt", "Document Formatting", [
      menu(
        "design",
        "Style Set",
        STYLE_SETS.map(([l, v]) => it(l, "design.styleSet", { name: v })),
        { big: true },
      ),
      stack(
        menu(
          "colors",
          "Colors",
          THEMES.map(([n]) => it(n, "design.themeColors", { name: n }, { raw: true })),
        ),
        menu(
          "fonts",
          "Fonts",
          THEMES.map(([n, h, b]) => ({
            label: `${n}: ${h} / ${b}`,
            raw: true,
            act: cmd("design.themeFonts", { heading: h, body: b }),
          })),
        ),
        menu("paraSpacing", "Paragraph Spacing", [
          it("Default", "design.paragraphSpacing", { value: "default" }),
          it("No Paragraph Space", "design.paragraphSpacing", { value: "none" }),
          it("Compact", "design.paragraphSpacing", { value: "compact" }),
          it("Tight", "design.paragraphSpacing", { value: "tight" }),
          it("Open", "design.paragraphSpacing", { value: "open" }),
          it("Relaxed", "design.paragraphSpacing", { value: "relaxed" }),
          it("Double", "design.paragraphSpacing", { value: "double" }),
        ]),
      ),
      stack(
        small("effects", "Effects", cmd("design.effects")),
        small("check", "Set as Default", cmd("design.setDefault")),
      ),
    ]),
    group("background", "Page Background", [
      menu(
        "watermark",
        "Watermark",
        [
          ...["DRAFT", "CONFIDENTIAL", "DO NOT COPY", "SAMPLE", "ASAP", "URGENT"].map((w) =>
            it(w, "design.watermark", { text: w }, { raw: true }),
          ),
          sep,
          itd("Custom Watermark…", "watermark"),
          it("Remove Watermark", "design.watermark", { remove: true }),
        ],
        { big: true },
      ),
      menu(
        "pageColor",
        "Page\nColor",
        [it("No Color", "design.pageColor", { color: null }), ...colorMenu("design.pageColor")],
        {
          big: true,
          tip: "Page Color",
        },
      ),
      big("pageBorders", "Page\nBorders", dlg("pageBorders")),
    ]),
  ],
};
