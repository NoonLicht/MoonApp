import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FunctionSquare,
  Minus,
  MessageSquare,
  Plus,
  Redo2,
  Save,
  Search,
  Share2,
  Undo2,
  X,
} from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { ContextPopup, MenuPopup } from "@/pages/word/ribbon/Menu";
import type { Item } from "@/pages/word/ribbon/types";
import type { SheetCx } from "@/pages/sheet/types";
import type { EditState } from "@/pages/sheet/edit";
import { FormulaHints } from "@/pages/sheet/grid/CellEditor";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import type { SheetCommand } from "@/api/apiSheet";

/** Строка заголовка книги: быстрый доступ, название, поиск команд, примечания. */
export function TitleBar({ cx, name, commands }: { cx: SheetCx; name: string; commands: SheetCommand[] }) {
  const s = cx.s;
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const rect = box.current?.getBoundingClientRect();
  const ql = q.trim().toLowerCase();
  const found = ql
    ? commands
        .filter(
          (c) =>
            c.label.toLowerCase().includes(ql) ||
            cx.tw(c.label).toLowerCase().includes(ql) ||
            c.id.toLowerCase().includes(ql),
        )
        .slice(0, 12)
    : [];
  return (
    <div className="wd-titlebar">
      <div className="wd-qat">
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Save")}
          aria-label={cx.tw("Save")}
          onClick={() => cx.ui.exportAs("xlsx")}
        >
          <Save size={15} />
        </button>
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Undo")}
          aria-label={cx.tw("Undo")}
          disabled={!s.canUndo}
          onClick={() => cx.run("edit.undo")}
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="wd-ctl wd-small"
          title={cx.tw("Redo")}
          aria-label={cx.tw("Redo")}
          disabled={!s.canRedo}
          onClick={() => cx.run("edit.redo")}
        >
          <Redo2 size={15} />
        </button>
      </div>
      <span className="wd-doc-title">
        {name}
        {s.doc.dirty ? <i> •</i> : null}
      </span>
      <div className="wd-search" ref={box}>
        <Search size={13} />
        <input
          type="text"
          value={q}
          placeholder={cx.tw("Search")}
          aria-label={cx.tw("Search commands")}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              e.currentTarget.blur();
            }
            if (e.key === "Enter" && found[0]) {
              cx.run(found[0].id);
              setQ("");
              e.currentTarget.blur();
            }
          }}
        />
        {focus && q && found.length && rect
          ? createPortal(
              <div
                className="wd-menu wd-search-list"
                style={{ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 340) }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {found.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="wd-m-item"
                    disabled={!c.enabled}
                    onClick={() => {
                      cx.run(c.id);
                      setQ("");
                    }}
                  >
                    <span className="wd-m-label">{cx.tw(c.label)}</span>
                    <span className="wd-m-hint">{c.menu.map((m) => cx.tw(m)).join(" › ")}</span>
                  </button>
                ))}
              </div>,
              getOverlayRoot() ?? document.body,
            )
          : null}
      </div>
      <button
        type="button"
        className="wd-title-btn accent"
        onClick={() => cx.ui.backstage("export")}
      >
        <Share2 size={13} />
        {cx.tw("Share")}
      </button>
      <button
        type="button"
        className={`wd-title-btn${cx.ui.pane === "comments" ? " accent" : ""}`}
        onClick={() => cx.ui.togglePane("comments")}
      >
        <MessageSquare size={13} />
        {cx.tw("Comments")}
      </button>
    </div>
  );
}

