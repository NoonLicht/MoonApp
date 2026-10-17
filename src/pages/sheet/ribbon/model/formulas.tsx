import { useEffect, useState } from "react";
import type { Item, Tab } from "@/pages/word/ribbon/types";
import { big, cmd, dlg, fn, group, it, itd, itf, menu, sep, small, stack, type SheetCx } from "@/pages/sheet/ribbon/h";

/** Категории библиотеки функций: подпись кнопки → категория ядра. */
const LIB: [string, string, string][] = [
  ["Financial", "coins", "Financial"],
  ["Logical", "brackets", "Logical"],
  ["Text", "case", "Text"],
  ["Date & Time", "clockIc", "Date & Time"],
  ["Lookup & Reference", "scanSearch", "Lookup"],
  ["Math & Trig", "pi", "Math"],
];

const MORE = ["Statistical", "Engineering", "Information", "Database", "Compatibility", "Web", "Cube"];

/** Меню категории: функции из ядра (грузятся при открытии меню), выбор запускает формулу. */
function functionsMenu(category: string) {
  return (): Item<SheetCx>[] => [
    {
      render: (c, close) => <FunctionList cx={c} category={category} close={close} />,
    },
    sep,
    itd("Insert Function…", "insertFunction", { category }),
  ];
}

interface Fn {
  name: string;
  category: string;
  signature: string;
  description: string;
}

function FunctionList({ cx, category, close }: { cx: SheetCx; category: string; close: () => void }) {
  const [list, setList] = useState<Fn[] | null>(null);
  useEffect(() => {
    let alive = true;
    void cx.call("formulas.functions", { category }).then((r) => alive && setList(Array.isArray(r) ? (r as Fn[]) : []));
    return () => {
      alive = false;
    };
  }, [cx, category]);
  if (!list) return <div className="wd-muted" style={{ padding: 8 }}>…</div>;
  return (
    <div style={{ maxHeight: 320, overflow: "auto", minWidth: 220 }}>
      {list.map((f) => (
        <button
          key={f.name}
          type="button"
          className="wd-m-item"
          title={`${f.signature}\n${f.description}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            cx.run("formulas.insertFunction", { name: f.name });
            close();
          }}
        >
          <span className="wd-m-label">{f.name}</span>
        </button>
      ))}
    </div>
  );
}

const calcOptions: Item<SheetCx>[] = [
  it("Automatic", "formulas.calculationOptions", { mode: "automatic" }, { check: (c) => c.s.calc.mode === "Automatic" }),
  it("Automatic Except for Data Tables", "formulas.calculationOptions", { mode: "automaticExceptTables" }, { check: (c) => c.s.calc.mode === "AutomaticExceptTables" }),
  it("Manual", "formulas.calculationOptions", { mode: "manual" }, { check: (c) => c.s.calc.mode === "Manual" }),
];

export const formulas: Tab<SheetCx> = {
  id: "formulas",
  label: "Formulas",
  groups: [
    group("library", "Function Library", [
      big("fx", "Insert\nFunction", dlg("insertFunction")),
      menu(
        "sigma",
        "AutoSum",
        [
          it("Sum", "formulas.autoSum", { function: "SUM" }),
          it("Average", "formulas.autoSum", { function: "AVERAGE" }),
          it("Count Numbers", "formulas.autoSum", { function: "COUNT" }),
          it("Max", "formulas.autoSum", { function: "MAX" }),
          it("Min", "formulas.autoSum", { function: "MIN" }),
          sep,
          itd("More Functions…", "insertFunction"),
        ],
        { big: true, split: cmd("formulas.autoSum") },
      ),
      menu("clockIc", "Recently\nUsed", () => [{ render: (c, close) => <RecentList cx={c} close={close} /> }, sep, itd("Insert Function…", "insertFunction")], { big: true }),
      ...LIB.map(([label, icon, cat]) => menu(icon as never, label.replace(" & ", " &\n"), functionsMenu(cat), { big: true })),
      menu(
        "boxes",
        "More\nFunctions",
        MORE.map((m) => ({ label: m, sub: functionsMenu(m) }) as Item<SheetCx>),
        { big: true },
      ),
    ]),
    group("names", "Defined Names", [
      big("bookmark", "Name\nManager", dlg("nameManager")),
      stack(
        small("plus", "Define Name", dlg("defineName")),
        menu("variableIc", "Use in Formula", (cx) => cx.s.names.map((n): Item<SheetCx> => itf(n.name, (c) => c.run("formulas.useInFormula", { name: n.name }), { raw: true })), {
          enabled: (c) => c.s.names.length > 0,
        }),
        small("listPlus", "Create from Selection", dlg("createNames")),
      ),
    ]),
    group("auditing", "Formula Auditing", [
      stack(
        small("target", "Trace Precedents", cmd("formulas.tracePrecedents")),
        small("target", "Trace Dependents", cmd("formulas.traceDependents")),
        small("eraser", "Remove Arrows", cmd("formulas.removeArrows")),
      ),
      stack(
        small("eyeIc", "Show Formulas", cmd("formulas.showFormulas"), { on: (c) => c.s.view.formulas }),
        small("check", "Error Checking", cmd("formulas.errorChecking")),
        small("calculator", "Evaluate Formula", dlg("evaluateFormula")),
      ),
      big("eyeIc", "Watch\nWindow", fn((c) => c.ui.togglePane("watch")), { on: (c) => c.ui.pane === "watch" }),
    ]),
    group("calc", "Calculation", [
      menu("gaugeIc", "Calculation\nOptions", calcOptions, { big: true }),
      stack(small("refresh", "Calculate Now", cmd("formulas.calculateNow")), small("refresh", "Calculate Sheet", cmd("formulas.calculateSheet"))),
    ]),
  ],
};

function RecentList({ cx, close }: { cx: SheetCx; close: () => void }) {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void cx.call("formulas.recentlyUsed", {}).then((r) => {
      if (!alive) return;
      const arr = Array.isArray(r) ? r : ((r as { functions?: unknown[] })?.functions ?? []);
      setList(arr.map((x) => (typeof x === "string" ? x : String((x as { name?: string }).name ?? ""))).filter(Boolean));
    });
    return () => {
      alive = false;
    };
  }, [cx]);
  if (!list) return <div className="wd-muted" style={{ padding: 8 }}>…</div>;
  if (!list.length) return <div className="wd-muted" style={{ padding: 8 }}>{cx.tw("No functions used yet.")}</div>;
  return (
    <div style={{ minWidth: 180 }}>
      {list.map((n) => (
        <button
          key={n}
          type="button"
          className="wd-m-item"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            cx.run("formulas.insertFunction", { name: n });
            close();
          }}
        >
          <span className="wd-m-label">{n}</span>
        </button>
      ))}
    </div>
  );
}
