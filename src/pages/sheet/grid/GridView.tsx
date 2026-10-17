import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { SheetGrid, SheetRange, SheetState } from "@/api/apiSheet";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import type { EditApi, EditState, ObjSel } from "@/pages/sheet/edit";
import { Geo, HEADER_H, HEADER_W_MIN, a1, colName, rangeA1 } from "@/pages/sheet/grid/geometry";
import { paintGrid, type Selection } from "@/pages/sheet/grid/paint";
import CellEditor from "@/pages/sheet/grid/CellEditor";
import PageOverlay from "@/pages/sheet/grid/PageOverlay";
import type { PagePart } from "@/pages/sheet/grid/PageOverlay";
import Objects from "@/pages/sheet/grid/Objects";

const BLOCK_X = 160;
const BLOCK_Y = 100;
const EDGE = 4;

export type Hit =
  | { kind: "cell"; r: number; c: number }
  | { kind: "colHeader"; c: number }
  | { kind: "rowHeader"; r: number }
  | { kind: "corner" }
  | { kind: "none" };

export interface GridViewProps {
  docs: SheetDocs;
  state: SheetState;
  docId: string;
  edit: EditState | null;
  editApi: EditApi;
  selObj: ObjSel | null;
  setSelObj: (o: ObjSel | null) => void;
  /** Правая кнопка мыши. */
  onContext: (x: number, y: number, hit: Hit) => void;
  /** Нажата кнопка фильтра в заголовке. */
  onFilter: (r: number, c: number, rect: DOMRect) => void;
  /** Нажата кнопка раскрывающегося списка проверки данных. */
  onList: (r: number, c: number, rect: DOMRect) => void;
  /** Сочетания клавиш ядра: «Ctrl+B» → идентификатор команды. */
  shortcuts: Map<string, string>;
  /** Диапазоны, подсвеченные при указании ссылок в формуле. */
  refs: [SheetRange, string][];
  /** Принять ссылку при указании ячейки мышью во время правки формулы (true — клик поглощён). */
  onPoint: (ref: string, extend: boolean) => boolean;
  /** Режим мыши, выбранный на ленте (формат по образцу и т. п.). */
  focusKey?: number;
  tw: (en: string) => string;
}

const sameRange = (a: SheetRange, b: SheetRange): boolean =>
  a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;

function rangeOf(r0: number, c0: number, r1: number, c1: number): SheetRange {
  const R: SheetRange = {
    r0: Math.min(r0, r1),
    c0: Math.min(c0, c1),
    r1: Math.max(r0, r1),
    c1: Math.max(c0, c1),
    a1: "",
  };
  R.a1 = rangeA1(R);
  return R;
}

/** Комбинация клавиш события → «Ctrl+Shift+Key» (как у ядра, Cmd = Ctrl). */
function combo(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Cmd");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === " ") k = "Space";
  if (k === "Escape") k = "Escape";
  parts.push(k);
  return parts.join("+");
}

/** Кандидаты ключей для поиска в карте горячих клавиш ядра (Ctrl/Cmd, порядок модификаторов). */
export function comboKeys(e: KeyboardEvent | React.KeyboardEvent): string[] {
  const c = combo(e);
  const alt = c.replace("Cmd+", "Ctrl+");
  return [c, alt, alt.replace("Ctrl+Shift+", "Shift+Ctrl+")];
}

