import { useMemo } from "react";
import { boundsOf, unionBox, type Box, type Obj } from "@/pages/myspace/canvas/model";

interface Props {
  objs: Obj[];
  byId: Map<string, Obj>;
  view: { x: number; y: number; z: number };
  size: { w: number; h: number };
  onJump: (wx: number, wy: number) => void;
}

const W = 168;
const H = 112;

/** Мини-карта доски: видно, где находишься, клик переносит туда. */
export function Minimap({ objs, byId, view, size, onJump }: Props) {
  const data = useMemo(() => {
    const boxes = objs.filter((o) => !o.hidden && o.type !== "group").map((o) => boundsOf(o, byId));
    return { boxes, all: unionBox(boxes) };
  }, [objs, byId]);
  if (!data.all || data.boxes.length === 0) return null;

  const vp: Box = {
    x: -view.x / view.z,
    y: -view.y / view.z,
    w: size.w / view.z,
    h: size.h / view.z,
  };
  const world = unionBox([data.all, vp])!;
  const pad = Math.max(world.w, world.h) * 0.06;
  const wx = world.x - pad;
  const wy = world.y - pad;
  const ww = world.w + pad * 2;
  const wh = world.h + pad * 2;
  const k = Math.min(W / ww, H / wh);
  const ox = (W - ww * k) / 2;
  const oy = (H - wh * k) / 2;

  const jump = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.buttons !== 1 && e.type !== "pointerdown") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left - ox) / k + wx;
    const py = (e.clientY - r.top - oy) / k + wy;
    onJump(px, py);
  };

  return (
    <svg
      className="hc-minimap hc-float"
      data-ui
      width={W}
      height={H}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={jump}
    >
      {data.boxes.map((b, i) => (
        <rect
          key={i}
          x={ox + (b.x - wx) * k}
          y={oy + (b.y - wy) * k}
          width={Math.max(1.5, b.w * k)}
          height={Math.max(1.5, b.h * k)}
          fill="currentColor"
          opacity={0.45}
          rx={1}
        />
      ))}
      <rect
        x={ox + (vp.x - wx) * k}
        y={oy + (vp.y - wy) * k}
        width={vp.w * k}
        height={vp.h * k}
        fill="rgba(79,140,255,0.12)"
        stroke="#4f8cff"
        strokeWidth={1.5}
      />
    </svg>
  );
}
