import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";
import { Control } from "@/pages/word/ribbon/controls";
import { ContextPopup } from "@/pages/word/ribbon/Menu";
import { colorMenu, lastColor } from "@/pages/word/ribbon/colors";
import { cmd, custom, fn, icon, it, itd, menu, sep } from "@/pages/word/ribbon/model/h";
import type { Cx, Ctl, Item } from "@/pages/word/ribbon/types";

const EVENT = "wd-context";

/** Показать контекстное меню в точке экрана (вызывает холст по правой кнопке). */
export function openContext(_cx: Cx, x: number, y: number): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { x, y } }));
}

interface Issue {
  text: string;
  suggestions: string[];
  start: { path: number[]; off: number };
  end: { path: number[]; off: number };
}

const hasCaretIn = (cx: Cx, i: Issue): boolean => {
  const f = cx.s.selection.focus;
  return (
    !!f && f.path.join(",") === i.start.path.join(",") && f.off >= i.start.off && f.off <= i.end.off
  );
};

/** Пункты меню по контексту: орфография, буфер обмена, таблица, объект, текст. */
async function build(cx: Cx): Promise<Item[]> {
  const items: Item[] = [];
  const issues = (await cx.call("review.issues", {})) as Issue[] | undefined;
  const hit = (issues ?? []).find((i) => hasCaretIn(cx, i));
  if (hit) {
    for (const s of hit.suggestions.slice(0, 5))
      items.push({ label: s, raw: true, act: { cmd: "review.applySuggestion", p: { text: s } } });
    if (!hit.suggestions.length) items.push({ label: "(no suggestions)", enabled: () => false });
    items.push({ label: "Ignore All", act: cmd("review.ignoreAll") });
    items.push({
      label: "Add to Dictionary",
      act: cmd("review.addToDictionary", { word: hit.text }),
    });
    items.push(sep);
  }
  const has = !cx.s.selection.collapsed;
  items.push({ label: "Cut", act: fn((c) => c.ui.copy(true)), enabled: () => has, hint: "Ctrl+X" });
  items.push({ label: "Copy", act: fn((c) => c.ui.copy()), enabled: () => has, hint: "Ctrl+C" });
  items.push({
    label: "Paste",
    hint: "Ctrl+V",
    sub: [
      { label: "Paste", act: fn((c) => c.ui.paste()) },
      { label: "Keep Text Only", act: fn((c) => c.ui.paste("text")) },
      { label: "Merge Formatting", act: fn((c) => c.ui.paste("merge")) },
      itd("Paste Special…", "pasteSpecial"),
    ],
  });
  items.push(sep);
  const c = cx.s.ctx;
  if (c.table) {
    items.push({
      label: "Insert",
      sub: [
        it("Insert Above", "table.insertRowAbove"),
        it("Insert Below", "table.insertRowBelow"),
        it("Insert Left", "table.insertColumnLeft"),
        it("Insert Right", "table.insertColumnRight"),
      ],
    });
    items.push({
      label: "Delete",
      sub: [
        it("Delete Cells", "table.deleteCells"),
        it("Delete Columns", "table.deleteColumn"),
        it("Delete Rows", "table.deleteRow"),
        it("Delete Table", "table.deleteTable"),
      ],
    });
    items.push(it("Merge Cells", "table.merge"));
    items.push(itd("Split Cells", "splitCells"));
    items.push(itd("Table Properties", "tableProperties"));
    items.push(sep);
  }
  if (c.object) {
    items.push({
      label: "Wrap Text",
      sub: (
        [
          ["In Line with Text", "inline"],
          ["Square", "square"],
          ["Tight", "tight"],
          ["Top and Bottom", "topAndBottom"],
          ["Behind Text", "behindText"],
          ["In Front of Text", "inFrontOfText"],
        ] as const
      ).map(([l, v]) => it(l, "arrange.wrap", { wrap: v })),
    });
    items.push({ label: "Bring Forward", act: cmd("arrange.bringForward") });
    items.push({ label: "Send Backward", act: cmd("arrange.sendBackward") });
    items.push(itd("Crop", "crop", undefined, { enabled: () => c.object?.kind === "picture" }));
    items.push({ label: "Alt Text", act: fn((x) => x.ui.togglePane("altText", true)) });
    items.push(sep);
  }
  items.push(itd("Font Dialog", "font"));
  items.push(itd("Paragraph Settings", "paragraph"));
  items.push({ label: "Bullets", act: cmd("para.bullets") });
  items.push({ label: "Numbering", act: cmd("para.numbering") });
  items.push(sep);
  items.push(itd("Link", "link"));
  items.push(itd("New Comment", "newComment"));
  items.push({ label: "Select All", act: cmd("select.all") });
  return items;
}

const miniRows: Ctl[] = [
  custom("fontName"),
  custom("fontSize"),
  icon("grow", "Increase Font Size", cmd("format.growFont")),
  icon("shrink", "Decrease Font Size", cmd("format.shrinkFont")),
  icon("bold", "Bold", cmd("format.bold"), { on: (cx) => !!cx.s.format.bold }),
  icon("italic", "Italic", cmd("format.italic"), { on: (cx) => !!cx.s.format.italic }),
  icon("underline", "Underline", cmd("format.underline"), { on: (cx) => !!cx.s.format.underline }),
  menu(
    "fontColor",
    undefined,
    [...colorMenu("format.color", { memo: "font", auto: "Automatic" })],
    {
      tip: "Font Color",
      split: { fn: (cx) => cx.run("format.color", { color: lastColor("font", "FF0000") }) },
      swatch: () => `#${lastColor("font", "FF0000")}`,
    },
  ),
  icon("bullets", "Bullets", cmd("para.bullets")),
  icon("numbering", "Numbering", cmd("para.numbering")),
];

/** Слой контекстного меню страницы: слушает событие холста, собирает пункты и мини-панель форматирования. */
export function ContextLayer({ cx }: { cx: Cx }) {
  const [at, setAt] = useState<{ x: number; y: number; items: Item[] } | null>(null);
  const tb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: Event): void => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      void build(cx).then((items) => setAt({ x, y, items }));
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [cx]);
  // Мини-панель стоит над меню (или под ним, если сверху нет места) — по его фактическому положению.
  useLayoutEffect(() => {
    if (!at) return;
    const raf = requestAnimationFrame(() => {
      const m = document.querySelector<HTMLElement>(".wd-menu");
      const t = tb.current;
      if (!m || !t) return;
      const r = m.getBoundingClientRect();
      const h = t.offsetHeight;
      t.style.top = `${r.top - h - 4 >= 6 ? r.top - h - 4 : r.bottom + 4}px`;
      t.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - t.offsetWidth - 6))}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [at]);
  if (!at) return null;
  const close = (): void => setAt(null);
  return (
    <>
      {createPortal(
        <div
          className="wd-minitb"
          ref={tb}
          style={{ left: -9999, top: 0 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {miniRows.map((c, i) => (
            <Control key={i} c={c} cx={cx} />
          ))}
        </div>,
        getOverlayRoot() ?? document.body,
      )}
      <ContextPopup items={at.items} cx={cx} x={at.x} y={at.y} onClose={close} />
    </>
  );
}