export default function GridView(p: GridViewProps) {
  const { docs, state, docId, edit, editApi, shortcuts } = p;
  const Z = state.view.zoom / 100;
  const headings = state.view.headings;
  const rowDigits = String(Math.max(99, (state.used?.r1 ?? 0) + 40)).length;
  const headerW = headings ? Math.max(HEADER_W_MIN, rowDigits * 8 + 22) : 0;
  const headerH = headings ? HEADER_H : 0;

  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const kb = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [grid, setGrid] = useState<SheetGrid | null>(null);
  const [extent, setExtent] = useState({ w: 4000, h: 4000 });
  const [pending, setPending] = useState<Selection | null>(null);
  const [fillPrev, setFillPrev] = useState<SheetRange | null>(null);
  const [cursor, setCursor] = useState("cell");
  const [, setTick] = useState(0);
  const [grow, setGrow] = useState(0);
  const growth = useRef({ rows: 0, cols: 0 });
  const drag = useRef<{
    kind: "select" | "colResize" | "rowResize" | "fill" | "colHeader" | "rowHeader";
    anchor?: { r: number; c: number };
    index?: number;
    startPx?: number;
    startSize?: number;
    last?: string;
    add?: boolean;
    base?: SheetRange[];
  } | null>(null);
  const seq = useRef(0);

  const geo = useMemo(() => (grid ? new Geo(grid) : null), [grid]);
  const freezeKey = state.view.freeze ? state.view.freeze.join(",") : "";
  const viewKey = `${state.active}|${Z}|${freezeKey}|${state.view.formulas}|${state.view.zeros}|${state.view.mode}`;

  // Размер видимой области.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const upd = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fw0 = (grid?.frozenX ?? 0) * Z;
  const fh0 = (grid?.frozenY ?? 0) * Z;
  const reqX = Math.floor(scroll.x / Z / BLOCK_X) * BLOCK_X;
  const reqY = Math.floor(scroll.y / Z / BLOCK_Y) * BLOCK_Y;
  const reqW = (size.w - headerW - fw0) / Z + BLOCK_X * 2 + 200;
  const reqH = (size.h - headerH - fh0) / Z + BLOCK_Y * 2 + 100;

  // Окно сетки от ядра.
  useEffect(() => {
    if (!docId) return;
    const my = ++seq.current;
    const t = window.setTimeout(() => {
      api
        .sheetGrid(docId, { x: reqX, y: reqY, w: reqW, h: reqH })
        .then((g) => {
          if (my === seq.current) setGrid(g);
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(t);
  }, [docId, state.doc.revision, viewKey, reqX, reqY, reqW, reqH]);

  // Размер прокручиваемой области: по занятому диапазону, выделению и уже пройденному пути.
  const usedR = state.used?.r1 ?? 0;
  const usedC = state.used?.c1 ?? 0;
  const selR = Math.max(...state.sel.ranges.map((r) => Math.min(r.r1, 1_048_000)));
  const selC = Math.max(...state.sel.ranges.map((r) => Math.min(r.c1, 16_300)));
  useEffect(() => {
    if (!docId) return;
    const rows = Math.max(usedR + 80, selR + 40, 100) + growth.current.rows;
    const cols = Math.max(usedC + 26, selC + 12, 40) + growth.current.cols;
    let alive = true;
    api
      .sheetQuery(docId, "view.pos", { rows: [rows], cols: [cols] })
      .then((r) => {
        const j = r as { rows: [number, number, number][]; cols: [number, number, number][] };
        if (!alive || !j.rows?.[0] || !j.cols?.[0]) return;
        setExtent({ w: j.cols[0][1] + j.cols[0][2], h: j.rows[0][1] + j.rows[0][2] });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [docId, state.doc.revision, usedR, usedC, selR, selC, grow]);

  // Прокрутка: при подходе к краю растим область.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScroll((s) => (s.x === el.scrollLeft && s.y === el.scrollTop ? s : { x: el.scrollLeft, y: el.scrollTop }));
  }, []);

  useEffect(() => {
    const nearX = scroll.x + size.w > headerW + extent.w * Z - 300;
    const nearY = scroll.y + size.h > headerH + extent.h * Z - 300;
    if (nearX && growth.current.cols < 16_000) {
      growth.current.cols += 20;
      setGrow((t) => t + 1);
    }
    if (nearY && growth.current.rows < 1_040_000) {
      growth.current.rows += 100;
      setGrow((t) => t + 1);
    }
  }, [scroll, size, extent, Z, headerW, headerH]);

  // Выделение: локальное (во время перетаскивания) или из ядра.
  const selection: Selection = useMemo(
    () => pending ?? { ranges: state.sel.ranges, active: { r: state.sel.active.r, c: state.sel.active.c } },
    [pending, state.sel],
  );
  useEffect(() => setPending(null), [state.sel]);

  const clipboard = useMemo(
    () =>
      state.clipboard && state.clipboard.sheet === state.active
        ? {
            ranges: state.clipboard.areas.length ? state.clipboard.areas : [state.clipboard.range],
            cut: state.clipboard.cut,
          }
        : null,
    [state.clipboard, state.active],
  );

  const redraw = useCallback(() => setTick((t) => t + 1), []);
  const [ink, setInk] = useState<[number, number][] | null>(null);
  // Страницы печати для страничного режима и разметки страницы.
  const [pages, setPages] = useState<PagePart[]>([]);
  const mode = state.view.mode;
  const revision = state.doc.revision;
  useEffect(() => {
    if (mode === "normal") {
      setPages([]);
      return;
    }
    let alive = true;
    void (docs.run("file.printPreview", { sheets: "active" }, true) as Promise<unknown>).then((r) => {
      const list = (r as { pageList?: { page: number; range: string }[] } | undefined)?.pageList;
      if (alive && list) setPages(list.map((x) => ({ page: x.page, range: x.range })));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, revision, state.active]);

  // Рисуем.
  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv || !grid || !geo) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    paintGrid(ctx, {
      w: size.w,
      h: size.h,
      dpr,
      grid,
      geo,
      sx: scroll.x,
      sy: scroll.y,
      zoom: Z,
      headerW,
      headerH,
      gridlines: state.view.gridlines,
      headings,
      rtl: state.view.rtl,
      selection,
      clipboard,
      editing: edit ? { r: edit.r, c: edit.c } : null,
      refs: p.refs,
      fillPreview: fillPrev,
      redraw,
    });
  });

  // Положение листа ↔ экран.
  const toSheet = useCallback(
    (mx: number, my: number): { xs: number; ys: number; fx: boolean; fy: boolean } => {
      const fw = (geo?.frozenX ?? 0) * Z;
      const fh = (geo?.frozenY ?? 0) * Z;
      const fx = mx - headerW < fw;
      const fy = my - headerH < fh;
      return {
        xs: (mx - headerW + (fx ? 0 : scroll.x)) / Z,
        ys: (my - headerH + (fy ? 0 : scroll.y)) / Z,
        fx,
        fy,
      };
    },
    [geo, Z, headerW, headerH, scroll],
  );

  const screenOf = useCallback(
    (xs: number, ys: number, frozenX: boolean, frozenY: boolean): { x: number; y: number } => ({
      x: headerW + xs * Z - (frozenX ? 0 : scroll.x),
      y: headerH + ys * Z - (frozenY ? 0 : scroll.y),
    }),
    [Z, headerW, headerH, scroll],
  );

  const hitTest = useCallback(
    (mx: number, my: number): Hit & { edgeCol?: number; edgeRow?: number; fill?: boolean; filter?: boolean } => {
      if (!geo) return { kind: "none" };
      if (headings && mx < headerW && my < headerH) return { kind: "corner" };
      const { xs, ys } = toSheet(mx, my);
      if (headings && my < headerH) {
        // Граница столбца: изменение ширины.
        for (const c of geo.colList) {
          const frozen = c < geo.fc;
          const right = headerW + (geo.xOf(c) + geo.wOf(c)) * Z - (frozen ? 0 : scroll.x);
          if (Math.abs(mx - right) <= EDGE && (frozen || right > headerW + (geo.frozenX ?? 0) * Z))
            return { kind: "colHeader", c, edgeCol: c };
        }
        const c = geo.colAt(xs);
        return c === null ? { kind: "none" } : { kind: "colHeader", c };
      }
      if (headings && mx < headerW) {
        for (const r of geo.rowList) {
          const frozen = r < geo.fr;
          const bottom = headerH + (geo.yOf(r) + geo.hOf(r)) * Z - (frozen ? 0 : scroll.y);
          if (Math.abs(my - bottom) <= EDGE && (frozen || bottom > headerH + (geo.frozenY ?? 0) * Z))
            return { kind: "rowHeader", r, edgeRow: r };
        }
        const r = geo.rowAt(ys);
        return r === null ? { kind: "none" } : { kind: "rowHeader", r };
      }
      const c = geo.colAt(xs);
      const r = geo.rowAt(ys);
      if (c === null || r === null) return { kind: "none" };
      // Маркер заполнения у правого нижнего угла выделения.
      const last = selection.ranges[selection.ranges.length - 1];
      if (last && !edit) {
        const rect = geo.rect(last.r0, last.c0, last.r1, last.c1);
        const fx = toSheet(mx, my).fx;
        const fy = toSheet(mx, my).fy;
        const corner = screenOf(rect.x + rect.w, rect.y + rect.h, fx, fy);
        if (Math.abs(mx - corner.x) <= 6 && Math.abs(my - corner.y) <= 6) return { kind: "cell", r, c, fill: true };
      }
      // Кнопка фильтра.
      const cell = grid?.cells.find((k) => k.r === r && k.c === c);
      if (cell?.flt) {
        const rect = geo.rect(r, c, r, c);
        const fxy = toSheet(mx, my);
        const br = screenOf(rect.x + rect.w, rect.y + rect.h, fxy.fx, fxy.fy);
        if (mx > br.x - 22 * Z && my > br.y - 22 * Z) return { kind: "cell", r, c, filter: true };
      }
      return { kind: "cell", r, c };
    },
    [geo, grid, headings, headerW, headerH, Z, scroll, toSheet, screenOf, selection, edit],
  );

  // Запомнить, что выделение уже отправлено, чтобы не слать одно и то же.
  const sendSelection = useCallback(
    (ranges: SheetRange[], active: { r: number; c: number }) => {
      const spec = ranges.map((r) => r.a1).join(",");
      void docs.run("selection.set", { range: spec, active: a1(active.r, active.c) });
    },
    [docs],
  );

  // Прокрутить так, чтобы ячейка была видна.
  const reveal = useCallback(
    async (r: number, c: number) => {
      const el = scroller.current;
      if (!el) return;
      const res = (await api.sheetQuery(docId, "view.pos", { rows: [r], cols: [c] })) as {
        rows: [number, number, number][];
        cols: [number, number, number][];
      };
      const row = res.rows?.[0];
      const col = res.cols?.[0];
      if (!row || !col) return;
      const frozenC = c < (state.view.freeze?.[1] ?? 0);
      const frozenR = r < (state.view.freeze?.[0] ?? 0);
      const fw = (grid?.frozenX ?? 0) * Z;
      const fh = (grid?.frozenY ?? 0) * Z;
      let sx = el.scrollLeft;
      let sy = el.scrollTop;
      if (!frozenC) {
        const left = col[1] * Z;
        const right = (col[1] + col[2]) * Z;
        if (left < sx + fw) sx = Math.max(0, left - fw);
        else if (right > sx + size.w - headerW) sx = right - (size.w - headerW);
      }
      if (!frozenR) {
        const top = row[1] * Z;
        const bottom = (row[1] + row[2]) * Z;
        if (top < sy + fh) sy = Math.max(0, top - fh);
        else if (bottom > sy + size.h - headerH) sy = bottom - (size.h - headerH);
      }
      if (sx !== el.scrollLeft) el.scrollLeft = sx;
      if (sy !== el.scrollTop) el.scrollTop = sy;
    },
    [docId, grid, Z, size, headerW, headerH, state.view.freeze],
  );

  const lastActive = useRef("");
  useEffect(() => {
    const k = `${docId}|${state.active}|${state.sel.active.a1}`;
    if (k === lastActive.current) return;
    lastActive.current = k;
    void reveal(state.sel.active.r, state.sel.active.c);
  }, [docId, state.active, state.sel.active, reveal]);

  const focusKb = useCallback(() => {
    // Фокус в поле ввода сетки; пока правится строка формул, фокус оставляем ей.
    if (edit?.origin === "bar") return;
    kb.current?.focus({ preventScroll: true });
  }, [edit?.origin]);

  useEffect(() => {
    if (!edit) focusKb();
  }, [edit, focusKb, p.focusKey]);

  // ---------------- мышь ----------------
  const eventPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = scroller.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const finishDrag = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finishDrag);
      if (!d || !geo) return;
      const { x, y } = eventPos(e);
      if (d.kind === "colResize") {
        const next = Math.max(0, (x - (d.startPx ?? 0)) / Z + (d.startSize ?? 64));
        void docs.run("home.columnWidth", { cols: `${colName(d.index ?? 0)}:${colName(d.index ?? 0)}`, width: Math.round(next) });
      } else if (d.kind === "rowResize") {
        const next = Math.max(0, (y - (d.startPx ?? 0)) / Z + (d.startSize ?? 20));
        void docs.run("home.rowHeight", { rows: `${(d.index ?? 0) + 1}:${(d.index ?? 0) + 1}`, height: Math.round(next) });
      } else if (d.kind === "fill" && fillPrevRef.current && d.base?.[0]) {
        const src = d.base[d.base.length - 1];
        const tgt = fillPrevRef.current;
        setFillPrev(null);
        fillPrevRef.current = null;
        if (!sameRange(src, tgt)) {
          void docs
            .run("edit.autoFill", { source: src.a1, target: tgt.a1 })
            .then(() => docs.run("selection.set", { range: tgt.a1, active: a1(src.r0, src.c0) }));
        }
      } else if (pendingRef.current) {
        const s = pendingRef.current;
        sendSelection(s.ranges, s.active);
      }
      pendingRef.current = null;
      focusKb();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geo, Z, docs, sendSelection, focusKb],
  );
  const pendingRef = useRef<Selection | null>(null);
  const fillPrevRef = useRef<SheetRange | null>(null);
  const autoScroll = useRef(0);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      const el = scroller.current;
      if (!d || !geo || !el) return;
      const { x, y } = eventPos(e);
      // Автопрокрутка у краёв во время выделения.
      const dx = x > size.w - 12 ? 24 : x < headerW + 8 ? -24 : 0;
      const dy = y > size.h - 12 ? 24 : y < headerH + 8 ? -24 : 0;
      if ((d.kind === "select" || d.kind === "fill" || d.kind === "colHeader" || d.kind === "rowHeader") && (dx || dy)) {
        window.cancelAnimationFrame(autoScroll.current);
        const tick = (): void => {
          if (!drag.current) return;
          el.scrollLeft += dx;
          el.scrollTop += dy;
          autoScroll.current = window.requestAnimationFrame(tick);
        };
        autoScroll.current = window.requestAnimationFrame(tick);
      } else window.cancelAnimationFrame(autoScroll.current);
      if (d.kind === "colResize" || d.kind === "rowResize") return;
      const t = toSheet(
        Math.min(Math.max(x, headerW + 1), size.w - 1),
        Math.min(Math.max(y, headerH + 1), size.h - 1),
      );
      let c = geo.colAt(t.xs);
      let r = geo.rowAt(t.ys);
      if (c === null) c = t.xs < 0 ? geo.minCol : geo.maxCol;
      if (r === null) r = t.ys < 0 ? geo.minRow : geo.maxRow;
      const key = `${r},${c}`;
      if (key === d.last) return;
      d.last = key;
      const anchor = d.anchor ?? { r, c };
      if (d.kind === "fill") {
        const src = d.base?.[d.base.length - 1];
        if (!src) return;
        // Заполнение тянется вниз/вправо/вверх/влево — в сторону, куда ушла мышь сильнее.
        const downBy = r - src.r1;
        const rightBy = c - src.c1;
        const upBy = src.r0 - r;
        const leftBy = src.c0 - c;
        const best = Math.max(downBy, rightBy, upBy, leftBy);
        let tgt = src;
        if (best > 0) {
          if (best === downBy) tgt = rangeOf(src.r0, src.c0, r, src.c1);
          else if (best === rightBy) tgt = rangeOf(src.r0, src.c0, src.r1, c);
          else if (best === upBy) tgt = rangeOf(r, src.c0, src.r1, src.c1);
          else tgt = rangeOf(src.r0, c, src.r1, src.c1);
        }
        fillPrevRef.current = tgt;
        setFillPrev(tgt);
        return;
      }
      let range: SheetRange;
      if (d.kind === "colHeader") range = rangeOf(0, anchor.c, 1_048_575, c);
      else if (d.kind === "rowHeader") range = rangeOf(anchor.r, 0, r, 16_383);
      else range = rangeOf(anchor.r, anchor.c, r, c);
      const base = d.base ?? [];
      const ranges = d.add ? [...base, range] : [range];
      const sel: Selection = { ranges, active: d.add ? { r: anchor.r, c: anchor.c } : { r: anchor.r, c: anchor.c } };
      pendingRef.current = sel;
      setPending(sel);
    },
    [geo, size, headerW, headerH, toSheet],
  );

  const startDrag = (d: NonNullable<typeof drag.current>): void => {
    drag.current = d;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finishDrag);
  };

  /** Перо и ластик: штрих собирается в точках листа и отправляется ядру целиком. */
  const startInk = (e: React.MouseEvent, tool: "pen" | "eraser"): void => {
    const first = eventPos(e);
    const gone = new Set<number>();
    const erase = (px: number, py: number): void => {
      const t = toSheet(px, py);
      const hit = grid?.shapes
        .filter((s) => s.kind === "Ink" && !gone.has(s.id) && t.xs >= s.x - 4 && t.xs <= s.x + s.w + 4 && t.ys >= s.y - 4 && t.ys <= s.y + s.h + 4)
        .pop();
      if (!hit) return;
      gone.add(hit.id);
      void docs.run("object.delete", { kind: "shape", id: hit.id });
    };
    const pts: [number, number][] = [];
    const add = (px: number, py: number): void => {
      if (tool === "eraser") return erase(px, py);
      const t = toSheet(px, py);
      pts.push([Math.round(t.xs * 10) / 10, Math.round(t.ys * 10) / 10]);
      setInk([...pts]);
    };
    add(first.x, first.y);
    const move = (ev: MouseEvent): void => {
      const q = eventPos(ev);
      add(Math.min(Math.max(q.x, headerW + 1), size.w - 1), Math.min(Math.max(q.y, headerH + 1), size.h - 1));
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setInk(null);
      if (tool === "pen" && pts.length) {
        const line = pts.length === 1 ? [pts[0], [pts[0][0] + 0.5, pts[0][1] + 0.5]] : pts;
        void docs.run("draw.stroke", {
          points: line,
          ...(state.draw.color ? { color: state.draw.color } : {}),
          ...(state.draw.width ? { width: state.draw.width } : {}),
        });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0 || !geo) return;
    const tgt = e.target as HTMLElement;
    const tool = state.draw.tool;
    if ((tool === "pen" || tool === "eraser") && !tgt.closest(".sh-editor")) {
      const q = eventPos(e);
      if (q.x > headerW && q.y > headerH && q.x < size.w && q.y < size.h) {
        e.preventDefault();
        startInk(e, tool);
        return;
      }
    }
    if (tgt.closest("[data-obj]") || tgt.closest(".sh-editor")) return;
    const { x, y } = eventPos(e);
    if (x > size.w || y > size.h) return; // полосы прокрутки
    e.preventDefault();
    const h = hitTest(x, y);
    // Правка формулы: клик по ячейке указывает ссылку.
    if (edit && h.kind === "cell") {
      const ref = e.shiftKey && edit ? a1(h.r, h.c) : a1(h.r, h.c);
      if (p.onPoint(ref, e.shiftKey)) {
        return;
      }
    }
    if (edit) void editApi.commit("none");
    p.setSelObj(null);
    if (h.kind === "corner") {
      void docs.run("edit.selectAll", {});
      void docs.run("selection.set", { range: "A1:XFD1048576", active: a1(selection.active.r, selection.active.c) });
      return;
    }
    if (h.kind === "colHeader") {
      if (h.edgeCol !== undefined) {
        if (e.detail >= 2) {
          void docs.run("home.autofitColumnWidth", { cols: `${colName(h.c)}:${colName(h.c)}` });
          return;
        }
        startDrag({ kind: "colResize", index: h.c, startPx: x, startSize: geo.wOf(h.c) });
        return;
      }
      const anchor = e.shiftKey ? { r: 0, c: selection.active.c } : { r: 0, c: h.c };
      const range = rangeOf(0, anchor.c, 1_048_575, h.c);
      const base = e.ctrlKey || e.metaKey ? selection.ranges : [];
      const sel: Selection = { ranges: [...base, range], active: { r: 0, c: anchor.c } };
      pendingRef.current = sel;
      setPending(sel);
      startDrag({ kind: "colHeader", anchor, add: e.ctrlKey || e.metaKey, base });
      return;
    }
    if (h.kind === "rowHeader") {
      if (h.edgeRow !== undefined) {
        if (e.detail >= 2) {
          void docs.run("home.autofitRowHeight", { rows: `${h.r + 1}:${h.r + 1}` });
          return;
        }
        startDrag({ kind: "rowResize", index: h.r, startPx: y, startSize: geo.hOf(h.r) });
        return;
      }
      const anchor = e.shiftKey ? { r: selection.active.r, c: 0 } : { r: h.r, c: 0 };
      const range = rangeOf(anchor.r, 0, h.r, 16_383);
      const base = e.ctrlKey || e.metaKey ? selection.ranges : [];
      const sel: Selection = { ranges: [...base, range], active: { r: anchor.r, c: 0 } };
      pendingRef.current = sel;
      setPending(sel);
      startDrag({ kind: "rowHeader", anchor, add: e.ctrlKey || e.metaKey, base });
      return;
    }
    if (h.kind !== "cell") return;
    if (h.filter) {
      const r0 = scroller.current?.getBoundingClientRect();
      const rect = geo.rect(h.r, h.c, h.r, h.c);
      const t = toSheet(x, y);
      const s = screenOf(rect.x, rect.y, t.fx, t.fy);
      p.onFilter(
        h.r,
        h.c,
        new DOMRect((r0?.left ?? 0) + s.x, (r0?.top ?? 0) + s.y, rect.w * Z, rect.h * Z),
      );
      return;
    }
    if (h.fill) {
      startDrag({ kind: "fill", base: selection.ranges, anchor: selection.active });
      return;
    }
    // Список проверки данных у активной ячейки.
    if (state.ctx.validation?.dropdown && h.r === selection.active.r && h.c === selection.active.c) {
      const r0 = scroller.current?.getBoundingClientRect();
      const rect = geo.rect(h.r, h.c, h.r, h.c);
      const t = toSheet(x, y);
      const s = screenOf(rect.x, rect.y, t.fx, t.fy);
      const bx = s.x + rect.w * Z;
      if (x > bx - 2 && x < bx + 22 * Z) {
        p.onList(h.r, h.c, new DOMRect((r0?.left ?? 0) + s.x, (r0?.top ?? 0) + s.y, rect.w * Z, rect.h * Z));
        return;
      }
    }
    // Флажок.
    const cellRec = grid?.cells.find((k) => k.r === h.r && k.c === h.c);
    if (cellRec?.ck !== undefined && !e.shiftKey && !e.ctrlKey) {
      void docs.run("selection.set", { range: a1(h.r, h.c) });
      void docs.run("cell.toggleCheckbox", { cell: a1(h.r, h.c) });
      return;
    }
    const mergeHere = grid?.merges.find((m) => h.r >= m.r0 && h.r <= m.r1 && h.c >= m.c0 && h.c <= m.c1);
    const hr = mergeHere?.r0 ?? h.r;
    const hc = mergeHere?.c0 ?? h.c;
    const add = e.ctrlKey || e.metaKey;
    const anchor = e.shiftKey ? { r: state.sel.anchor.r, c: state.sel.anchor.c } : { r: hr, c: hc };
    const range = rangeOf(anchor.r, anchor.c, h.r, h.c);
    const base = add ? selection.ranges : [];
    const sel: Selection = { ranges: [...base, range], active: add ? { r: hr, c: hc } : anchor };
    pendingRef.current = sel;
    setPending(sel);
    startDrag({ kind: "select", anchor: sel.active, add, base });
    // Ссылка: Ctrl+клик по ячейке с гиперссылкой открывает её.
    if (cellRec?.lk && (e.ctrlKey || e.metaKey)) void docs.run("link.open", { cell: a1(h.r, h.c) });
  };

  const onDouble = (e: React.MouseEvent): void => {
    if (!geo) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest("[data-obj]") || tgt.closest(".sh-editor")) return;
    const { x, y } = eventPos(e);
    const h = hitTest(x, y);
    if (h.kind === "cell" && !h.fill && !h.filter && drag.current === null) {
      editApi.begin(null, "cell", "edit");
    }
  };

  const onMouseMoveHover = (e: React.MouseEvent): void => {
    if (drag.current || !geo) return;
    const { x, y } = eventPos(e);
    if (x > size.w || y > size.h) return;
    const h = hitTest(x, y);
    let cur = "cell";
    if (h.kind === "colHeader") cur = h.edgeCol !== undefined ? "col-resize" : "s-resize";
    else if (h.kind === "rowHeader") cur = h.edgeRow !== undefined ? "row-resize" : "e-resize";
    else if (h.kind === "corner") cur = "default";
    else if (h.kind === "cell" && h.fill) cur = "crosshair";
    else if (h.kind === "cell" && h.filter) cur = "pointer";
    setCursor((c) => (c === cur ? c : cur));
  };

  const onContextMenu = (e: React.MouseEvent): void => {
    if (!geo) return;
    e.preventDefault();
    const { x, y } = eventPos(e);
    const h = hitTest(x, y);
    // Правый клик вне выделения переносит выделение на эту ячейку.
    if (h.kind === "cell" && !selection.ranges.some((r) => h.r >= r.r0 && h.r <= r.r1 && h.c >= r.c0 && h.c <= r.c1)) {
      void docs.run("selection.set", { range: a1(h.r, h.c) });
    }
    if (h.kind === "colHeader" && !selection.ranges.some((r) => h.c >= r.c0 && h.c <= r.c1 && r.r0 === 0))
      void docs.run("selection.set", { range: `${colName(h.c)}1:${colName(h.c)}1048576`, active: `${colName(h.c)}1` });
    if (h.kind === "rowHeader" && !selection.ranges.some((r) => h.r >= r.r0 && h.r <= r.r1 && r.c0 === 0))
      void docs.run("selection.set", { range: `A${h.r + 1}:XFD${h.r + 1}`, active: `A${h.r + 1}` });
    p.onContext(e.clientX, e.clientY, h);
  };

  // Колесо с Ctrl — масштаб.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const z = Math.min(400, Math.max(10, state.view.zoom + (e.deltaY < 0 ? 10 : -10)));
      void docs.run("view.zoom", { percent: z });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [docs, state.view.zoom]);

  // ---------------- клавиатура ----------------
  const move = (dr: number, dc: number, e: React.KeyboardEvent, extra: Record<string, unknown> = {}): void => {
    void docs.run("selection.move", {
      dr,
      dc,
      extend: e.shiftKey,
      jump: e.ctrlKey || e.metaKey,
      ...extra,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (edit) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    // Объект выбран: Delete удаляет его.
    if (p.selObj && (k === "Delete" || k === "Backspace")) {
      e.preventDefault();
      void docs.run("object.delete", { kind: p.selObj.kind === "slicer" ? "shape" : p.selObj.kind, id: p.selObj.id });
      p.setSelObj(null);
      return;
    }
    switch (k) {
      case "ArrowDown":
        e.preventDefault();
        return move(1, 0, e);
      case "ArrowUp":
        e.preventDefault();
        return move(-1, 0, e);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1, e);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1, e);
      case "PageDown":
        e.preventDefault();
        if (e.altKey) return move(0, 10, e);
        return move(Math.max(1, Math.floor((size.h - headerH) / (20 * Z)) - 1), 0, e, { page: true, jump: false });
      case "PageUp":
        e.preventDefault();
        if (e.altKey) return move(0, -10, e);
        return move(-Math.max(1, Math.floor((size.h - headerH) / (20 * Z)) - 1), 0, e, { page: true, jump: false });
      case "Home":
        e.preventDefault();
        if (mod) {
          void docs.run("selection.set", { range: "A1" });
          return;
        }
        void docs.run("selection.set", {
          range: e.shiftKey ? `A${state.sel.active.r + 1}:${state.sel.active.a1}` : `A${state.sel.active.r + 1}`,
          active: e.shiftKey ? state.sel.active.a1 : undefined,
        });
        return;
      case "End":
        e.preventDefault();
        if (mod) void docs.run("edit.goToSpecial", { kind: "lastCell" });
        return;
      case "Tab":
        e.preventDefault();
        if (editApi.typeEnd(e.shiftKey ? "left" : "right")) return;
        void docs.run("selection.next", { forward: !e.shiftKey, byRow: true });
        return;
      case "Enter":
        e.preventDefault();
        if (editApi.typeEnd(e.shiftKey ? "up" : "down")) return;
        if (state.sel.ranges.length > 1 || !state.sel.ranges[0] || state.sel.ranges[0].a1.includes(":")) {
          void docs.run("selection.next", { forward: !e.shiftKey, byRow: false });
        } else {
          const dir = state.prefs.enterDirection;
          const sgn = e.shiftKey ? -1 : 1;
          const [dr, dc] =
            dir === "right" ? [0, sgn] : dir === "up" ? [-sgn, 0] : dir === "left" ? [0, -sgn] : dir === "none" ? [0, 0] : [sgn, 0];
          if (dr || dc) void docs.run("selection.move", { dr, dc });
        }
        return;
      case "F2":
        e.preventDefault();
        editApi.begin(null, "cell", "edit");
        return;
      case "Delete":
        e.preventDefault();
        void docs.run("edit.clearContents", {});
        return;
      case "Backspace":
        e.preventDefault();
        editApi.type("");
        return;
      case "Escape":
        void docs.run("edit.clearClipboard", {});
        return;
      case " ":
        if (mod || e.shiftKey) {
          e.preventDefault();
          void docs.run(mod ? "selection.column" : "selection.row", {});
          return;
        }
        if (grid?.cells.find((c) => c.r === state.sel.active.r && c.c === state.sel.active.c && c.ck !== undefined)) {
          e.preventDefault();
          void docs.run("cell.toggleCheckbox", {});
          return;
        }
        break;
      default:
    }
    // Копирование / вставка идут через события буфера обмена (onCopy/onPaste).
    if (mod && !e.altKey && (k === "c" || k === "C" || k === "x" || k === "X" || k === "v" || k === "V")) return;
    if (mod && !e.altKey && (k === "z" || k === "Z" || k === "y" || k === "Y") && !e.shiftKey) {
      e.preventDefault();
      void docs.run(k.toLowerCase() === "z" ? "edit.undo" : "edit.redo", {});
      return;
    }
    if (mod || e.altKey || k.startsWith("F")) {
      for (const key of comboKeys(e)) {
        const id = shortcuts.get(key);
        if (id) {
          e.preventDefault();
          void docs.run(id, {});
          return;
        }
      }
      return;
    }
    // Печатный символ начинает ввод поверх ячейки.
    if (k.length === 1) {
      e.preventDefault();
      editApi.type(k);
    }
  };

  const contentW = headerW + extent.w * Z;
  const contentH = headerH + extent.h * Z;
  const active = state.sel.active;

  return (
    <div
      className={`sh-grid-wrap${state.draw.tool ? " sh-inking" : ""}`}
      style={{ cursor: state.draw.tool === "pen" ? "crosshair" : state.draw.tool === "eraser" ? "cell" : cursor }}
    >
      <div
        ref={scroller}
        className="sh-scroll"
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onDoubleClick={onDouble}
        onMouseMove={onMouseMoveHover}
        onContextMenu={onContextMenu}
      >
        <div style={{ width: contentW, height: contentH, position: "absolute", left: 0, top: 0, pointerEvents: "none" }} />
        <div style={{ position: "sticky", left: 0, top: 0, width: 0, height: 0 }}>
          <canvas ref={canvas} style={{ position: "absolute", left: 0, top: 0, width: size.w, height: size.h }} />
          {geo && grid ? (
            <Objects
              grid={grid}
              geo={geo}
              zoom={Z}
              scroll={scroll}
              headerW={headerW}
              headerH={headerH}
              selObj={p.selObj}
              setSelObj={p.setSelObj}
              docs={docs}
              docId={docId}
              size={size}
              focusGrid={focusKb}
            />
          ) : null}
          {pages.length && geo ? (
            <PageOverlay pages={pages} geo={geo} zoom={Z} scroll={scroll} headerW={headerW} headerH={headerH} size={size} label={(n) => `${p.tw("Page")} ${n}`} />
          ) : null}
          {ink && ink.length > 1 ? (
            <svg style={{ position: "absolute", left: 0, top: 0, width: size.w, height: size.h, pointerEvents: "none" }}>
              <polyline
                points={ink.map(([a, b]) => `${screenOf(a, b, false, false).x},${screenOf(a, b, false, false).y}`).join(" ")}
                fill="none"
                stroke={state.draw.color || "#000000"}
                strokeWidth={(state.draw.width || 2) * Z}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
          {edit && geo ? (
            <CellEditor
              edit={edit}
              api={editApi}
              geo={geo}
              grid={grid}
              zoom={Z}
              scroll={scroll}
              headerW={headerW}
              headerH={headerH}
              state={state}
              size={size}
              docs={docs}
            />
          ) : null}
        </div>
      </div>
      <textarea
        ref={kb}
        className="sh-kb"
        aria-label="grid-input"
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          e.preventDefault();
          void docs.run("edit.paste", {
            text: e.clipboardData.getData("text/plain"),
            html: e.clipboardData.getData("text/html"),
          });
        }}
        onCopy={(e) => {
          e.preventDefault();
          void copyFromCore(docs, e.nativeEvent, false);
        }}
        onCut={(e) => {
          e.preventDefault();
          void copyFromCore(docs, e.nativeEvent, true);
        }}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onInput={(e) => {
          // Ввод, пришедший не через keydown (экранная клавиатура, диктовка).
          const el = e.currentTarget;
          const text = el.value;
          el.value = "";
          if (text && !edit) editApi.type(text);
        }}
        data-active={`${active.a1}`}
      />
    </div>
  );
}

/**
 * Копировать/вырезать: ядро запоминает диапазон с формулами и стилями, а в системный буфер
 * кладём текст и HTML, чтобы вставка работала и в других программах.
 */
async function copyFromCore(docs: SheetDocs, _e: ClipboardEvent, cut: boolean): Promise<void> {
  const r = (await docs.run(cut ? "edit.cut" : "edit.copy", { html: true })) as
    | { text?: string; html?: string }
    | undefined;
  if (!r || r.text === undefined) return;
  try {
    if (r.html && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([r.text], { type: "text/plain" }),
          "text/html": new Blob([r.html], { type: "text/html" }),
        }),
      ]);
    } else await navigator.clipboard.writeText(r.text);
  } catch {
    /* системный буфер недоступен: вставка внутри листа всё равно работает */
  }
}
