import type { Item, Tab } from "@/pages/word/ribbon/types";
import { NA } from "@/pages/sheet/ribbon/model/insert";
import { big, cmd, dlg, fn, group, it, itd, menu, sep, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const pickAndImport = (cx: SheetCx, accept: string, command: string): void => {
  cx.ui.pickFile(accept, (f) => {
    void cx.ui.upload(f).then((path) => {
      if (path) cx.run(command, { path });
    });
  });
};

const getData: Item<SheetCx>[] = [
  { label: "From Text/CSV", act: fn((c) => pickAndImport(c, ".csv,.tsv,.txt", "data.fromTextCsv")) },
  { label: "From JSON", act: fn((c) => pickAndImport(c, ".json", "data.getData")) },
  { label: "From Table/Range", act: cmd("data.fromTableRange") },
  sep,
  { label: "From Web", enabled: () => false, act: fn(() => undefined) },
];

export const data: Tab<SheetCx> = {
  id: "data",
  label: "Data",
  groups: [
    group("get", "Get & Transform Data", [
      menu("database", "Get\nData", getData, { big: true }),
      stack(
        small("importIc", "From Text/CSV", fn((c) => pickAndImport(c, ".csv,.tsv,.txt", "data.fromTextCsv"))),
        small("globe", "From Web", fn(() => undefined), { enabled: () => false, tip: NA }),
        small("tableFmt", "From Table/Range", cmd("data.fromTableRange")),
      ),
    ]),
    group("queries", "Queries & Connections", [
      big("refresh", "Refresh\nAll", cmd("data.refreshAll")),
      small("listTree", "Queries & Connections", dlg("queries")),
    ]),
    group("types", "Data Types", [
      small("coins", "Stocks", fn(() => undefined), { enabled: () => false, tip: NA }),
      small("globe", "Geography", fn(() => undefined), { enabled: () => false, tip: NA }),
    ]),
    group(
      "sort",
      "Sort & Filter",
      [
        stack(small("azAsc", "Sort A to Z", cmd("data.sortAscending")), small("azDesc", "Sort Z to A", cmd("data.sortDescending"))),
        big("sort", "Sort", dlg("sort")),
        big("filter", "Filter", cmd("data.filter"), { on: (c) => c.s.ctx.autofilter }),
        stack(small("eraser", "Clear", cmd("data.clearFilter")), small("refresh", "Reapply", cmd("data.reapply")), small("listFilter", "Advanced", dlg("advancedFilter"))),
      ],
      { launcher: dlg("sort") },
    ),
    group("tools", "Data Tools", [
      stack(small("columns", "Text to Columns", dlg("textToColumns")), small("wand", "Flash Fill", cmd("data.flashFill")), small("trash", "Remove Duplicates", dlg("removeDuplicates"))),
      stack(small("check", "Data Validation", dlg("dataValidation")), small("target", "Circle Invalid Data", cmd("data.circleInvalid")), small("layers", "Consolidate", dlg("consolidate"))),
      small("network", "Relationships", fn(() => undefined), { enabled: () => false, tip: NA }),
    ]),
    group("forecast", "Forecast", [
      menu(
        "variableIc",
        "What-If\nAnalysis",
        [itd("Scenario Manager…", "scenarioManager"), itd("Goal Seek…", "goalSeek"), itd("Data Table…", "dataTable")],
        { big: true },
      ),
      big("trend", "Forecast\nSheet", dlg("forecastSheet")),
    ]),
    group("outline", "Outline", [
      menu("group", "Group", [it("Group Rows", "data.group", { by: "rows" }), it("Group Columns", "data.group", { by: "cols" })], { big: true }),
      menu("ungroup", "Ungroup", [it("Ungroup Rows", "data.ungroup", { by: "rows" }), it("Ungroup Columns", "data.ungroup", { by: "cols" })], { big: true }),
      big("listTree", "Subtotal", dlg("subtotal")),
      stack(small("plus", "Show Detail", cmd("data.showDetail")), small("minus", "Hide Detail", cmd("data.hideDetail"))),
    ]),
    group("analysis", "Analysis", [
      big("sparklesIc", "Analyze\nData", fn(() => undefined), { enabled: () => false, tip: NA }),
      big("target", "Solver", dlg("solver")),
      big("chart", "Data\nAnalysis", dlg("analysisToolPak")),
    ]),
  ],
};
