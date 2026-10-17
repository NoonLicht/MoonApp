import type { Item } from "@/pages/word/ribbon/types";
import { ContextPopup } from "@/pages/word/ribbon/Menu";
import type { SheetCx } from "@/pages/sheet/types";
import type { Hit } from "@/pages/sheet/grid/GridView";
import { cmd, dlg, fn, it, itd, itf, sep } from "@/pages/sheet/ribbon/h";

export interface ContextState {
  x: number;
  y: number;
  hit: Hit;
}

const clip: Item<SheetCx>[] = [
  itf("Cut", (c) => c.ui.copy(true), { hint: "Ctrl+X" }),
  itf("Copy", (c) => c.ui.copy(false), { hint: "Ctrl+C" }),
  {
    label: "Paste Options",
    sub: [
      itf("Paste", (c) => c.ui.paste("all"), { hint: "Ctrl+V" }),
      itf("Values", (c) => c.ui.paste("values")),
      itf("Formulas", (c) => c.ui.paste("formulas")),
      itf("Formatting", (c) => c.ui.paste("formats")),
      itf("Transpose", (c) => c.ui.paste("all", "transpose")),
      itf("Paste Link", (c) => c.ui.paste("all", "link")),
    ],
  },
  itd("Paste Special…", "pasteSpecial"),
];

function cellItems(cx: SheetCx): Item<SheetCx>[] {
  const ctx = cx.s.ctx;
  const out: Item<SheetCx>[] = [
    ...clip,
    sep,
    itd("Insert…", "insertCells"),
    itd("Delete…", "deleteCells"),
    it("Clear Contents", "edit.clearContents"),
    sep,
    {
      label: "Filter",
      sub: [
        it("Filter", "data.filter", undefined, { check: () => ctx.autofilter }),
        it("Clear Filter", "data.clearFilter"),
        it("Reapply", "data.reapply"),
      ],
    },
    {
      label: "Sort",
      sub: [it("Sort A to Z", "data.sortAscending"), it("Sort Z to A", "data.sortDescending"), itd("Custom Sort…", "sort")],
    },
    sep,
  ];
  if (ctx.comment) out.push(it("Delete Comment", "review.deleteComment"));
  else out.push(it("New Note", "review.newNote"), it("New Comment", "review.newComment"));
  out.push(
    itd("Link…", "insertLink"),
    itd("Define Name…", "defineName"),
    sep,
    itd("Format Cells…", "formatCells"),
  );
  if (ctx.table) out.push(sep, { label: "Table", sub: [it("Convert to Range", "table.convertToRange"), itd("Resize Table…", "resizeTable")] });
  return out;
}

const rowItems: Item<SheetCx>[] = [
  ...clip,
  sep,
  it("Insert", "home.insertRows"),
  it("Delete", "home.deleteRows"),
  it("Clear Contents", "edit.clearContents"),
  sep,
  itd("Format Cells…", "formatCells"),
  itd("Row Height…", "rowHeight"),
  it("Hide", "home.hideRows"),
  it("Unhide", "home.unhideRows"),
];

const colItems: Item<SheetCx>[] = [
  ...clip,
  sep,
  it("Insert", "home.insertColumns"),
  it("Delete", "home.deleteColumns"),
  it("Clear Contents", "edit.clearContents"),
  sep,
  itd("Format Cells…", "formatCells"),
  itd("Column Width…", "columnWidth"),
  it("Hide", "home.hideColumns"),
  it("Unhide", "home.unhideColumns"),
];

/** Контекстное меню по правой кнопке: ячейки, заголовки строк и столбцов. */
export default function ContextLayer({
  cx,
  menu,
  onClose,
}: {
  cx: SheetCx;
  menu: ContextState | null;
  onClose: () => void;
}) {
  if (!menu) return null;
  const k = menu.hit.kind;
  const items = k === "rowHeader" ? rowItems : k === "colHeader" ? colItems : cellItems(cx);
  return <ContextPopup items={items} cx={cx} x={menu.x} y={menu.y} onClose={onClose} />;
}

export { cmd, dlg, fn };