/** Строка формул: поле имени, кнопки отмены/ввода/мастера функций и сама формула. */
export function FormulaBar({
  cx,
  edit,
  docs,
  list,
}: {
  cx: SheetCx;
  edit: EditState | null;
  docs: SheetDocs;
  list: boolean;
}) {
  const s = cx.s;
  const [name, setName] = useState<string | null>(null);
  const [names, setNames] = useState<DOMRect | null>(null);
  const [tall, setTall] = useState(false);
  const [caret, setCaret] = useState(0);
  const [hint, setHint] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const bar = edit?.origin === "bar";
  const text = edit ? edit.text : s.bar.text;

  useEffect(() => {
    if (bar) {
      const el = input.current;
      if (!el) return;
      el.focus();
      const pos = edit?.caret ?? el.value.length;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    }
    // фокус ставим при переходе правки в строку формул
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar, edit?.caret]);

  useEffect(() => {
    if (bar) cx.ui.edit.caret.current = caret;
  }, [bar, caret, cx.ui.edit.caret]);

  const goto = (ref: string): void => {
    if (!ref.trim()) return;
    void cx.run("edit.goTo", { reference: ref.trim() });
    cx.ui.focusGrid();
  };
  const nameItems: Item<SheetCx>[] = s.names.map((n) => ({
    label: n.name,
    raw: true,
    act: { fn: (c: SheetCx) => c.run("edit.goTo", { reference: n.name }) },
  }));
  if (!nameItems.length) nameItems.push({ label: "(no names defined)", enabled: () => false });
  nameItems.push({ sep: true }, { label: "Name Manager…", act: { fn: (c: SheetCx) => c.dialog("nameManager") } });

  if (!s.view.formulaBar) return null;
  return (
    <div className={`sh-fbar${tall ? " tall" : ""}`}>
      <div className="sh-namebox">
        <input
          value={name ?? s.nameBox}
          aria-label={cx.tw("Name Box")}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setName(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              goto(name ?? s.nameBox);
              setName(null);
            } else if (e.key === "Escape") {
              setName(null);
              cx.ui.focusGrid();
            }
          }}
        />
        <button
          type="button"
          aria-label={cx.tw("Names")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setNames(names ? null : e.currentTarget.parentElement!.getBoundingClientRect())}
        >
          <ChevronDown size={12} />
        </button>
        {names ? (
          <MenuPopup items={nameItems} cx={cx} anchor={names} onClose={() => setNames(null)} />
        ) : null}
      </div>
      <div className="sh-fbtns">
        <button
          type="button"
          disabled={!edit}
          aria-label={cx.tw("Cancel")}
          title={cx.tw("Cancel")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => cx.ui.edit.cancel()}
        >
          <X size={14} />
        </button>
        <button
          type="button"
          disabled={!edit}
          aria-label={cx.tw("Enter")}
          title={cx.tw("Enter")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void cx.ui.edit.commit("none")}
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          aria-label={cx.tw("Insert Function")}
          title={cx.tw("Insert Function")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => cx.dialog("insertFunction")}
        >
          <FunctionSquare size={14} />
        </button>
      </div>
      <textarea
        ref={input}
        className="sh-fx"
        rows={tall ? 4 : 1}
        spellCheck={false}
        value={text}
        placeholder=""
        aria-label={cx.tw("Formula Bar")}
        onFocus={() => {
          if (!edit) cx.ui.edit.begin(null, "bar", "edit");
        }}
        onChange={(e) => {
          if (!edit) cx.ui.edit.begin(e.target.value, "bar", "edit");
          else cx.ui.edit.set(e.target.value, e.target.selectionStart);
          setCaret(e.target.selectionStart);
          setHint(0);
        }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.altKey) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) void cx.ui.edit.commit("none", { fill: !e.shiftKey, array: e.shiftKey });
            else void cx.ui.edit.commit(e.shiftKey ? "up" : "down");
          } else if (e.key === "Enter" && e.altKey) {
            const el = e.currentTarget;
            cx.ui.edit.set(`${text.slice(0, el.selectionStart)}\n${text.slice(el.selectionEnd)}`, el.selectionStart + 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cx.ui.edit.cancel();
          } else if (e.key === "Tab") {
            e.preventDefault();
            void cx.ui.edit.commit(e.shiftKey ? "left" : "right");
          }
        }}
      />
      {bar ? (
        <FormulaHints
          text={text}
          caret={caret}
          docs={docs}
          anchor={{ left: 120, top: 28 }}
          selected={hint}
          setSelected={setHint}
          onPick={(nm) => {
            const m = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(text.slice(0, caret));
            const start = caret - (m ? m[0].length : 0);
            cx.ui.edit.set(`${text.slice(0, start)}${nm}(${text.slice(caret)}`, start + nm.length + 1);
          }}
        />
      ) : null}
      <button
        type="button"
        className="sh-expand"
        aria-label={cx.tw("Expand Formula Bar")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setTall(!tall)}
      >
        {tall ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {list ? null : null}
    </div>
  );
}

