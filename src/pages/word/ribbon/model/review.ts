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
  sep,
} from "@/pages/word/ribbon/model/h";
import type { Cx, Item, Tab } from "@/pages/word/ribbon/types";

export const LANGUAGES: [string, string][] = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["pl-PL", "Polish"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["it-IT", "Italian"],
  ["hr-HR", "Croatian"],
  ["tr-TR", "Turkish"],
  ["ru-RU", "Russian"],
  ["cs-CZ", "Czech"],
];

const sameLang = (cur: string, tag: string): boolean =>
  cur.toLowerCase() === tag.toLowerCase() || cur.toLowerCase() === tag.slice(0, 2).toLowerCase();

const languageItems = (cx: Cx): Item[] => {
  const cur = String(cx.s.format.lang ?? "en-US");
  return [
    ...LANGUAGES.map(([tag, name]) =>
      it(name, "review.language", { lang: tag }, { check: () => sameLang(cur, tag) }),
    ),
    sep,
    it(
      "Do Not Check Spelling or Grammar",
      "review.language",
      { noProof: !cx.s.format.noProof },
      { check: () => !!cx.s.format.noProof },
    ),
    sep,
    itd("Set Proofing Language…", "language"),
  ];
};

export const review: Tab = {
  id: "Review",
  label: "Review",
  groups: [
    group("proofing", "Proofing", [
      big(
        "spelling",
        "Spelling &\nGrammar",
        fn((cx) => cx.ui.togglePane("proofing")),
      ),
      stack(
        small("thesaurus", "Thesaurus", dlg("thesaurus")),
        small("wordCount", "Word Count", dlg("wordCount")),
      ),
    ]),
    group("speech", "Speech", [
      big(
        "readAloud",
        "Read\nAloud",
        fn(() => window.dispatchEvent(new CustomEvent("wd-read-aloud"))),
      ),
    ]),
    group("accessibility", "Accessibility", [
      big(
        "accessibility",
        "Check\nAccessibility",
        fn((cx) => cx.ui.togglePane("accessibility", true)),
      ),
    ]),
    group("language", "Language", [menu("language", "Language", languageItems, { big: true })]),
    group("comments", "Comments", [
      big("comment", "New\nComment", dlg("newComment")),
      stack(
        small("deleteComment", "Delete", cmd("review.deleteComment")),
        small("prev", "Previous", cmd("review.previousComment")),
        small("next", "Next", cmd("review.nextComment")),
      ),
      big(
        "showComments",
        "Show\nComments",
        fn((cx) => cx.ui.togglePane("comments")),
        { on: (cx) => cx.ui.pane === "comments" },
      ),
    ]),
    group(
      "tracking",
      "Tracking",
      [
        big("track", "Track\nChanges", cmd("review.trackChanges"), {
          on: (cx) => cx.s.settings.trackChanges,
        }),
        stack(
          menu(
            "markup",
            "All Markup",
            [
              it(
                "All Markup",
                "review.markup",
                { value: "all" },
                { check: (cx) => cx.s.view.showMarkup },
              ),
              it(
                "No Markup",
                "review.markup",
                { value: "noMarkup" },
                { check: (cx) => !cx.s.view.showMarkup },
              ),
            ],
            { tip: "Display for Review" },
          ),
          small(
            "reviewingPane",
            "Reviewing Pane",
            fn((cx) => cx.ui.togglePane("reviewing")),
            { on: (cx) => cx.ui.pane === "reviewing" },
          ),
        ),
      ],
      { launcher: dlg("trackingOptions") },
    ),
    group("changes", "Changes", [
      menu(
        "accept",
        "Accept",
        [it("Accept This Change", "review.accept"), it("Accept All Changes", "review.acceptAll")],
        {
          big: true,
          split: cmd("review.accept"),
        },
      ),
      menu(
        "reject",
        "Reject",
        [it("Reject Change", "review.reject"), it("Reject All Changes", "review.rejectAll")],
        {
          big: true,
          split: cmd("review.reject"),
        },
      ),
      stack(
        small("prev", "Previous", cmd("review.previousChange")),
        small("next", "Next", cmd("review.nextChange")),
      ),
    ]),
    group("compare", "Compare", [big("compare", "Compare", dlg("compare"))]),
    group("protect", "Protect", [big("restrict", "Restrict\nEditing", dlg("restrict"))]),
    group("ink", "Ink", [
      big("hideInk", "Hide\nInk", cmd("review.hideInk"), { on: (cx) => cx.s.view.hideInk }),
    ]),
  ],
};
