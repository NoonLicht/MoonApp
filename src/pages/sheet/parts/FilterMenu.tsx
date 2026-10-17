import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";
import { Btn } from "@/components/ui";
import type { SheetCx } from "@/pages/sheet/types";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import { colName } from "@/pages/sheet/grid/geometry";

interface Info {
  range: { a1: string };
  column: number;
  offset: number;
  values: { text: string; count: number; selected: boolean }[];
  blanks: { count: number; selected: boolean };
  active: boolean;
  custom: boolean;
}

/** Выпадающее меню автофильтра: сортировка, очистка, поиск и список значений столбца. */
export default function FilterMenu({
  cx,
  docs,
  anchor,
  onClose,
}: {
  cx: SheetCx;
  docs: SheetDocs;
  anchor: { r: number; c: number; rect: DOMRect };
  onClose: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [blanks, setBlanks] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.rect.left, top: anchor.rect.bottom + 2 });

  useEffect(() => {
    let alive = true;
    void docs.query<Info>("view.filterInfo", { r: anchor.r, c: anchor.c }).then((r) => {
      if (!alive || !r) return;
      setInfo(r);
      setSel(new Set(r.values.filter((v) => v.selected).map((v) => v.text)));
      setBlanks(r.blanks.selected);
    });
    return () => {
      alive = false;
    };
  }, [docs, anchor.r, anchor.c]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(6, Math.min(anchor.rect.left, window.innerWidth - w - 6)),
      top: Math.max(6, Math.min(anchor.rect.bottom + 2, window.innerHeight - h - 6)),
    });
  }, [anchor, info]);

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const shown = useMemo(
    () => (info ? info.values.filter((v) => v.text.toLowerCase().includes(q.toLowerCase())) : []),
    [info, q],
  );
  const col = colName(anchor.c);
  const all = info ? info.values.every((v) => sel.has(v.text)) && blanks : true;
  const apply = (): void => {
    if (!info) return;
    if (all) void docs.run("data.filterBy", { column: info.offset, clear: true });
    else void docs.run("data.filterBy", { column: info.offset, values: [...sel], blanks });
    onClose();
  };
  const sortRange = info?.range.a1;
  return createPortal(
    <div
      ref={ref}
      className="wd-menu sh-filter"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="wd-m-item"
        onClick={() => {
          void docs.run("data.sortAscending", { column: col, range: sortRange });
          onClose();
        }}
      >
        <span className="wd-m-label">{cx.tw("Sort A to Z")}</span>
      </button>
      <button
        type="button"
        className="wd-m-item"
        onClick={() => {
          void docs.run("data.sortDescending", { column: col, range: sortRange });
          onClose();
        }}
      >
        <span className="wd-m-label">{cx.tw("Sort Z to A")}</span>
      </button>
      <div className="wd-m-sep" />
      <button
        type="button"
        className="wd-m-item"
        disabled={!info?.active}
        onClick={() => {
          if (info) void docs.run("data.filterBy", { column: info.offset, clear: true });
          onClose();
        }}
      >
        <span className="wd-m-label">{cx.tw("Clear Filter From “{name}”", { name: col })}</span>
      </button>
      <button
        type="button"
        className="wd-m-item"
        onClick={() => {
          cx.dialog("customFilter", { column: info?.offset ?? 0, letter: col });
          onClose();
        }}
      >
        <span className="wd-m-label">{cx.tw("Custom Filter…")}</span>
      </button>
      <div className="wd-m-sep" />
      <div className="sh-filter-body">
        <input
          type="search"
          placeholder={cx.tw("Search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="sh-filter-list">
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                if (!info) return;
                setSel(e.target.checked ? new Set(info.values.map((v) => v.text)) : new Set());
                setBlanks(e.target.checked);
              }}
            />
            <span>{cx.tw("(Select All)")}</span>
          </label>
          {shown.map((v) => (
            <label key={v.text}>
              <input
                type="checkbox"
                checked={sel.has(v.text)}
                onChange={(e) => {
                  const n = new Set(sel);
                  if (e.target.checked) n.add(v.text);
                  else n.delete(v.text);
                  setSel(n);
                }}
              />
              <span>{v.text}</span>
              <i>{v.count}</i>
            </label>
          ))}
          {info && info.blanks.count > 0 && !q ? (
            <label>
              <input type="checkbox" checked={blanks} onChange={(e) => setBlanks(e.target.checked)} />
              <span>{cx.tw("(Blanks)")}</span>
              <i>{info.blanks.count}</i>
            </label>
          ) : null}
        </div>
        <div className="sh-filter-foot">
          <Btn onClick={onClose}>{cx.tw("Cancel")}</Btn>
          <Btn variant="primary" onClick={apply}>
            {cx.tw("OK")}
          </Btn>
        </div>
      </div>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}
