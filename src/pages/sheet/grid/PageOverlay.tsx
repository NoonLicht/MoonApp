import { colIndex } from "@/pages/sheet/grid/geometry";
import type { Geo } from "@/pages/sheet/grid/geometry";

export interface PagePart {
  page: number;
  range: string;
}

/** «B2:H32» → строки и столбцы с нуля. */
function parse(range: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const c0 = colIndex(m[1]);
  const c1 = colIndex(m[3]);
  if (c0 === null || c1 === null) return null;
  return { r0: Number(m[2]) - 1, c0, r1: Number(m[4]) - 1, c1 };
}

/** Границы страниц печати поверх листа: синие рамки и номера страниц (разметка страницы и страничный режим). */
export default function PageOverlay({
  pages,
  geo,
  zoom,
  scroll,
  headerW,
  headerH,
  size,
  label,
}: {
  pages: PagePart[];
  geo: Geo;
  zoom: number;
  scroll: { x: number; y: number };
  headerW: number;
  headerH: number;
  size: { w: number; h: number };
  label: (n: number) => string;
}) {
  return (
    <svg style={{ position: "absolute", left: 0, top: 0, width: size.w, height: size.h, pointerEvents: "none", overflow: "hidden" }}>
      {pages.map((p) => {
        const r = parse(p.range);
        if (!r) return null;
        const b = geo.rect(r.r0, r.c0, r.r1, r.c1);
        const x = headerW + b.x * zoom - scroll.x;
        const y = headerH + b.y * zoom - scroll.y;
        const w = b.w * zoom;
        const h = b.h * zoom;
        return (
          <g key={p.page}>
            <rect x={x} y={y} width={w} height={h} fill="none" stroke="#2f6fed" strokeWidth={2} strokeDasharray="6 4" />
            <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(10, Math.min(44, w / 9))} fill="rgba(120,130,150,0.28)" fontFamily="sans-serif">
              {label(p.page)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
