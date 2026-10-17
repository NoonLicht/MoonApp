import { memo, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { SheetGrid, SheetObjectRect } from "@/api/apiSheet";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import type { ObjSel } from "@/pages/sheet/edit";
import { a1, type Geo } from "@/pages/sheet/grid/geometry";

interface Props {
  grid: SheetGrid;
  geo: Geo;
  zoom: number;
  scroll: { x: number; y: number };
  headerW: number;
  headerH: number;
  selObj: ObjSel | null;
  setSelObj: (o: ObjSel | null) => void;
  docs: SheetDocs;
  docId: string;
  size: { w: number; h: number };
  focusGrid: () => void;
}

/** Картинки листа: байты берём у ядра один раз и держим как blob-URL. */
const PICS = new Map<string, string>();

function useImage(docId: string, id: number, size: number, mime: string): string | null {
  const key = `${docId}:${id}:${size}`;
  const [url, setUrl] = useState<string | null>(PICS.get(key) ?? null);
  useEffect(() => {
    const hit = PICS.get(key);
    if (hit) return setUrl(hit);
    let alive = true;
    api
      .sheetQuery(docId, "view.image", { id })
      .then((r) => {
        const j = r as { base64: string };
        const bin = atob(j.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const u = URL.createObjectURL(new Blob([bytes], { type: mime || "image/png" }));
        PICS.set(key, u);
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key, docId, id, mime]);
  return url;
}

function Picture({ docId, o }: { docId: string; o: SheetGrid["images"][number] }) {
  const url = useImage(docId, o.id, o.size, o.mime);
  return url ? <img src={url} alt={o.alt} draggable={false} className="sh-pic" /> : null;
}

/** Геометрия фигуры в SVG. */
function ShapeBody({ s, w, h, z }: { s: SheetGrid["shapes"][number]; w: number; h: number; z: number }) {
  const fill = s.fill ?? "#156082";
  const line = s.fmt.no_line ? "none" : (s.line ?? "#0E3C52");
  const sw = Math.max(1, z);
  let inner: React.ReactNode;
  switch (s.kind) {
    case "Ellipse":
      inner = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - sw / 2} ry={h / 2 - sw / 2} fill={fill} stroke={line} strokeWidth={sw} />;
      break;
    case "Triangle":
      inner = <polygon points={`${w / 2},${sw} ${w - sw},${h - sw} ${sw},${h - sw}`} fill={fill} stroke={line} strokeWidth={sw} />;
      break;
    case "RoundedRectangle":
      inner = <rect x={sw / 2} y={sw / 2} width={w - sw} height={h - sw} rx={Math.min(w, h) * 0.15} fill={fill} stroke={line} strokeWidth={sw} />;
      break;
    case "Line":
      inner = <line x1={0} y1={h} x2={w} y2={0} stroke={s.line ?? fill} strokeWidth={Math.max(2, 2 * z)} />;
      break;
    case "Arrow":
      inner = (
        <g stroke={s.line ?? fill} fill={s.line ?? fill} strokeWidth={Math.max(2, 2 * z)}>
          <line x1={0} y1={h / 2} x2={w - 10 * z} y2={h / 2} />
          <polygon points={`${w},${h / 2} ${w - 12 * z},${h / 2 - 6 * z} ${w - 12 * z},${h / 2 + 6 * z}`} stroke="none" />
        </g>
      );
      break;
    case "TextBox":
      inner = <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke={s.fmt.no_line ? "none" : "#7F7F7F"} strokeWidth={1} />;
      break;
    case "Ink": {
      const pts = (s.text || "")
        .split(";")
        .map((p) => p.split(",").map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => `${x * z},${y * z}`)
        .join(" ");
      return (
        <svg width={w} height={h} style={{ overflow: "visible" }}>
          <polyline points={pts} fill="none" stroke={s.line ?? "#000"} strokeWidth={Math.max(1, 2 * z)} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    default:
      inner = <rect x={sw / 2} y={sw / 2} width={w - sw} height={h - sw} fill={fill} stroke={line} strokeWidth={sw} />;
  }
  const showText = s.kind !== "Line" && s.kind !== "Arrow" && s.kind !== "Icon";
  const f = s.fmt as { font_size?: number | null; bold?: boolean; italic?: boolean; font?: string | null };
  return (
    <>
      <svg width={w} height={h} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {inner}
      </svg>
      {showText && s.text ? (
        <div
          className="sh-shape-text"
          style={{
            color: s.textColor ?? (s.kind === "TextBox" ? "#000" : "#fff"),
            fontSize: (f.font_size ?? 11) * (96 / 72) * z,
            fontWeight: f.bold ? 700 : 400,
            fontStyle: f.italic ? "italic" : "normal",
            fontFamily: f.font ?? undefined,
          }}
        >
          {s.text}
        </div>
      ) : null}
    </>
  );
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function Objects(p: Props) {
  const { grid, geo, zoom: Z, scroll, headerW, headerH, docs, selObj } = p;
  const [drag, setDrag] = useState<{ dx: number; dy: number; dw: number; dh: number; kind: string; id: number } | null>(null);
  const start = useRef<{ x: number; y: number; handle: Handle | "move" } | null>(null);

  const frozenW = geo.frozenX * Z;
  const frozenH = geo.frozenY * Z;
  const rect = (o: SheetObjectRect): { left: number; top: number; width: number; height: number } => ({
    left: headerW + o.x * Z - scroll.x,
    top: headerH + o.y * Z - scroll.y,
    width: o.w * Z,
    height: o.h * Z,
  });
  void frozenW;
  void frozenH;

  const select = (kind: ObjSel["kind"], id: number, e: React.MouseEvent): void => {
    e.stopPropagation();
    p.setSelObj({ kind, id });
  };

  const commit = (kind: ObjSel["kind"], o: SheetObjectRect, d: { dx: number; dy: number; dw: number; dh: number }): void => {
    // Новая позиция: ячейка под левым верхним углом и смещение внутри неё.
    const nx = Math.max(0, o.x + d.dx / Z);
    const ny = Math.max(0, o.y + d.dy / Z);
    const c = geo.colAt(nx) ?? geo.minCol;
    const r = geo.rowAt(ny) ?? geo.minRow;
    const params: Record<string, unknown> = {
      kind: kind === "slicer" ? "shape" : kind,
      id: o.id,
      at: a1(r, c),
      dx: Math.max(0, nx - geo.xOf(c)),
      dy: Math.max(0, ny - geo.yOf(r)),
    };
    if (d.dw || d.dh) {
      params.width = Math.max(8, o.w + d.dw / Z);
      params.height = Math.max(8, o.h + d.dh / Z);
    }
    if (kind === "slicer") {
      void docs.run("object.move", { ...params, kind: "slicer" });
      return;
    }
    void docs.run("object.move", params);
  };

  const begin = (e: React.MouseEvent, kind: ObjSel["kind"], o: SheetObjectRect, handle: Handle | "move"): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    p.setSelObj({ kind, id: o.id });
    start.current = { x: e.clientX, y: e.clientY, handle };
    let last = { dx: 0, dy: 0, dw: 0, dh: 0 };
    const move = (ev: MouseEvent): void => {
      const s = start.current;
      if (!s) return;
      const mx = ev.clientX - s.x;
      const my = ev.clientY - s.y;
      let d = { dx: 0, dy: 0, dw: 0, dh: 0 };
      const h = s.handle;
      if (h === "move") d = { dx: mx, dy: my, dw: 0, dh: 0 };
      else {
        if (h.includes("e")) d.dw = mx;
        if (h.includes("s")) d.dh = my;
        if (h.includes("w")) {
          d.dx = mx;
          d.dw = -mx;
        }
        if (h.includes("n")) {
          d.dy = my;
          d.dh = -my;
        }
      }
      last = d;
      setDrag({ ...d, kind, id: o.id });
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      start.current = null;
      setDrag(null);
      if (last.dx || last.dy || last.dw || last.dh) commit(kind, o, last);
      p.focusGrid();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const frame = (kind: ObjSel["kind"], o: SheetObjectRect, children: React.ReactNode, cls = ""): React.ReactNode => {
    const base = rect(o);
    const on = selObj?.kind === kind && selObj.id === o.id;
    const d = drag && drag.kind === kind && drag.id === o.id ? drag : null;
    const style = {
      left: base.left + (d?.dx ?? 0),
      top: base.top + (d?.dy ?? 0),
      width: Math.max(8, base.width + (d?.dw ?? 0)),
      height: Math.max(8, base.height + (d?.dh ?? 0)),
    };
    if (style.left + style.width < headerW || style.top + style.height < headerH) return null;
    return (
      <div
        key={`${kind}${o.id}`}
        data-obj={`${kind}${o.id}`}
        className={`sh-obj ${cls}${on ? " on" : ""}`}
        style={style}
        onMouseDown={(e) => (on ? begin(e, kind, o, "move") : select(kind, o.id, e))}
        onContextMenu={(e) => {
          e.stopPropagation();
          p.setSelObj({ kind, id: o.id });
        }}
      >
        {children}
        {on
          ? HANDLES.map((h) => (
              <i key={h} className={`sh-h sh-h-${h}`} onMouseDown={(e) => begin(e, kind, o, h)} />
            ))
          : null}
      </div>
    );
  };

  return (
    <div className="sh-objects" style={{ left: headerW, top: headerH, width: p.size.w - headerW, height: p.size.h - headerH }}>
      <div style={{ position: "absolute", left: -headerW, top: -headerH }}>
        {grid.images.map((o) =>
          frame("image", o, <Picture docId={p.docId} o={o} />),
        )}
        {grid.charts.map((o) =>
          frame(
            "chart",
            o,
            <div className="sh-chart" dangerouslySetInnerHTML={{ __html: o.svg }} />,
            "sh-chart-box",
          ),
        )}
        {grid.shapes.map((o) =>
          frame("shape", o, <ShapeBody s={o} w={o.w * Z} h={o.h * Z} z={Z} />),
        )}
        {grid.slicers.map((o) =>
          frame(
            "slicer",
            o,
            <div className="sh-slicer">
              <div className="sh-slicer-head">{o.caption || o.column}</div>
              <div className="sh-slicer-note">{o.table}</div>
            </div>,
          ),
        )}
      </div>
    </div>
  );
}

export default memo(Objects);
