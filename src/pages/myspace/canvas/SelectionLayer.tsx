import type { CSSProperties } from "react";
import {
  boundsOf,
  lineGeom,
  sidePoint,
  type Box,
  type Guide,
  type Obj,
  type Pt,
} from "@/pages/myspace/canvas/model";

const ACCENT = "#4f8cff";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: { id: HandleId; x: number; y: number; cursor: string }[] = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

const PORTABLE = new Set(["shape", "sticky", "text", "task", "note", "image", "sticker", "frame"]);

interface Props {
  objs: Obj[];
  byId: Map<string, Obj>;
  sel: string[];
  hover: string | null;
  z: number;
  guides: Guide[];
  marquee: Box | null;
  pen: Pt[] | null;
  penColor: string;
  penWidth: number;
  showPorts: boolean;
}

function Frame({
  box,
  rot,
  z,
  dashed,
  handles,
  rotate,
}: {
  box: Box;
  rot: number;
  z: number;
  dashed?: boolean;
  handles: boolean;
  rotate: boolean;
}) {
  const hs = 10 / z;
  const style: CSSProperties = {
    position: "absolute",
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    transform: rot ? `rotate(${rot}deg)` : undefined,
    transformOrigin: "50% 50%",
    outline: `${1.5 / z}px ${dashed ? "dashed" : "solid"} ${ACCENT}`,
    pointerEvents: "none",
  };
  return (
    <div style={style}>
      {handles &&
        HANDLES.map((h) => (
          <div
            key={h.id}
            data-handle={h.id}
            style={{
              position: "absolute",
              left: `${h.x * 100}%`,
              top: `${h.y * 100}%`,
              width: hs,
              height: hs,
              marginLeft: -hs / 2,
              marginTop: -hs / 2,
              background: "#fff",
              border: `${1.5 / z}px solid ${ACCENT}`,
              borderRadius: 2 / z,
              cursor: h.cursor,
              pointerEvents: "auto",
              boxSizing: "border-box",
            }}
          />
        ))}
      {rotate && (
        <>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: -26 / z,
              width: 1 / z,
              height: 26 / z,
              background: ACCENT,
              pointerEvents: "none",
            }}
          />
          <div
            data-handle="rot"
            title="Повернуть (Shift — шаг 15°)"
            style={{
              position: "absolute",
              left: "50%",
              top: -26 / z,
              width: 12 / z,
              height: 12 / z,
              marginLeft: -6 / z,
              marginTop: -12 / z,
              background: "#fff",
              border: `${1.5 / z}px solid ${ACCENT}`,
              borderRadius: "50%",
              cursor: "grab",
              pointerEvents: "auto",
              boxSizing: "border-box",
            }}
          />
        </>
      )}
    </div>
  );
}

