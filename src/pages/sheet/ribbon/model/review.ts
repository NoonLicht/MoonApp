import type { Tab } from "@/pages/word/ribbon/types";
import { NA } from "@/pages/sheet/ribbon/model/insert";
import { big, cmd, dlg, fn, group, it, itd, menu, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const jump = (cx: SheetCx, command: string): void => {
  void cx.call(command, {}).then((r) => {
    const t = r as { cell?: string; sheet?: string | number } | undefined;
    if (t?.cell) cx.run("edit.goTo", { reference: typeof t.sheet === "string" ? `'${t.sheet}'!${t.cell}` : t.cell });
  });
};

export const review: Tab<SheetCx> = {
  id: "review",
  label: "Review",
  groups: [
    group("proofing", "Proofing", [
      big("spelling", "Spelling", dlg("spelling")),
      big("thesaurus", "Thesaurus", dlg("thesaurus")),
      big("info", "Workbook\nStatistics", dlg("workbookStats")),
    ]),
    group("accessibility", "Accessibility", [big("accessibility", "Check\nAccessibility", dlg("accessibility"))]),
    group("insights", "Insights", [big("search", "Smart\nLookup", fn(() => undefined), { enabled: () => false, tip: NA })]),
    group("language", "Language", [big("translate", "Translate", fn(() => undefined), { enabled: () => false, tip: NA })]),
    group("comments", "Comments", [
      big("comment", "New\nComment", cmd("review.newComment", { text: "" })),
      stack(
        small("trash", "Delete", cmd("review.deleteComment"), { enabled: (c) => !!c.s.ctx.comment }),
        small("prev", "Previous Comment", fn((c) => jump(c, "review.previousComment"))),
        small("next", "Next Comment", fn((c) => jump(c, "review.nextComment"))),
      ),
      big("comments", "Show\nComments", fn((c) => c.ui.togglePane("comments")), { on: (c) => c.ui.pane === "comments" }),
    ]),
    group("notes", "Notes", [
      menu(
        "stickyNote",
        "Notes",
        [
          it("New Note", "review.newNote", { text: "" }),
          it("Show/Hide Note", "review.showNote"),
          it("Show All Notes", "review.showAllNotes"),
          it("Convert to Comments", "review.convertToComments"),
          it("Delete", "review.deleteComment"),
        ],
        { big: true },
      ),
    ]),
    group("protect", "Protect", [
      menu(
        "lock",
        "Protect\nSheet",
        [
          itd("Protect Sheet…", "protectSheet"),
          it("Unprotect Sheet", "review.unprotectSheet"),
        ],
        { big: true, split: dlg("protectSheet") },
      ),
      big("shieldCheck", "Protect\nWorkbook", dlg("protectWorkbook"), { on: (c) => c.s.protectedStructure }),
      big("lockOpen", "Allow Edit\nRanges", dlg("editRanges")),
    ]),
    group("changes", "Changes", [big("history", "Show\nChanges", fn(() => undefined), { enabled: () => false, tip: NA })]),
  ],
};
