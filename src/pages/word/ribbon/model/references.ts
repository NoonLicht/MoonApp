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

const STYLES = [
  "APA",
  "Chicago",
  "GB/T 7714",
  "GOST (name sort)",
  "GOST (title sort)",
  "Harvard (Anglia)",
  "IEEE",
  "MLA",
];

export const references: Tab = {
  id: "References",
  label: "References",
  groups: [
    group("toc", "Table of Contents", [
      menu(
        "toc",
        "Table of\nContents",
        [
          it("Automatic Table 1 (3 levels)", "references.toc", { levels: 3 }),
          it("Automatic Table 2 (2 levels)", "references.toc", {
            levels: 2,
            title: "Table of Contents",
          }),
          sep,
          itd("Custom Table of Contents…", "toc"),
          it("Remove Table of Contents", "references.removeToc"),
        ],
        { big: true, tip: "Table of Contents" },
      ),
      stack(
        menu("toc", "Add Text", [
          it("Do Not Show in TOC", "references.addText", { level: 0 }),
          it("Level 1", "references.addText", { level: 1 }),
          it("Level 2", "references.addText", { level: 2 }),
          it("Level 3", "references.addText", { level: 3 }),
        ]),
        small("update", "Update Table", cmd("references.updateToc")),
      ),
    ]),
    group(
      "footnotes",
      "Footnotes",
      [
        big("footnote", "Insert\nFootnote", cmd("references.footnote")),
        stack(
          small("endnote", "Insert Endnote", cmd("references.endnote")),
          small("next", "Next Footnote", cmd("references.nextFootnote")),
          small("scroll", "Show Notes", cmd("references.notes")),
        ),
      ],
      { launcher: dlg("noteOptions") },
    ),
    group("citations", "Citations & Bibliography", [
      big("citation", "Insert\nCitation", dlg("citation")),
      stack(
        small("sources", "Manage Sources", dlg("sources")),
        menu(
          "bibliography",
          "Style:",
          STYLES.map((s) =>
            it(
              s,
              "references.citationStyle",
              { style: s },
              { raw: true, check: (cx) => cx.s.settings.bibStyle === s },
            ),
          ),
          { tip: "Citation Style" },
        ),
        small("bibliography", "Bibliography", dlg("bibliography")),
      ),
    ]),
    group("captions", "Captions", [
      big("caption", "Insert\nCaption", dlg("caption")),
      stack(
        small("tableOfFigures", "Insert Table of Figures", dlg("tableOfFigures")),
        small("update", "Update Table", cmd("references.updateFigures")),
        small("crossRef", "Cross-reference", dlg("crossReference")),
      ),
    ]),
    group("index", "Index", [
      big("markEntry", "Mark\nEntry", dlg("markEntry")),
      stack(
        small("index", "Insert Index", dlg("insertIndex")),
        small("update", "Update Index", cmd("references.updateIndex")),
      ),
    ]),
    group("authorities", "Table of Authorities", [
      big("authorities", "Mark\nCitation", dlg("markCitation")),
      stack(
        small(
          "tableOfFigures",
          "Insert Table of Authorities",
          cmd("references.tableOfAuthorities"),
        ),
        small("update", "Update Table", cmd("references.updateAuthorities")),
      ),
    ]),
  ],
};