/** Рамки выделения, ручки, порты соединителей, направляющие и рамка выбора. */
export function SelectionLayer(p: Props) {
  const { byId, sel, z } = p;
  const selected = sel.map((id) => byId.get(id)).filter((o): o is Obj => !!o);
  const single = selected.length === 1 ? selected[0] : null;
  const dot = 11 / z;

  const portsFor = (o: Obj) => {
    if (!PORTABLE.has(o.type)) return null;
    return (["t", "r", "b", "l"] as const).map((s) => {
      const e = sidePoint(o, s);
      const out = 14 / z;
      return (
        <div
          key={s}
          data-handle={`port-${s}`}
          data-port-of={o.id}
          title="Потяните, чтобы соединить"
          style={{
            position: "absolute",
            left: e.x + e.nx * out - dot / 2,
            top: e.y + e.ny * out - dot / 2,
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: "#fff",
            border: `${2 / z}px solid ${ACCENT}`,
            cursor: "crosshair",
            pointerEvents: "auto",
            boxSizing: "border-box",
          }}
        />
      );
    });
  };

  const hovered = p.hover && !sel.includes(p.hover) ? byId.get(p.hover) : undefined;

  return (
    <>
      {/* подсветка под курсором */}
      {hovered && hovered.type !== "line" && hovered.type !== "group" && (
        <div
          style={{
            position: "absolute",
            left: hovered.x,
            top: hovered.y,
            width: hovered.w,
            height: hovered.h,
            transform: hovered.rot ? `rotate(${hovered.rot}deg)` : undefined,
            outline: `${1.5 / z}px solid ${ACCENT}88`,
            pointerEvents: "none",
          }}
        />
      )}
      {p.showPorts && hovered && portsFor(hovered)}

      {/* выбранные объекты */}
      {selected.map((o) => {
        if (o.type === "line") {
          const g = lineGeom(o, byId);
          return (
            <svg
              key={o.id}
              width={1}
              height={1}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                overflow: "visible",
                pointerEvents: "none",
              }}
            >
              <path
                d={g.d}
                fill="none"
                stroke={ACCENT}
                strokeOpacity={0.45}
                strokeWidth={(o.sw ?? 2) + 6 / z}
              />
              {[
                { id: "la", e: g.a },
                { id: "lb", e: g.b },
              ].map((h) => (
                <circle
                  key={h.id}
                  data-handle={h.id}
                  cx={h.e.x}
                  cy={h.e.y}
                  r={6 / z}
                  fill="#fff"
                  stroke={ACCENT}
                  strokeWidth={2 / z}
                  style={{ pointerEvents: "all", cursor: "move" }}
                />
              ))}
            </svg>
          );
        }
        if (o.type === "group") {
          return <Frame key={o.id} box={o} rot={0} z={z} dashed handles={false} rotate={false} />;
        }
        if (selected.length > 1) {
          return <Frame key={o.id} box={o} rot={o.rot} z={z} handles={false} rotate={false} />;
        }
        return null;
      })}

      {single && single.type !== "line" && (
        <>
          <Frame
            box={single}
            rot={single.rot}
            z={z}
            dashed={single.type === "group"}
            handles={!single.locked}
            rotate={!single.locked && single.type !== "group"}
          />
          {p.showPorts && !single.locked && portsFor(single)}
          <SizeBadge o={single} z={z} />
        </>
      )}

      {selected.length > 1 &&
        (() => {
          const u = selected.reduce<Box | null>((acc, o) => {
            const b = boundsOf(o, byId);
            if (!acc) return b;
            const x = Math.min(acc.x, b.x);
            const y = Math.min(acc.y, b.y);
            return {
              x,
              y,
              w: Math.max(acc.x + acc.w, b.x + b.w) - x,
              h: Math.max(acc.y + acc.h, b.y + b.h) - y,
            };
          }, null);
          if (!u) return null;
          return (
            <>
              <Frame box={u} rot={0} z={z} handles rotate />
              <SizeBadge o={{ ...u, rot: 0 } as Obj} z={z} />
            </>
          );
        })()}

      {/* направляющие привязки */}
      {p.guides.map((g, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: g.axis === "x" ? g.at : g.from,
            top: g.axis === "x" ? g.from : g.at,
            width: g.axis === "x" ? 1 / z : g.to - g.from,
            height: g.axis === "x" ? g.to - g.from : 1 / z,
            background: "#ff4fa3",
            pointerEvents: "none",
          }}
        />
      ))}

      {p.marquee && (
        <div
          style={{
            position: "absolute",
            left: p.marquee.x,
            top: p.marquee.y,
            width: p.marquee.w,
            height: p.marquee.h,
            background: `${ACCENT}1f`,
            border: `${1 / z}px solid ${ACCENT}`,
            pointerEvents: "none",
          }}
        />
      )}

      {p.pen && p.pen.length > 1 && (
        <svg
          width={1}
          height={1}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: "none",
          }}
        >
          <path
            d={p.pen.map((q, i) => `${i ? "L" : "M"}${q.x} ${q.y}`).join("")}
            fill="none"
            stroke={p.penColor}
            strokeWidth={p.penWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={0.9}
          />
        </svg>
      )}
    </>
  );
}

function SizeBadge({ o, z }: { o: Obj; z: number }) {
  if (o.type === "line") return null;
  return (
    <div
      style={{
        position: "absolute",
        left: o.x + o.w / 2,
        top: o.y + o.h + 18 / z,
        transform: `translateX(-50%) scale(${1 / z})`,
        transformOrigin: "50% 0",
        background: ACCENT,
        color: "#fff",
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      {Math.round(o.w)} × {Math.round(o.h)}
    </div>
  );
}
