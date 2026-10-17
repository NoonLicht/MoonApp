import { colorMenu } from "@/pages/word/ribbon/colors";
import type { Tab } from "@/pages/word/ribbon/types";
import { big, cmd, dlg, group, it, menu, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

const inkWidths = [1, 2, 3, 4, 6, 8];

export const draw: Tab<SheetCx> = {
  id: "draw",
  label: "Draw",
  groups: [
    group("tools", "Tools", [
      big("select", "Select\nObjects", cmd("draw.lasso"), { on: (c) => c.s.draw.tool === "" }),
      big("pen", "Pen", cmd("draw.pen", { on: true }), { on: (c) => c.s.draw.tool === "pen" }),
      big("eraser", "Eraser", cmd("draw.eraser", { on: true }), { on: (c) => c.s.draw.tool === "eraser" }),
      stack(
        menu("fontColor", "Color", colorMenu<SheetCx>("draw.pen", { extra: { on: true }, memo: "ink" }), {
          swatch: (c) => c.s.draw.color || "#000000",
        }),
        menu(
          "lineSpacing",
          "Thickness",
          inkWidths.map((w) => it(`${w} pt`, "draw.pen", { on: true, width: w }, { raw: true, check: (c) => c.s.draw.width === w })),
        ),
      ),
    ]),
    group("convert", "Convert", [big("shapesIc", "Ink to\nShape", cmd("draw.inkToShape"))]),
  ],
};

export const automate: Tab<SheetCx> = {
  id: "automate",
  label: "Automate",
  groups: [
    group("scripts", "Scripting Tools", [
      big("plus", "New\nScript", dlg("newScript")),
      big("scroll", "All\nScripts", dlg("scripts")),
      big("record", "Record\nActions", cmd("automate.recordActions"), { on: (c) => c.s.recording }),
      small("stopIc", "Stop Recording", dlg("stopRecording"), { enabled: (c) => c.s.recording }),
    ]),
  ],
};

export const help: Tab<SheetCx> = {
  id: "help",
  label: "Help",
  groups: [
    group("help", "Help", [
      big("help", "Help", dlg("about")),
      big("keyboard", "Keyboard\nShortcuts", dlg("shortcuts")),
      big("commands", "Command\nSearch", dlg("commandSearch")),
    ]),
    group("info", "About", [
      stack(small("info", "About GridCraft Engine", dlg("about")), small("history", "Command Journal", dlg("journal"))),
    ]),
  ],
};

