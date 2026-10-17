import {
  big,
  cmd,
  dlg,
  fn,
  group,
  it,
  itd,
  menu,
  small,
  stack,
  row,
  icon,
} from "@/pages/word/ribbon/model/h";
import type { Tab } from "@/pages/word/ribbon/types";

export const mailings: Tab = {
  id: "Mailings",
  label: "Mailings",
  groups: [
    group("create", "Create", [
      big("envelope", "Envelopes", dlg("envelopes")),
      big("labels", "Labels", dlg("labels")),
    ]),
    group("start", "Start Mail Merge", [
      menu(
        "mailMerge",
        "Start Mail\nMerge",
        (
          [
            ["Letters", "letters"],
            ["E-mail Messages", "emails"],
            ["Envelopes", "envelopes"],
            ["Labels", "labels"],
            ["Directory", "directory"],
            ["Normal Word Document", "normal"],
          ] as const
        ).map(([l, k]) =>
          it(
            l,
            "mailings.start",
            { kind: k },
            {
              check: (cx) =>
                cx.s.settings.mergeKind === k || (k === "normal" && !cx.s.settings.mergeKind),
            },
          ),
        ),
        { big: true, tip: "Start Mail Merge" },
      ),
      menu(
        "recipients",
        "Select\nRecipients",
        [
          itd("Type a New List…", "newRecipientList"),
          { label: "Use an Existing List…", act: fn((cx) => cx.dialog("existingRecipients")) },
        ],
        { big: true, tip: "Select Recipients" },
      ),
      big("recipients", "Edit\nRecipient List", dlg("editRecipients")),
    ]),
    group("fields", "Write & Insert Fields", [
      big("fields", "Highlight\nMerge Fields", cmd("mailings.highlightFields")),
      big("envelope", "Address\nBlock", cmd("mailings.addressBlock")),
      big("mail", "Greeting\nLine", cmd("mailings.greetingLine")),
      big("fields", "Insert Merge\nField", dlg("insertMergeField")),
      stack(
        menu("quickParts", "Rules", [
          it("If…Then…Else…", "mailings.rules", { rule: "IF" }),
          it("Merge Record #", "mailings.rules", { rule: "MERGEREC" }),
          it("Next Record", "mailings.rules", { rule: "NEXT" }),
          it("Skip Record If…", "mailings.rules", { rule: "SKIPIF" }),
        ]),
        small("fields", "Match Fields", dlg("matchFields")),
      ),
    ]),
    group("preview", "Preview Results", [
      big("preview", "Preview\nResults", cmd("mailings.preview")),
      stack(
        row(
          icon("prev", "Previous Record", cmd("mailings.previous")),
          icon("next", "Next Record", cmd("mailings.next")),
        ),
        small("find", "Find Recipient", dlg("findRecipient")),
        small("check", "Check for Errors", cmd("mailings.checkErrors")),
      ),
    ]),
    group("finish", "Finish", [
      menu(
        "finish",
        "Finish &\nMerge",
        [
          it("Edit Individual Documents…", "mailings.finish"),
          itd("Merge to a New File…", "finishMerge"),
        ],
        { big: true },
      ),
    ]),
  ],
};