/** Вкладки листов внизу окна. */
export function SheetTabs({ cx }: { cx: SheetCx }) {
  const s = cx.s;
  const [menu, setMenu] = useState<{ x: number; y: number; i: number } | null>(null);
  const [renaming, setRenaming] = useState<{ i: number; name: string } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const tabs = s.sheets.filter((t) => t.visibility === "Visible");
  const hidden = s.sheets.filter((t) => t.visibility !== "Visible");

  const items = (i: number): Item<SheetCx>[] => [
    { label: "Insert…", act: { fn: (c) => c.run("home.insertSheet", { before: i }) } },
    { label: "Delete", act: { fn: (c) => c.run("home.deleteSheet", { sheet: i }) }, enabled: () => s.sheets.length > 1 },
    { label: "Rename", act: { fn: () => setRenaming({ i, name: s.sheets[i]?.name ?? "" }) } },
    { label: "Move or Copy…", act: { fn: (c) => c.dialog("moveSheet", { sheet: i }) } },
    { sep: true },
    {
      label: "Tab Color",
      sub: [
        ...["#FF0000", "#FFC000", "#FFFF00", "#00B050", "#00B0F0", "#0070C0", "#7030A0"].map(
          (col): Item<SheetCx> => ({
            label: col,
            raw: true,
            swatch: col,
            act: { fn: (c) => c.run("sheet.tabColor", { sheet: i, color: col }) },
          }),
        ),
        { sep: true },
        { label: "No Color", act: { fn: (c) => c.run("sheet.tabColor", { sheet: i, color: "none" }) } },
      ],
    },
    { label: "Protect Sheet…", act: { fn: (c) => c.dialog("protectSheet") } },
    { sep: true },
    { label: "Hide", act: { fn: (c) => c.run("sheet.hide", { sheet: i }) }, enabled: () => tabs.length > 1 },
    { label: "Unhide…", act: { fn: (c) => c.dialog("unhideSheet") }, enabled: () => hidden.length > 0 },
  ];

  const commitRename = (): void => {
    if (renaming && renaming.name.trim() && renaming.name !== s.sheets[renaming.i]?.name)
      cx.run("sheet.rename", { sheet: renaming.i, name: renaming.name.trim() });
    setRenaming(null);
    cx.ui.focusGrid();
  };

  return (
    <div className="sh-tabs">
      <button
        type="button"
        className="sh-tabnav"
        aria-label={cx.tw("Previous Sheet")}
        onClick={() => cx.run("sheet.previous")}
      >
        <ChevronLeft size={14} />
      </button>
      <button type="button" className="sh-tabnav" aria-label={cx.tw("Next Sheet")} onClick={() => cx.run("sheet.next")}>
        <ChevronRight size={14} />
      </button>
      <div className="sh-tabstrip" ref={strip}>
        {tabs.map((t) => {
          const on = t.i === s.active;
          return (
            <div
              key={t.i}
              className={`sh-tab${on ? " on" : ""}${dragOver === t.i ? " over" : ""}`}
              style={t.color ? ({ "--tab": t.color } as React.CSSProperties) : undefined}
              draggable={!renaming}
              onDragStart={() => (dragFrom.current = t.i)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(t.i);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => {
                setDragOver(null);
                const from = dragFrom.current;
                dragFrom.current = null;
                if (from !== null && from !== t.i) cx.run("sheet.move", { sheet: from, to: t.i });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!on) cx.run("sheet.activate", { sheet: t.i });
                setMenu({ x: e.clientX, y: e.clientY, i: t.i });
              }}
              onDoubleClick={() => setRenaming({ i: t.i, name: t.name })}
              onClick={() => {
                if (!on) cx.run("sheet.activate", { sheet: t.i });
                cx.ui.focusGrid();
              }}
            >
              {renaming?.i === t.i ? (
                <input
                  autoFocus
                  value={renaming.name}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setRenaming({ i: t.i, name: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  size={Math.max(4, renaming.name.length)}
                />
              ) : (
                <span>{t.name}</span>
              )}
              {t.protected ? <i className="sh-lock">🔒</i> : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="sh-tabadd"
        title={cx.tw("Insert Sheet")}
        aria-label={cx.tw("Insert Sheet")}
        onClick={() => cx.run("home.insertSheet", {})}
      >
        <Plus size={15} />
      </button>
      {menu ? (
        <ContextPopup items={items(menu.i)} cx={cx} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const s = abs >= 1e12 || (abs > 0 && abs < 1e-6) ? n.toExponential(4) : String(Math.round(n * 1e8) / 1e8);
  const [i, f] = s.split(".");
  return /e/.test(s) ? s : `${i.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${f ? `.${f}` : ""}`;
};

/** Строка состояния: готовность, сводка по выделению, режимы просмотра и масштаб. */
export function StatusBar({ cx, editMode }: { cx: SheetCx; editMode: "enter" | "edit" | null }) {
  const s = cx.s;
  const st = s.stats;
  const mode = editMode === "enter" ? "Enter" : editMode === "edit" ? "Edit" : "Ready";
  const view = s.view.mode;
  const Z = s.view.zoom;
  return (
    <div className="wd-status">
      <span style={{ padding: "0 6px" }}>{cx.tw(mode)}</span>
      {s.recording ? <span style={{ color: "var(--amber)", padding: "0 6px" }}>● {cx.tw("Recording")}</span> : null}
      <span style={{ flex: 1 }} />
      {st.nums > 1 ? (
        <>
          <span style={{ padding: "0 8px" }}>
            {cx.tw("Average")}: {fmt(st.avg ?? 0)}
          </span>
          <span style={{ padding: "0 8px" }}>
            {cx.tw("Count")}: {st.count}
          </span>
          <span style={{ padding: "0 8px" }}>
            {cx.tw("Sum")}: {fmt(st.sum)}
          </span>
        </>
      ) : st.count > 1 ? (
        <span style={{ padding: "0 8px" }}>
          {cx.tw("Count")}: {st.count}
        </span>
      ) : null}
      <button type="button" className={view === "normal" ? "on" : ""} onClick={() => cx.run("view.normal")}>
        {cx.tw("Normal")}
      </button>
      <button type="button" className={view === "pageLayout" ? "on" : ""} onClick={() => cx.run("view.pageLayout")}>
        {cx.tw("Page Layout")}
      </button>
      <button
        type="button"
        className={view === "pageBreakPreview" ? "on" : ""}
        onClick={() => cx.run("view.pageBreakPreview")}
      >
        {cx.tw("Page Break Preview")}
      </button>
      <span className="wd-zoom">
        <button type="button" aria-label={cx.tw("Zoom Out")} onClick={() => cx.run("view.zoom", { percent: Math.max(10, Z - 10) })}>
          <Minus size={12} />
        </button>
        <input
          type="range"
          min={10}
          max={400}
          value={Math.min(400, Math.max(10, Z))}
          aria-label={cx.tw("Zoom")}
          onChange={(e) => cx.run("view.zoom", { percent: Number(e.target.value) })}
        />
        <button type="button" aria-label={cx.tw("Zoom In")} onClick={() => cx.run("view.zoom", { percent: Math.min(400, Z + 10) })}>
          <Plus size={12} />
        </button>
        <button type="button" onClick={() => cx.dialog("zoom")} style={{ minWidth: 44 }}>
          {Z}%
        </button>
      </span>
    </div>
  );
}
