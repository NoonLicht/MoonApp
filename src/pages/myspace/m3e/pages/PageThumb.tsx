import { memo, useMemo } from "react";
import {
  BEZEL,
  FRAME_LABEL_H,
  frameLengthOf,
  frameSizeOf,
  layoutOf,
  paletteOf,
  type Doc,
  type Kind,
  type Palette,
} from "@/pages/myspace/m3e/lib/tokens";
import type { StoredDoc } from "@/pages/myspace/m3e/pages/docUtil";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fill: string;
  stroke?: string;
  op?: number;
}

/** Чем закрашивается элемент на миниатюре: роль цвета по виду. */
function fillOf(kind: Kind, p: Palette): { fill: string; stroke?: string; op?: number } {
  switch (kind) {
    case "button":
    case "fab":
    case "extendedFab":
    case "splitButton":
    case "switch":
      return { fill: p.primary };
    case "iconButton":
    case "chip":
    case "fabMenu":
    case "toolbar":
      return { fill: p.secondaryContainer };
    case "topAppBar":
    case "bottomNav":
    case "navRail":
      return { fill: p.surfaceContainerHigh };
    case "text":
    case "divider":
      return { fill: p.onSurfaceVariant, op: 0.55 };
    case "image":
    case "camera":
    case "map":
      return { fill: p.primaryContainer };
    case "textField":
    case "select":
    case "searchBar":
      return { fill: p.surface, stroke: p.outline };
    case "linearProgress":
    case "circularProgress":
    case "loadingIndicator":
    case "slider":
      return { fill: p.primary, op: 0.8 };
    default:
      return { fill: p.surfaceContainerHighest };
  }
}

/** Схематичный предпросмотр страницы: рамки экранов и цветные блоки на месте элементов. */
function build(
  doc: Partial<Doc>,
): { vb: [number, number, number, number]; frames: Box[]; parts: Box[]; p: Palette } | null {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const groups = Array.isArray(doc.groups) ? doc.groups : [];
  const p = paletteOf(doc.paletteKey || "purple", doc.customPalette ?? null, doc.theme);
  const fb: Box[] = [];
  const pb: Box[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number, w: number, h: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  for (const f of frames) {
    const { w } = frameSizeOf(f);
    const h = frameLengthOf(f);
    fb.push({ x: f.x, y: f.y, w, h, r: 36, fill: p.surface, stroke: p.outlineVariant });
    grow(
      f.x - BEZEL,
      f.y - BEZEL - FRAME_LABEL_H * 0.4,
      w + BEZEL * 2,
      h + BEZEL * 2 + FRAME_LABEL_H * 0.4,
    );
  }
  try {
    for (const g of groups) {
      for (const pl of layoutOf(g, {})) {
        const c = fillOf(pl.item.kind, p);
        pb.push({
          x: pl.x,
          y: pl.y,
          w: pl.w,
          h: pl.h,
          r: Math.min(pl.h / 2, pl.item.kind === "text" ? 3 : 18),
          ...c,
        });
        grow(pl.x, pl.y, pl.w, pl.h);
      }
    }
  } catch {
    /* повреждённая группа: рамки экранов всё равно показываем */
  }
  if (!Number.isFinite(x0)) return null;
  const pad = 24;
  return {
    vb: [x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2],
    frames: fb,
    parts: pb,
    p,
  };
}

/** Миниатюра страницы. Размер задаёт родитель: SVG растягивается по ширине и высоте. */
function PageThumbInner({ doc, empty }: { doc: StoredDoc; empty: string }) {
  const shape = useMemo(() => (doc ? build(doc) : null), [doc]);
  if (!shape) {
    return (
      <div className="m3p-thumb-empty" aria-hidden>
        {empty}
      </div>
    );
  }
  const { vb, frames, parts, p } = shape;
  return (
    <svg
      className="m3p-thumb"
      viewBox={vb.join(" ")}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      role="img"
    >
      <rect x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]} fill={p.surfaceContainerLow} />
      {frames.map((f, i) => (
        <rect
          key={i}
          x={f.x}
          y={f.y}
          width={f.w}
          height={f.h}
          rx={f.r}
          fill={f.fill}
          stroke={f.stroke}
          strokeWidth={4}
        />
      ))}
      {parts.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={b.r}
          fill={b.fill}
          stroke={b.stroke}
          strokeWidth={b.stroke ? 3 : 0}
          opacity={b.op ?? 1}
        />
      ))}
    </svg>
  );
}

export const PageThumb = memo(PageThumbInner);
